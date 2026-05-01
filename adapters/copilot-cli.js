// GitHub Copilot CLI adapter.
//
// Supports both storage formats produced by `~/.copilot/`:
//
// 1. Legacy (pre-v0.0.342): `~/.copilot/history-session-state/session_{uuid}_{ts}.json`
//    - Each file is a complete session snapshot.
//    - Fields: { sessionId, startTime, chatMessages[], timeline[] }.
//    - chatMessages[] is the raw content (role: user|assistant|tool, content, tool_calls, tool_call_id).
//    - timeline[] carries per-event timestamps and tool call args/results.
//    - NO token counts are persisted — everything is tokenized locally and
//      records are marked `estimated: true`.
//
// 2. New (v0.0.342+, early 2026): `~/.copilot/session-state/{sessionId}/events.jsonl`
//    - Event stream. Notable event types:
//        user.message               — user prompt
//        assistant.usage            — per-API-call with real input/output tokens
//        tool.execution_start/end   — tool invocations
//        session.shutdown           — session totals with modelMetrics
//    - Real token counts come from `assistant.usage.data.usage` and are NOT estimated.
//
// Model is read from `~/.copilot/config.json` as a fallback when the session
// doesn't record it (legacy sessions). In practice Copilot CLI records a single
// model per session.

const fs = require('fs');
const path = require('path');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSON, readJSONL, listDir, makeRecord } = require('../lib/util');

const COPILOT_DIR = path.join(process.env.HOME, '.copilot');
const LEGACY_DIR = path.join(COPILOT_DIR, 'history-session-state');
const NEW_DIR = path.join(COPILOT_DIR, 'session-state');
const CONFIG_PATH = path.join(COPILOT_DIR, 'config.json');
const TOOL_NAME = 'copilot-cli';

function isAvailable() {
  return fs.existsSync(LEGACY_DIR) || fs.existsSync(NEW_DIR);
}

function readDefaultModel() {
  const cfg = readJSON(CONFIG_PATH);
  return cfg?.model || 'unknown';
}

// --- Legacy format ---

function listLegacySessionFiles(cutoff) {
  const files = [];
  for (const name of listDir(LEGACY_DIR)) {
    if (!name.startsWith('session_') || !name.endsWith('.json')) continue;
    const fp = path.join(LEGACY_DIR, name);
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) continue;
      files.push(fp);
    } catch {}
  }
  return files;
}

// Parse a legacy session into raw message descriptors + tokenize work items.
// We prefer timeline entries for timestamps + tool call detail; chatMessages
// supplies tool_calls on assistant messages (with tool_call_id linkage).
function parseLegacySession(filePath, defaultModel, workItems, rawMessages, toolDataMap) {
  const j = readJSON(filePath);
  if (!j || !j.sessionId) return;

  const sessionId = j.sessionId;
  const sessionStart = Date.parse(j.startTime) || 0;
  const chatMessages = Array.isArray(j.chatMessages) ? j.chatMessages : [];
  const timeline = Array.isArray(j.timeline) ? j.timeline : [];

  // Build a map: tool_call_id -> tool output text from chatMessages (role='tool').
  const toolOutputById = new Map();
  for (const m of chatMessages) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolOutputById.set(m.tool_call_id, typeof m.content === 'string' ? m.content : safeStringify(m.content));
    }
  }

  // Walk timeline: user/copilot text + tool_call_completed tool events.
  // Each user event becomes a user record, each copilot event an assistant record.
  // Tool events attach to the most recent assistant record in the session.
  let lastAssistant = null;

  for (const ev of timeline) {
    const ts = Date.parse(ev.timestamp) || sessionStart;

    if (ev.type === 'user') {
      const msgId = `cp-leg:${sessionId}:${ev.id || ts}`;
      const text = ev.text || '';
      const record = {
        msgId, sessionId, ts, role: 'user',
        model: defaultModel,
        tools: [], toolEventRefs: [],
        estimated: true,
      };
      rawMessages.push(record);
      if (text) workItems.push({ id: `cp-leg-text:${msgId}`, texts: [text] });
      lastAssistant = null;

    } else if (ev.type === 'copilot') {
      const msgId = `cp-leg:${sessionId}:${ev.id || ts}`;
      const text = ev.text || '';
      const record = {
        msgId, sessionId, ts, role: 'assistant',
        model: defaultModel,
        tools: [], toolEventRefs: [],
        estimated: true,
      };
      rawMessages.push(record);
      if (text) workItems.push({ id: `cp-leg-text:${msgId}`, texts: [text] });
      lastAssistant = record;

    } else if (ev.type === 'tool_call_completed') {
      if (!lastAssistant) continue;
      const callId = ev.callId || `${sessionId}:${ev.id}`;
      const compositeId = `cp-leg-tool:${sessionId}:${callId}`;
      const argText = safeStringify(ev.arguments || {});
      const resultText = typeof ev.result === 'string' ? ev.result
        : ev.result?.content ? safeStringify(ev.result.content)
        : safeStringify(ev.result || toolOutputById.get(callId) || '');

      toolDataMap.set(compositeId, {
        tool: ev.name || 'unknown',
        args: ev.arguments || {},
        start: ts,
        end: ts,
        error: false,  // legacy doesn't distinguish errors in timeline
      });
      lastAssistant.toolEventRefs.push(compositeId);

      if (argText) workItems.push({ id: `${compositeId}:in`, texts: [argText] });
      if (resultText) workItems.push({ id: `${compositeId}:out`, texts: [resultText] });
    }
  }
}

