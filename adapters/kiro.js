// Kiro CLI adapter.
//
// Reads Kiro session data from `~/.kiro/sessions/cli/`.
// Each session produces:
//   - `{uuid}.json`  — metadata + per-turn summary. Kiro DOES carry
//                      `input_token_count` / `output_token_count` fields here
//                      but they are always 0 in observed data, so we
//                      tokenize locally.
//   - `{uuid}.jsonl` — message log with kinds: Prompt, AssistantMessage,
//                      ToolResults. Content entries are `text`, `toolUse`,
//                      `toolResult`.
//
// Only `Prompt` messages carry `meta.timestamp` (unix seconds). Assistant and
// ToolResults inherit the most recent timestamp — this is acceptable because
// a turn's messages are logically co-located in the same hour bucket.
//
// Token accounting models LLM billing, not conversation size. Each
// AssistantMessage event corresponds to one LLM API call; its inputTokens
// is the running size of the conversation context up to (but not including)
// that message, which is what the LLM actually receives and bills for.
// Text, tool-call args, and tool results all grow the running context. User
// Prompt records carry humanInputTokens (what the user typed) but contribute
// inputTokens = 0 so they don't double-count the context charged to the
// subsequent assistant call.
//
// Kiro doesn't persist real token counts, so all records are marked
// `estimated: true`.

const fs = require('fs');
const path = require('path');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSON, readJSONL, listDir, makeRecord } = require('../lib/util');

const KIRO_DIR = path.join(process.env.HOME, '.kiro/sessions/cli');
const TOOL_NAME = 'kiro';

// Hard ceiling on per-call input tokens. Kiro (via Bedrock/Claude) has a
// model context window; once running context would exceed this, real
// deployments compact/summarize history so that the LLM never actually
// receives more. Since we don't see summarization boundaries, we cap each
// call's inputTokens at the largest reasonable Claude context size. This
// turns cumulative conversation size into a defensible upper-bound estimate
// of billable input per call rather than letting runningCtx grow
// unboundedly across very long sessions.
const MAX_CONTEXT_TOKENS = 200_000;

// Map Kiro shorthand model names to canonical Claude model ids that match
// OpenRouter pricing short-name aliases. Kiro's selector shows:
//   "Auto" → "auto"          — no fixed model, pricing N/A
//   "Opus" → "opus"          — canonical claude-opus-latest pricing
//   "Sonnet" → "sonnet"      — canonical claude-sonnet-latest pricing
//   "Haiku" → "haiku"        — canonical claude-haiku-latest pricing
//   specific picks like "claude-sonnet-4.5" pass through unchanged.
function normalizeKiroModel(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === 'opus') return 'claude-opus-latest';
  if (v === 'sonnet') return 'claude-sonnet-latest';
  if (v === 'haiku') return 'claude-haiku-latest';
  return raw;
}

function isAvailable() {
  return fs.existsSync(KIRO_DIR);
}

function collectText(content) {
  const parts = [];
  for (const c of content || []) {
    if (c.kind === 'text' && typeof c.data === 'string') parts.push(c.data);
  }
  return parts.join('\n');
}

function extractToolCalls(content) {
  const calls = [];
  for (const c of content || []) {
    if (c.kind === 'toolUse' && c.data) {
      calls.push({
        id: c.data.toolUseId,
        tool: c.data.name || 'unknown',
        input: c.data.input || {},
      });
    }
  }
  return calls;
}

function extractToolResults(content) {
  const results = [];
  for (const c of content || []) {
    if (c.kind === 'toolResult' && c.data) {
      const out = [];
      for (const item of c.data.content || []) {
        if (item.kind === 'text' && typeof item.data === 'string') out.push(item.data);
        else if (item.data !== undefined) out.push(safeStringify(item.data));
      }
      results.push({
        id: c.data.toolUseId,
        status: c.data.status || 'success',
        output: out.join('\n'),
      });
    }
  }
  return results;
}

function loadSession(jsonPath, jsonlPath) {
  const meta = readJSON(jsonPath);
  if (!meta) return null;
  const events = readJSONL(jsonlPath);
  return { meta, events };
}

