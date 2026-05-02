// Codex CLI adapter.
//
// Reads Codex CLI session data from
// `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
// Each file is a newline-delimited JSON log for one session rollout.
//
// Line types processed:
//   session_meta       — first line, captures session id, cwd, provider, model
//   response_item      — messages (user/assistant) and tool calls/results
//   turn_completed     — carries token usage for the preceding assistant turn
//   event_msg          — current Codex writes token_count usage here
//
// Types ignored: turn_started, item.started, item.completed.
//
// Assistant records don't carry token counts inline; the subsequent
// `turn_completed` event, or current `event_msg` token_count event, carries
// usage — that is applied to the most recent assistant message in the same
// turn. User messages are tokenized into humanInputTokens only; assistant
// messages without matching usage fall back to local output estimation.

const fs = require('fs');
const path = require('path');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSONL, listDir, homeCandidates, makeRecord } = require('../lib/util');

const TOOL_NAME = 'codex';
const TOOL_CLI = 'codex-cli';
const TOOL_APP = 'codex-app';

function isAvailable() {
  return candidateSessionDirs().some(dir => fs.existsSync(dir));
}

function candidateCodexHomes() {
  const homes = [];
  if (process.env.CODEX_HOME) homes.push(process.env.CODEX_HOME);
  for (const home of homeCandidates()) homes.push(path.join(home, '.codex'));
  return [...new Set(homes)];
}

function candidateSessionDirs() {
  return candidateCodexHomes().map(home => path.join(home, 'sessions'));
}

// Walk YYYY/MM/DD subdirs under ~/.codex/sessions/ and return objects with
// { filePath, mtime } for every rollout-*.jsonl found.
function listSessionFiles() {
  const files = [];
  const seen = new Set();
  for (const sessionsDir of candidateSessionDirs()) {
    for (const year of listDir(sessionsDir)) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = path.join(sessionsDir, year);
      for (const month of listDir(yearDir)) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthDir = path.join(yearDir, month);
        for (const day of listDir(monthDir)) {
          if (!/^\d{2}$/.test(day)) continue;
          const dayDir = path.join(monthDir, day);
          for (const file of listDir(dayDir)) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            const filePath = path.join(dayDir, file);
            if (seen.has(filePath)) continue;
            seen.add(filePath);
            try {
              const stat = fs.statSync(filePath);
              files.push({ filePath, mtime: stat.mtimeMs });
            } catch {}
          }
        }
      }
    }
  }
  return files;
}

// Extract plain text from a response_item message content array.
// Handles `input_text`, `text`, and `output_text` content types.
function extractMessageText(content) {
  const parts = [];
  for (const c of content || []) {
    if (typeof c.text === 'string' && c.text) parts.push(c.text);
  }
  return parts.join('\n');
}

function normaliseUsage(usage) {
  const totalInput = usage.input_tokens || 0;
  const cacheReadTokens = usage.cached_input_tokens || 0;
  return {
    inputTokens: Math.max(0, totalInput - cacheReadTokens),
    cacheReadTokens,
    outputTokens: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0),
  };
}

function parseJSONMaybe(value, fallback = {}) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function callName(payload) {
  if (payload.type === 'web_search_call') return 'web_search';
  if (payload.type === 'tool_search_call') return 'tool_search';
  return payload.name || payload.type || 'unknown';
}

function callArgs(payload) {
  if (payload.type === 'function_call') return parseJSONMaybe(payload.arguments, {});
  if (payload.type === 'custom_tool_call') return { input: payload.input || '' };
  if (payload.type === 'web_search_call') return payload.action || {};
  if (payload.type === 'tool_search_call') return payload.arguments || {};
  return {};
}

function outputText(payload) {
  if (typeof payload.output === 'string') return payload.output;
  return safeStringify(payload.output ?? payload.tools ?? payload.result ?? payload);
}