// --- New format (v0.0.342+) ---

function listNewSessionDirs(cutoff) {
  const dirs = [];
  if (!fs.existsSync(NEW_DIR)) return dirs;
  for (const name of listDir(NEW_DIR)) {
    const dir = path.join(NEW_DIR, name);
    const eventsFile = path.join(dir, 'events.jsonl');
    try {
      if (!fs.statSync(eventsFile).isFile()) continue;
      const stat = fs.statSync(eventsFile);
      if (stat.mtimeMs < cutoff) continue;
      dirs.push({ sessionId: name, eventsFile });
    } catch {}
  }
  return dirs;
}

// Parse a new-format session's events.jsonl into raw message descriptors.
// Tokens for assistant records come straight from `assistant.usage` events.
// User messages are tokenized locally.
function parseNewSession({ sessionId, eventsFile }, defaultModel, workItems, rawMessages, toolDataMap) {
  const events = readJSONL(eventsFile);
  if (events.length === 0) return;

  let lastAssistant = null;
  let sessionModel = defaultModel;

  for (const ev of events) {
    const type = ev.type;
    const ts = Date.parse(ev.timestamp) || 0;
    const data = ev.data || {};

    if (type === 'user.message') {
      const msgId = `cp-new:${sessionId}:${ev.id || ts}`;
      const text = typeof data.content === 'string' ? data.content : safeStringify(data.content);
      const record = {
        msgId, sessionId, ts, role: 'user',
        model: sessionModel,
        tools: [], toolEventRefs: [],
        estimated: true,
        realInputTokens: 0, realOutputTokens: 0,
      };
      rawMessages.push(record);
      if (text) workItems.push({ id: `cp-new-text:${msgId}`, texts: [text] });
      lastAssistant = null;

    } else if (type === 'assistant.usage') {
      const usage = data.usage || {};
      const model = data.model || sessionModel;
      sessionModel = model;
      const msgId = `cp-new:${sessionId}:${ev.id || ts}:asst`;
      // Copilot CLI's usage event mirrors the upstream API breakdown: fresh
      // input, output, cache reads (discounted), cache writes (premium).
      // Keep them separate so cost math can weight each correctly.
      const record = {
        msgId, sessionId, ts, role: 'assistant',
        model,
        tools: [], toolEventRefs: [],
        estimated: false,
        realInputTokens: usage.inputTokens || 0,
        realOutputTokens: usage.outputTokens || 0,
        realCacheReadTokens: usage.cacheReadTokens || 0,
        realCacheCreationTokens: usage.cacheWriteTokens || 0,
      };
      rawMessages.push(record);
      lastAssistant = record;

    } else if (type === 'tool.execution_start' || type === 'tool.execution_end') {
      const callId = data.toolCallId || data.callId;
      if (!callId) continue;
      const compositeId = `cp-new-tool:${sessionId}:${callId}`;
      let entry = toolDataMap.get(compositeId);
      if (!entry) {
        entry = { tool: data.toolName || 'unknown', args: {}, start: ts, end: ts, error: false };
        toolDataMap.set(compositeId, entry);
      }
      if (type === 'tool.execution_start') {
        entry.start = ts;
        entry.tool = data.toolName || entry.tool;
        if (data.arguments) {
          entry.args = data.arguments;
          workItems.push({ id: `${compositeId}:in`, texts: [safeStringify(data.arguments)] });
        }
        // Attach to the most recent assistant message.
        if (lastAssistant) lastAssistant.toolEventRefs.push(compositeId);
      } else {
        entry.end = ts;
        entry.error = !!data.error || data.status === 'error' || data.status === 'failed';
        const output = data.output ?? data.result;
        if (output !== undefined) {
          const outText = typeof output === 'string' ? output : safeStringify(output);
          workItems.push({ id: `${compositeId}:out`, texts: [outText] });
        }
      }
    }
    // session.shutdown / session.compaction_complete — totals we could cross-check,
    // but per-request assistant.usage already gives full fidelity. Ignore.
  }
}

