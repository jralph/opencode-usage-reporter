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
//
// Types ignored: event_msg, turn_started, item.started, item.completed.
//
// Assistant records don't carry token counts inline; the subsequent
// `turn_completed` event carries usage — that is applied to the most recent
// assistant message in the same turn.  All user messages and assistant messages
// without a matching turn_completed are tokenized locally and marked
// `estimated: true`.

const fs = require('fs');
const path = require('path');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSONL, listDir, makeRecord } = require('../lib/util');

const CODEX_DIR = path.join(process.env.HOME, '.codex/sessions');
const TOOL_NAME = 'codex';

function isAvailable() {
  return fs.existsSync(CODEX_DIR);
}

// Walk YYYY/MM/DD subdirs under ~/.codex/sessions/ and return objects with
// { filePath, mtime } for every rollout-*.jsonl found.
function listSessionFiles() {
  const files = [];
  for (const year of listDir(CODEX_DIR)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = path.join(CODEX_DIR, year);
    for (const month of listDir(yearDir)) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthDir = path.join(yearDir, month);
      for (const day of listDir(monthDir)) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayDir = path.join(monthDir, day);
        for (const file of listDir(dayDir)) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, file);
          try {
            const stat = fs.statSync(filePath);
            files.push({ filePath, mtime: stat.mtimeMs });
          } catch {}
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

    const meta = firstLine.payload?.meta || {};
    const sessionId = meta.id || path.basename(filePath, '.jsonl').replace(/^rollout-[0-9T:-]+-?/, '');
    const provider = meta.model_provider || 'openai';
    const model = meta.model || 'unknown';
    const directory = meta.cwd || null;
    const sessionCreated = Date.parse(firstLine.timestamp) || mtime;

    // Mutable per-session metadata bag shared by all raw message refs.
    const sessionMeta = {
      id: sessionId,
      provider,
      model,
      directory,
      created: sessionCreated,
      firstUserText: null,  // lazily populated from first user message
    };

    sessionCount++;

    // Per-turn tracking.  A turn starts at a user message and ends at the
    // next turn_completed event.
    let turnAssistantMsgs = [];   // raw message objects (assistant) in current turn
    let turnCompositeCallIds = []; // composite call IDs for tool calls in current turn

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
            usageOverride: null,      // filled by turn_completed
            toolCallIds: [],           // composite call IDs, filled by turn_completed
          };
          rawMessages.push(record);

          if (role === 'assistant') {
            turnAssistantMsgs.push(record);
          }

          if (text) {
            workItems.push({ id: `codex-text:${msgId}`, texts: [text] });
          }

        } else if (itemType === 'function_call') {
          const callId = payload.call_id || `call-${sessionId}-${i}`;
          const compositeId = `${sessionId}:${callId}`;
          const toolName = payload.name || 'unknown';
          let args = {};
          try { args = JSON.parse(payload.arguments || '{}'); } catch {}
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

        } else if (itemType === 'function_call_output') {
          const callId = payload.call_id || '';
          const compositeId = `${sessionId}:${callId}`;
          const outputText = typeof payload.output === 'string'
            ? payload.output
            : safeStringify(payload.output);
          const entry = toolCallData.get(compositeId);
          if (entry) {
            entry.outputText = outputText;
            entry.outputTs = ts;
            workItems.push({ id: `codex-toolout:${compositeId}`, texts: [outputText] });
          }
        }

      } else if (evType === 'turn_completed') {
        // Codex writes usage at the top level of turn_completed events in
        // current rollout schema. A defensive fallback to payload.usage
        // handles potential schema variations without a breaking change.
        //
        // OpenAI's usage reports `input_tokens` as fresh (uncached) input
        // and `cached_input_tokens` as the portion served from prompt cache
        // (discounted billing). We keep them separate so cost math can
        // weight each bucket correctly.
        const usage = ev.usage || payload.usage || {};
        if (turnAssistantMsgs.length > 0) {
          const lastAsst = turnAssistantMsgs[turnAssistantMsgs.length - 1];
          lastAsst.usageOverride = {
            inputTokens: usage.input_tokens || 0,
            cacheReadTokens: usage.cached_input_tokens || 0,
            outputTokens: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0),
          };
          // Append rather than replace — some rollouts emit turn_completed
          // twice (failure + retry) without an intervening user message.
          lastAsst.toolCallIds = [...lastAsst.toolCallIds, ...turnCompositeCallIds];
        } else if (turnCompositeCallIds.length > 0) {
          // Turn had tool calls but no surfaced assistant text message (e.g.
          // tool-only turn). Synthesize a minimal assistant record so the
          // activity and tokens are preserved in the report.
          const synthId = `codex:${sessionCount}:synth:${i}`;
          rawMessages.push({
            msgId: synthId,
            sessionId: rawMessages.length && rawMessages[rawMessages.length - 1].sessionId,
            sessionMeta: rawMessages.length && rawMessages[rawMessages.length - 1].sessionMeta,
            ts,
            role: 'assistant',
            usageOverride: {
              inputTokens: usage.input_tokens || 0,
              cacheReadTokens: usage.cached_input_tokens || 0,
              outputTokens: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0),
            },
            toolCallIds: [...turnCompositeCallIds],
          });
        }
        // Reset turn.
        turnAssistantMsgs = [];
        turnCompositeCallIds = [];
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
    let estimated = false;

    const textTokens = tokenMap.get(`codex-text:${msgId}`) || 0;

    if (role === 'user') {
      inputTokens = textTokens;
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

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && tools.length === 0) continue;

    records.push(makeRecord({
      tool: TOOL_NAME,
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
      humanInputTokens: role === 'user' ? inputTokens : 0,
      estimated,
      tools,
      toolEvents,
    }));
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