function codexToolName(meta) {
  if (meta.originator === 'Codex Desktop') return TOOL_APP;
  return TOOL_CLI;
}

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const sessionFiles = listSessionFiles().filter(f => f.mtime >= cutoff);
  if (sessionFiles.length === 0) return [];

  // Pass 1: parse files, build raw message descriptors + tokenization work items.
  //
  // rawMessages holds lightweight objects referencing session metadata so that
  // pass 2 can build records without re-reading files.
  //
  // toolCallData is keyed by a composite `${sessionId}:${callId}` so that
  // identically named call_ids from different sessions don't collide.

  const rawMessages = [];
  const workItems = [];
  const toolCallData = new Map();  // compositeCallId -> { tool, args, argText, outputText, callTs, outputTs }

  let sessionCount = 0;

  for (const { filePath, mtime } of sessionFiles) {
    const lines = readJSONL(filePath);
    if (lines.length === 0) continue;

    // First line must be session_meta.
    const firstLine = lines[0];
    if (!firstLine || firstLine.type !== 'session_meta') continue;

    const metaPayload = firstLine.payload || {};
    const meta = metaPayload.meta || metaPayload;
    const sessionId = meta.id || path.basename(filePath, '.jsonl').replace(/^rollout-[0-9T:-]+-?/, '');
    const provider = meta.model_provider || 'openai';
    const model = meta.model || 'unknown';
    const directory = meta.cwd || null;
    const sessionCreated = Date.parse(firstLine.timestamp) || mtime;
    const toolName = codexToolName(meta);

    // Mutable per-session metadata bag shared by all raw message refs.
    const sessionMeta = {
      id: sessionId,
      toolName,
      provider,
      model,
      directory,
      created: sessionCreated,
      firstUserText: null,  // lazily populated from first user message
    };

    sessionCount++;

    // Per-turn tracking.  A turn starts at a user message and ends at the
    // next usage event.
    let turnAssistantMsgs = [];   // raw message objects (assistant) in current turn
    let turnCompositeCallIds = []; // composite call IDs for tool calls in current turn

    const applyUsageToTurn = (usage, ts) => {
      if (!usage || Object.keys(usage).length === 0) return;

      if (turnAssistantMsgs.length > 0) {
        const lastAsst = turnAssistantMsgs[turnAssistantMsgs.length - 1];
        lastAsst.usageOverride = normaliseUsage(usage);
        // Append rather than replace — some rollouts emit usage twice
        // (failure + retry) without an intervening user message.
        lastAsst.toolCallIds = [...lastAsst.toolCallIds, ...turnCompositeCallIds];
      } else if (turnCompositeCallIds.length > 0) {
        // Turn had tool calls but no surfaced assistant text message (e.g.
        // tool-only turn). Synthesize a minimal assistant record so the
        // activity and tokens are preserved in the report.
        const synthId = `codex:${sessionCount}:synth:${rawMessages.length}`;
        rawMessages.push({
          msgId: synthId,
          sessionId,
          sessionMeta,
          ts,
          role: 'assistant',
          usageOverride: normaliseUsage(usage),
          toolCallIds: [...turnCompositeCallIds],
        });
      }

      turnAssistantMsgs = [];
      turnCompositeCallIds = [];
    };

    for (let i = 1; i < lines.length; i++) {
      const ev = lines[i];
      if (!ev) continue;
      const evType = ev.type;
      const ts = Date.parse(ev.timestamp) || sessionCreated;
      const payload = ev.payload || {};

      if (evType === 'response_item') {
        const itemType = payload.type;

        if (itemType === 'message') {
          const role = payload.role;
          if (role !== 'user' && role !== 'assistant') continue;

          const text = extractMessageText(payload.content);

          // Capture first user message text for session title.
          if (role === 'user' && !sessionMeta.firstUserText && text) {
            sessionMeta.firstUserText = text.slice(0, 60);
          }

          // A user message marks the start of a new turn.
          if (role === 'user') {
            turnAssistantMsgs = [];
            turnCompositeCallIds = [];
          }

          const msgId = `codex:${sessionId}:${i}`;
          const record = {
            msgId,
            sessionId,
            sessionMeta,
            ts,
            role,
            usageOverride: null,      // filled by turn usage events
            toolCallIds: [],           // composite call IDs, filled by turn usage events
          };
          rawMessages.push(record);

          if (role === 'assistant') {
            turnAssistantMsgs.push(record);
          }

          if (text) {
            workItems.push({ id: `codex-text:${msgId}`, texts: [text] });
          }

        } else if (['function_call', 'custom_tool_call', 'web_search_call', 'tool_search_call'].includes(itemType)) {
          const callId = payload.call_id || `call-${sessionId}-${i}`;
          const compositeId = `${sessionId}:${callId}`;
          const toolName = callName(payload);
          const args = callArgs(payload);
          const argText = safeStringify(args);
          toolCallData.set(compositeId, {
            tool: toolName,
            args,
            argText,
            outputText: '',
            callTs: ts,
            outputTs: ts,
          });
          turnCompositeCallIds.push(compositeId);
          workItems.push({ id: `codex-toolin:${compositeId}`, texts: [argText] });

        } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(itemType)) {
          const callId = payload.call_id || '';
          const compositeId = `${sessionId}:${callId}`;
          const outText = outputText(payload);
          const entry = toolCallData.get(compositeId);
          if (entry) {
            entry.outputText = outText;
            entry.outputTs = ts;
            workItems.push({ id: `codex-toolout:${compositeId}`, texts: [outText] });
          }
        }

      } else if (evType === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model) {
          sessionMeta.model = payload.model;
        }
      } else if (evType === 'turn_completed') {
        // Codex writes usage at the top level of turn_completed events in
        // current rollout schema. A defensive fallback to payload.usage
        // handles potential schema variations without a breaking change.
        //
        // Codex/OpenAI usage reports cached_input_tokens as a subset of
        // input_tokens. Store only fresh input in inputTokens and keep cached
        // reads separate so report totals do not double-count prompt cache.
        const usage = ev.usage || payload.usage || {};
        applyUsageToTurn(usage, ts);
      } else if (evType === 'event_msg' && payload.type === 'token_count') {
        const usage = payload.info?.last_token_usage || null;
        applyUsageToTurn(usage, ts);
      }
    }
  }

  console.error(`[codex] ${rawMessages.length} messages across ${sessionCount} session files, tokenizing ${workItems.length} items...`);

  const tokenMap = tokenizeAll(workItems);

  // Pass 2: build records from raw message descriptors.
  const records = [];
  for (const msg of rawMessages) {
    const { msgId, sessionId, sessionMeta: sm, ts, role, usageOverride, toolCallIds } = msg;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let humanInputTokens = 0;
    let estimated = false;

    const textTokens = tokenMap.get(`codex-text:${msgId}`) || 0;

    if (role === 'user') {
      humanInputTokens = textTokens;
      estimated = true;
    } else if (role === 'assistant') {
      if (usageOverride) {
        inputTokens = usageOverride.inputTokens;
        outputTokens = usageOverride.outputTokens;
        cacheReadTokens = usageOverride.cacheReadTokens || 0;
        estimated = false;
      } else {
        outputTokens = textTokens;
        estimated = true;
      }
    }

    // Build tools and toolEvents from the tool calls attached to this record.
    const tools = [];
    const toolEvents = [];
    for (const compositeId of toolCallIds || []) {
      const tc = toolCallData.get(compositeId);
      if (!tc) continue;
      const inputToks = tokenMap.get(`codex-toolin:${compositeId}`) || 0;
      const outputToks = tokenMap.get(`codex-toolout:${compositeId}`) || 0;
      tools.push({ tool: tc.tool, inputTokens: inputToks, outputTokens: outputToks });
      toolEvents.push({
        tool: tc.tool,
        tokens: inputToks + outputToks,
        start: tc.callTs,
        end: tc.outputTs,
        args: tc.args,
        error: false,
        depth: 0,
      });
    }

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && humanInputTokens === 0 && tools.length === 0) continue;

    records.push(makeRecord({
      tool: sm.toolName || TOOL_CLI,
      sessionId,
      sessionTitle: useRealSessionName
        ? (sm.firstUserText || sessionId.slice(0, 8))
        : sessionId.slice(0, 8),
      directory: sm.directory,
      created: ts,
      completed: ts,
      role,
      agent: null,
      provider: sm.provider,
      model: sm.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      // Codex/OpenAI usage doesn't surface a "cache creation" bucket — only
      // cached_input_tokens (reads). Cache writes, if they occur, are billed
      // as fresh input_tokens in the same response, so there's no separate
      // cacheCreation field here.
      cacheCreationTokens: 0,
      humanInputTokens,
      estimated,
      tools,
      toolEvents,
    }));
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