// --- Collect ---

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const defaultModel = readDefaultModel();

  const rawMessages = [];
  const workItems = [];
  const toolDataMap = new Map();  // compositeId → { tool, args, start, end, error }

  const legacyFiles = listLegacySessionFiles(cutoff);
  for (const fp of legacyFiles) {
    parseLegacySession(fp, defaultModel, workItems, rawMessages, toolDataMap);
  }

  const newSessions = listNewSessionDirs(cutoff);
  for (const ns of newSessions) {
    parseNewSession(ns, defaultModel, workItems, rawMessages, toolDataMap);
  }

  if (rawMessages.length === 0) return [];

  console.error(`[copilot-cli] ${rawMessages.length} messages across ${legacyFiles.length} legacy + ${newSessions.length} new session(s), tokenizing ${workItems.length} items...`);

  const tokenMap = tokenizeAll(workItems);

  // Per-session title from first user message text (if real names requested).
  const sessionFirstUser = new Map();
  if (useRealSessionName) {
    for (const m of rawMessages) {
      if (m.role !== 'user') continue;
      if (sessionFirstUser.has(m.sessionId)) continue;
      const textId = m.msgId.startsWith('cp-leg:') ? `cp-leg-text:${m.msgId}` : `cp-new-text:${m.msgId}`;
      // We can't recover the text from tokens; store a placeholder using token count.
      // For a better title we'd need to retain text; legacy/new both have it available during parse.
      sessionFirstUser.set(m.sessionId, null);
    }
  }

  const records = [];
  for (const m of rawMessages) {
    const { msgId, sessionId, ts, role, model } = m;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let estimated = m.estimated;

    if (!estimated && (m.realInputTokens || m.realOutputTokens || m.realCacheReadTokens || m.realCacheCreationTokens)) {
      inputTokens = m.realInputTokens;
      outputTokens = m.realOutputTokens;
      cacheReadTokens = m.realCacheReadTokens || 0;
      cacheCreationTokens = m.realCacheCreationTokens || 0;
    } else {
      const textKey = msgId.startsWith('cp-leg:') ? `cp-leg-text:${msgId}` : `cp-new-text:${msgId}`;
      const textToks = tokenMap.get(textKey) || 0;
      if (role === 'user') inputTokens = textToks;
      else outputTokens = textToks;
    }

    // Build tools and toolEvents from attached refs.
    const tools = [];
    const toolEvents = [];
    for (const compositeId of m.toolEventRefs) {
      const tc = toolDataMap.get(compositeId);
      if (!tc) continue;
      const inToks = tokenMap.get(`${compositeId}:in`) || 0;
      const outToks = tokenMap.get(`${compositeId}:out`) || 0;
      tools.push({ tool: tc.tool, inputTokens: inToks, outputTokens: outToks });
      toolEvents.push({
        tool: tc.tool,
        tokens: inToks + outToks,
        start: tc.start,
        end: tc.end,
        args: tc.args,
        error: tc.error,
        depth: 0,
      });
    }

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0 && tools.length === 0) continue;

    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId,
      sessionTitle: sessionId.slice(0, 8),
      directory: null,
      created: ts,
      completed: ts,
      role,
      agent: null,
      // Model and provider: Copilot routes to Anthropic / OpenAI / Google
      // under the hood. Match how OpenCode reports copilot usage so combined
      // reports group naturally.
      provider: 'github-copilot',
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      humanInputTokens: role === 'user' ? inputTokens : 0,
      estimated,
      tools,
      toolEvents,
    }));
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