function listSessions() {
  const entries = listDir(KIRO_DIR);
  const sessions = [];
  const seen = new Set();
  for (const entry of entries) {
    const m = entry.match(/^([0-9a-f-]{36})\.(json|jsonl)$/i);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const jsonPath = path.join(KIRO_DIR, `${id}.json`);
    const jsonlPath = path.join(KIRO_DIR, `${id}.jsonl`);
    if (fs.existsSync(jsonPath) && fs.existsSync(jsonlPath)) {
      sessions.push({ id, jsonPath, jsonlPath });
    }
  }
  return sessions;
}

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const sessionRefs = listSessions();
  if (sessionRefs.length === 0) return [];

  // Pass 1: parse sessions, build tokenization work, keep enough structure
  // to walk events in order for the billing-cost walk.
  const sessionsData = [];
  const workItems = [];

  for (const { id, jsonPath, jsonlPath } of sessionRefs) {
    const loaded = loadSession(jsonPath, jsonlPath);
    if (!loaded) continue;
    const { meta, events } = loaded;

    const updatedAt = Date.parse(meta.updated_at || meta.created_at || 0) || 0;
    if (updatedAt < cutoff) continue;

    const createdAt = Date.parse(meta.created_at || meta.updated_at || 0) || updatedAt;
    // Kiro stores the selected model on the session. It may be a real
    // Claude identifier like `claude-sonnet-4.5` (→ pricing via short-name
    // alias), a shorthand like `opus` / `sonnet` / `haiku` (→ we coerce
    // to the canonical Claude id), or `auto` (no fixed model — pricing
    // will correctly fall through to null).
    const rawModelId = meta.session_state?.rts_model_state?.model_info?.model_id || null;
    const model = normalizeKiroModel(rawModelId) || 'kiro-default';
    const sessionMeta = {
      id,
      title: meta.title || null,
      directory: meta.cwd || null,
      created: createdAt,
      updated: updatedAt,
      model,
    };

    // Walk events once to gather tokenization work and a step list we can
    // walk again in pass 2 to build records. Each step is a lightweight
    // descriptor that references ids into tokenMap — no raw text is kept
    // here beyond what's needed for tool args / timestamps.
    const steps = [];
    let lastTs = createdAt;
    let assistantCounter = 0;
    let promptCounter = 0;
    let toolResultCounter = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const kind = ev.kind;
      const data = ev.data || {};
      const metaTs = data.meta?.timestamp;
      if (typeof metaTs === 'number') lastTs = metaTs * 1000;

      if (kind === 'Prompt') {
        const text = collectText(data.content);
        if (!text) continue;
        const stepId = `p${promptCounter++}`;
        const tokKey = `kiro-prompt:${id}:${stepId}`;
        workItems.push({ id: tokKey, texts: [text] });
        steps.push({
          kind: 'prompt',
          ts: lastTs,
          msgId: `kiro:${id}:${data.message_id || stepId}`,
          textKey: tokKey,
        });
      } else if (kind === 'AssistantMessage') {
        const text = collectText(data.content);
        const toolCalls = extractToolCalls(data.content);
        const stepId = `a${assistantCounter++}`;
        const msgId = `kiro:${id}:${data.message_id || stepId}`;
        const textKey = text ? `kiro-text:${id}:${stepId}` : null;
        if (textKey) workItems.push({ id: textKey, texts: [text] });
        const toolKeys = [];
        for (let j = 0; j < toolCalls.length; j++) {
          const tc = toolCalls[j];
          const argKey = `kiro-toolin:${id}:${stepId}:${j}`;
          workItems.push({ id: argKey, texts: [safeStringify(tc.input)] });
          toolKeys.push({ tc, argKey });
        }
        steps.push({
          kind: 'assistant',
          ts: lastTs,
          msgId,
          textKey,
          toolKeys,
        });
      } else if (kind === 'ToolResults') {
        const results = extractToolResults(data.content);
        const stepId = `tr${toolResultCounter++}`;
        const entries = [];
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          const outKey = `kiro-toolout:${id}:${stepId}:${j}`;
          workItems.push({ id: outKey, texts: [r.output] });
          entries.push({
            toolUseId: r.id,
            status: r.status,
            outKey,
          });
        }
        steps.push({
          kind: 'toolresults',
          ts: lastTs,
          entries,
        });
      }
    }

    if (steps.length) sessionsData.push({ sessionMeta, steps });
  }

  if (sessionsData.length === 0) return [];

  console.error(`[kiro] ${sessionsData.length} sessions, tokenizing ${workItems.length} items...`);

  const tokenMap = tokenizeAll(workItems);

  // Pass 2: walk each session's steps, maintain running cumulative context
  // size, and emit records.
  //
  // Model of billing:
  //   - Prompt → adds user text to context. Emits user record with
  //     humanInputTokens = prompt text, inputTokens = 0.
  //   - AssistantMessage → one LLM API call. inputTokens = running context
  //     at the point of the call (before this message). outputTokens =
  //     this message's text only. Tool-call args go on tools[] (reported
  //     separately as tool_input_tokens). Running context then grows by
  //     text + tool-call arg text.
  //   - ToolResults → grows context by tool output. Also back-fills the
  //     preceding assistant's tools[] outputTokens so per-tool bandwidth
  //     stats are accurate.
  const records = [];
  for (const { sessionMeta, steps } of sessionsData) {
    let runningCtx = 0;
    // Map toolUseId -> { assistantRecord, toolEntry, toolEventIdx } so we
    // can back-fill tool outputs when a ToolResults step arrives later.
    const pendingTools = new Map();

    const sessionTitle = useRealSessionName
      ? (sessionMeta.title || sessionMeta.id.slice(0, 8))
      : sessionMeta.id.slice(0, 8);

    for (const step of steps) {
      if (step.kind === 'prompt') {
        const tok = tokenMap.get(step.textKey) || 0;
        if (tok > 0) {
          records.push(makeRecord({
            tool: TOOL_NAME,
            sessionId: sessionMeta.id,
            sessionTitle,
            directory: sessionMeta.directory,
            created: step.ts,
            completed: step.ts,
            role: 'user',
            agent: null,
            provider: 'aws-bedrock',
            model: sessionMeta.model,
            inputTokens: 0,              // running-ctx input attributed to the LLM call
            outputTokens: 0,
            humanInputTokens: tok,        // what the user actually typed
            estimated: true,
            tools: [],
            toolEvents: [],
          }));
          runningCtx += tok;
        }
      } else if (step.kind === 'assistant') {
        const textTok = step.textKey ? (tokenMap.get(step.textKey) || 0) : 0;
        const tools = [];
        const toolEvents = [];
        let toolArgsTotal = 0;
        for (let j = 0; j < step.toolKeys.length; j++) {
          const { tc, argKey } = step.toolKeys[j];
          const inputTokens = tokenMap.get(argKey) || 0;
          toolArgsTotal += inputTokens;
          const toolEntry = { tool: tc.tool, inputTokens, outputTokens: 0 };
          tools.push(toolEntry);
          const toolEvent = {
            tool: tc.tool,
            tokens: inputTokens,
            start: step.ts,
            end: step.ts,
            args: tc.input,
            error: false,
            depth: 0,
          };
          toolEvents.push(toolEvent);
          if (tc.id) {
            pendingTools.set(tc.id, { toolEntry, toolEvent });
          }
        }

        // One LLM API call: input = all context so far (capped at the
        // model's context window), output = everything the model generated
        // on this call — text PLUS tool-call args. Anthropic/Bedrock bills
        // tool_use blocks as output, so we include them in outputTokens.
        // tools[].inputTokens still carries the per-tool arg size for the
        // tool-bandwidth rollup, which is a side metric (not part of the
        // billable input+output total).
        const record = makeRecord({
          tool: TOOL_NAME,
          sessionId: sessionMeta.id,
          sessionTitle,
          directory: sessionMeta.directory,
          created: step.ts,
          completed: step.ts,
          role: 'assistant',
          agent: null,
          provider: 'aws-bedrock',
          model: sessionMeta.model,
          inputTokens: Math.min(runningCtx, MAX_CONTEXT_TOKENS),
          outputTokens: textTok + toolArgsTotal,
          humanInputTokens: 0,
          estimated: true,
          tools,
          toolEvents,
        });
        records.push(record);

        // Context grows by the model's output (text + tool-call args) since
        // those are included verbatim in the next LLM call's prompt.
        runningCtx += textTok + toolArgsTotal;
      } else if (step.kind === 'toolresults') {
        let resultsTotal = 0;
        for (const entry of step.entries) {
          const outTok = tokenMap.get(entry.outKey) || 0;
          resultsTotal += outTok;
          const pending = entry.toolUseId ? pendingTools.get(entry.toolUseId) : null;
          if (pending) {
            pending.toolEntry.outputTokens = outTok;
            pending.toolEvent.tokens += outTok;
            pending.toolEvent.end = step.ts;
            pending.toolEvent.error = entry.status !== 'success';
            pendingTools.delete(entry.toolUseId);
          }
        }
        runningCtx += resultsTotal;
      }
    }
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
