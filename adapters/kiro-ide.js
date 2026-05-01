// Kiro IDE adapter.
//
// Reads Kiro IDE execution data from
// `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`.
//
// Structure (Kiro has gone through at least two storage formats):
//
//   {workspace-hash}/
//     {exec-group-hash}/{execution-hash}      -- chat-agent execution JSON
//                                                 (hex32 file, NO extension).
//                                                 Contains executionId,
//                                                 workflowType: 'chat-agent',
//                                                 input.data.messages[],
//                                                 and actions[]. This is the
//                                                 CURRENT format (active since
//                                                 late 2025, still written
//                                                 May 2026).
//     *.chat                                 -- per-LLM-call JSON at workspace
//                                                 top level. Older format used
//                                                 Sep 2025 → Feb 2026. Each
//                                                 file has executionId,
//                                                 metadata.{modelId,
//                                                 modelProvider, startTime,
//                                                 endTime}, and a chat[] array
//                                                 of {role, content} where
//                                                 role ∈ {human, bot, tool}.
//     eda71.../{hash}.json                    -- small task status records
//     f62de36...                              -- executions index file
//
// To give an accurate token count we:
//   1. Parse every hex32 chat-agent file and tokenize the FULL
//      input.data.messages (not just the last user text) plus all assistant
//      say actions and tool calls/results. This represents what the LLM saw.
//   2. Parse every workspace-top-level .chat file and group by executionId.
//   3. Dedupe: if a .chat file's executionId was already seen in a hex32
//      record, we skip it (hex32 is the authoritative record for that exec).
//      Orphan .chat files (exec has no surviving hex32, typical for
//      Sep 2025 – Feb 2026 history) are emitted as records based on their
//      full chat[] content.
//
// Token counts are not persisted by Kiro at any level, so all records are
// tokenized locally and marked `estimated: true`.

const fs = require('fs');
const path = require('path');
const { tokenizeAll, countTokens } = require('../lib/tokenize');
const { safeStringify, readJSON, listDir, makeRecord } = require('../lib/util');

const IDE_DIR = path.join(
  process.env.HOME,
  'Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent'
);
const TOOL_NAME = 'kiro-ide';

// Per-LLM-call context cap. See kiro.js for rationale — Kiro summarizes
// context before exceeding the model window, so our estimate caps input
// tokens per call at the Claude 200K context limit.
const MAX_CONTEXT_TOKENS = 200_000;

// Hex32 execution files don't record the chosen model. Default to the
// flagship Kiro model (Claude Opus 4.6) so users get a cost estimate —
// records remain `estimated: true` so the UI can flag the approximation.
// If a user predominantly runs Sonnet/Haiku, the per-CLI and per-session
// totals may overcount cost; callers who care should sample their
// `.chat` metadata (where `modelId` is recorded directly) for ground
// truth.
const HEX32_DEFAULT_MODEL = 'claude-opus-4.6';

// Map Kiro shorthand model names to canonical Claude ids (same mapping
// used by the kiro CLI adapter — kept in sync here rather than importing
// across adapter files).
function normalizeKiroModel(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === 'opus') return 'claude-opus-latest';
  if (v === 'sonnet') return 'claude-sonnet-latest';
  if (v === 'haiku') return 'claude-haiku-latest';
  return raw;
}

// Actions we ignore entirely when building records (they are metadata, not
// user-visible work).
const META_ACTIONS = new Set(['intentClassification', 'model']);

// Roles used in .chat file chat[] arrays.
const CHAT_ROLE_USER = 'human';
const CHAT_ROLE_ASSISTANT = 'bot';
const CHAT_ROLE_TOOL = 'tool';

function isAvailable() {
  return fs.existsSync(IDE_DIR);
}

// ─── Discovery ────────────────────────────────────────────────────────────

function listExecutionFiles() {
  // Walk workspace dirs -> exec-group dirs -> files. Only files whose names
  // are 32-char hex hashes (no extension) are executions.
  const files = [];
  for (const wsDir of listDir(IDE_DIR)) {
    if (wsDir.startsWith('.')) continue;
    const wsPath = path.join(IDE_DIR, wsDir);
    try { if (!fs.statSync(wsPath).isDirectory()) continue; } catch { continue; }
    for (const groupDir of listDir(wsPath)) {
      if (groupDir.startsWith('.')) continue;
      const groupPath = path.join(wsPath, groupDir);
      let st;
      try { st = fs.statSync(groupPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const fname of listDir(groupPath)) {
        if (!/^[0-9a-f]{32}$/i.test(fname)) continue;
        const fp = path.join(groupPath, fname);
        try {
          const stat = fs.statSync(fp);
          if (!stat.isFile()) continue;
          files.push({ path: fp, workspaceHash: wsDir, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  }
  return files;
}

function listChatFiles() {
  // .chat files live directly under each workspace dir (siblings to the
  // exec-group dirs). They do NOT appear inside group subdirs.
  const files = [];
  for (const wsDir of listDir(IDE_DIR)) {
    if (wsDir.startsWith('.')) continue;
    const wsPath = path.join(IDE_DIR, wsDir);
    try { if (!fs.statSync(wsPath).isDirectory()) continue; } catch { continue; }
    for (const fname of listDir(wsPath)) {
      if (!fname.endsWith('.chat')) continue;
      const fp = path.join(wsPath, fname);
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) continue;
        files.push({ path: fp, workspaceHash: wsDir, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  return files;
}

// ─── Content helpers ──────────────────────────────────────────────────────

function extractTextFromContent(content) {
  // hex32 input.data.messages[].content items are objects like
  // { type: 'text' | 'executionLog' | 'mention', text: '...' } or similar.
  // We sum all string-valued fields defensively.
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).join('\n');
  }
  if (typeof content === 'object') {
    const parts = [];
    for (const v of Object.values(content)) {
      if (typeof v === 'string') parts.push(v);
      else if (v && typeof v === 'object') parts.push(extractTextFromContent(v));
    }
    return parts.join('\n');
  }
  return '';
}

function lastUserText(messages) {
  // Return the text of the last user message — treated as "what the user
  // actually typed" for humanInputTokens.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const chunks = [];
    for (const c of m.content || []) {
      if (c.type === 'text' && typeof c.text === 'string') chunks.push(c.text);
    }
    if (chunks.length) return chunks.join('\n');
  }
  return '';
}

function allMessagesText(messages) {
  // Full text of every message in input.data.messages — approximates the
  // context that was sent to the LLM.
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    parts.push(extractTextFromContent(m.content));
  }
  return parts.filter(Boolean).join('\n');
}

function extractSayText(action) {
  return action?.output?.message || '';
}

function extractToolArgs(action) {
  const input = action.input || {};
  const out = { ...input };
  if (input.file && !out.filePath) out.filePath = input.file;
  return out;
}

function extractToolOutput(action) {
  const out = action.output;
  if (!out) return '';
  if (typeof out === 'string') return out;
  if (typeof out.output === 'string') return out.output;
  if (typeof out.message === 'string') return out.message;
  return safeStringify(out);
}

// ─── Parsing ──────────────────────────────────────────────────────────────

function parseHex32(ef) {
  const j = readJSON(ef.path);
  if (!j || j.workflowType !== 'chat-agent') return null;
  const startTime = j.startTime || j.endTime || ef.mtimeMs;
  const endTime = j.endTime || j.startTime || startTime;
  const sessionId = j.chatSessionId || j.executionId;
  const execId = j.executionId;
  const messages = j.input?.data?.messages || [];
  const userText = lastUserText(messages);
  const contextText = allMessagesText(messages);

  // Preserve the original action order so pass 2 can walk the timeline
  // and attribute per-LLM-call inputs correctly. A chat-agent exec
  // typically contains multiple `model` actions (one per LLM call) with
  // `say` + tool actions between them — each model action bills the
  // FULL context sent at that point, not just the starting context.
  const orderedActions = [];
  let sayIdx = 0, toolIdx = 0, modelIdx = 0;
  for (const a of j.actions || []) {
    const at = a.actionType;
    if (at === 'intentClassification') continue;  // pure metadata
    if (at === 'model') {
      orderedActions.push({ kind: 'model', i: modelIdx++, action: a });
    } else if (at === 'say') {
      orderedActions.push({ kind: 'say', i: sayIdx++, action: a });
    } else {
      orderedActions.push({ kind: 'tool', i: toolIdx++, action: a });
    }
  }

  return {
    source: 'hex32',
    execId,
    sessionId,
    workspaceHash: ef.workspaceHash,
    startTime,
    endTime,
    userText,
    contextText,
    orderedActions,
  };
}

function parseChat(cf) {
  const j = readJSON(cf.path);
  if (!j || !Array.isArray(j.chat)) return null;
  const md = j.metadata || {};
  const startTime = md.startTime || md.endTime || cf.mtimeMs;
  const endTime = md.endTime || md.startTime || startTime;
  const execId = j.executionId;
  // .chat has no chatSessionId; group by executionId so multi-turn execs
  // fold into a single session.
  const sessionId = execId;

  // Collect text by role. We accumulate as arrays and join once so we don't
  // build enormous concatenated strings repeatedly for long chats.
  const humanParts = [];
  const toolParts = [];
  const botParts = [];
  let lastHumanText = '';
  for (const m of j.chat) {
    const role = m.role;
    const c = m.content;
    const text = typeof c === 'string' ? c : extractTextFromContent(c);
    if (!text) continue;
    if (role === CHAT_ROLE_USER) {
      humanParts.push(text);
      lastHumanText = text;
    } else if (role === CHAT_ROLE_TOOL) {
      toolParts.push(text);
    } else if (role === CHAT_ROLE_ASSISTANT) {
      botParts.push(text);
    }
  }

  return {
    source: 'chat',
    execId,
    sessionId,
    workspaceHash: cf.workspaceHash,
    startTime,
    endTime,
    modelId: md.modelId || null,
    modelProvider: md.modelProvider || null,
    humanParts,
    toolParts,
    botParts,
    lastHumanText,
  };
}

// ─── Record building ──────────────────────────────────────────────────────

function buildHex32Records({
  entry, tokenMap, useRealSessionName,
}) {
  const {
    execId, sessionId, workspaceHash, startTime, endTime, orderedActions,
  } = entry;

  const sessionTitle = useRealSessionName
    ? (sessionId ? sessionId.slice(0, 12) : execId.slice(0, 8))
    : (sessionId ? sessionId.slice(0, 8) : execId.slice(0, 8));
  const directory = `kiro-ide:${workspaceHash.slice(0, 8)}`;
  const records = [];

  const contextTokRaw = tokenMap.get(`kide-ctx:${execId}`) || 0;
  const contextTok = Math.min(contextTokRaw, MAX_CONTEXT_TOKENS);
  const userTok = tokenMap.get(`kide-user:${execId}`) || 0;

  // Walk the action timeline in order. A chat-agent exec makes one LLM
  // call per `model` action, and each of those calls bills for the FULL
  // context accumulated up to that point — so we need N user records,
  // not one. The running `actionTokens` accumulator represents the
  // non-starting-context content that the model has ingested so far
  // (prior `say` outputs, tool-call args, tool results).
  let actionTokens = 0;
  let modelCalls = 0;
  let assistantTextTotal = 0;
  const tools = [];
  const toolEvents = [];
  let toolArgsTotal = 0;
  let humanInputBudget = userTok;
  let firstModelTime = null;

  for (const step of orderedActions) {
    if (step.kind === 'model') {
      // Emit one user record per LLM call. Input is the starting context
      // plus whatever actions have accumulated before this call; capped
      // at the model context window because Kiro compacts before
      // exceeding it. Only the first call gets the humanInputTokens
      // budget so we don't multiply user-typed tokens.
      const ts = step.action.emittedAt || step.action.endTime || startTime;
      if (firstModelTime == null) firstModelTime = ts;
      const inputTokens = Math.min(contextTok + actionTokens, MAX_CONTEXT_TOKENS);
      if (inputTokens > 0) {
        records.push(makeRecord({
          tool: TOOL_NAME,
          sessionId,
          sessionTitle,
          directory,
          created: ts,
          completed: ts,
          role: 'user',
          agent: null,
          provider: 'aws-bedrock',
          model: HEX32_DEFAULT_MODEL,
          inputTokens,
          outputTokens: 0,
          humanInputTokens: humanInputBudget,
          estimated: true,
          tools: [],
          toolEvents: [],
        }));
        humanInputBudget = 0;
        modelCalls++;
      }
    } else if (step.kind === 'say') {
      const t = tokenMap.get(`kide-say:${execId}:${step.i}`) || 0;
      assistantTextTotal += t;
      actionTokens += t;
    } else if (step.kind === 'tool') {
      const a = step.action;
      const inputTokens = tokenMap.get(`kide-toolin:${execId}:${step.i}`) || 0;
      const outputTokens = tokenMap.get(`kide-toolout:${execId}:${step.i}`) || 0;
      const toolName = a.actionType || 'unknown';
      toolArgsTotal += inputTokens;
      // Both tool args (emitted by model) and tool outputs (fed back in)
      // grow the LLM-visible history for subsequent model calls.
      actionTokens += inputTokens + outputTokens;
      tools.push({ tool: toolName, inputTokens, outputTokens });
      toolEvents.push({
        tool: toolName,
        tokens: inputTokens + outputTokens,
        start: a.emittedAt || startTime,
        end: a.endTime || a.emittedAt || endTime,
        args: extractToolArgs(a),
        error: a.actionState === 'Failed' || a.actionState === 'Rejected',
        depth: 0,
      });
    }
  }

  // Fallback: if the exec has no `model` actions (partial data) but has
  // output/context, still emit one user record so the work shows up.
  if (modelCalls === 0 && contextTok > 0) {
    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId,
      sessionTitle,
      directory,
      created: startTime,
      completed: startTime,
      role: 'user',
      agent: null,
      provider: 'aws-bedrock',
      model: HEX32_DEFAULT_MODEL,
      inputTokens: contextTok,
      outputTokens: 0,
      humanInputTokens: userTok,
      estimated: true,
      tools: [],
      toolEvents: [],
    }));
  }

  // Single assistant record aggregating all generated output for the exec.
  // Tool args ARE model-emitted (billed as output by Anthropic/Bedrock),
  // so they're included here; the per-tool bandwidth split still shows in
  // tools[] for tool-usage reports.
  if (assistantTextTotal > 0 || tools.length > 0) {
    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId,
      sessionTitle,
      directory,
      created: firstModelTime || startTime,
      completed: endTime,
      role: 'assistant',
      agent: null,
      provider: 'aws-bedrock',
      model: HEX32_DEFAULT_MODEL,
      inputTokens: 0,
      outputTokens: assistantTextTotal + toolArgsTotal,
      humanInputTokens: 0,
      estimated: true,
      tools,
      toolEvents,
    }));
  }
  return records;
}

function buildChatRecords({ entry, tokens, useRealSessionName }) {
  const {
    execId, sessionId, workspaceHash, startTime, endTime, modelId,
  } = entry;
  // Each .chat file represents one LLM call; cap its input at the model
  // context window (Kiro summarizes before exceeding it).
  const inputCtx = Math.min(tokens.inputCtx, MAX_CONTEXT_TOKENS);
  const humanLast = tokens.humanLast;
  const botOut = tokens.botOut;

  const sessionTitle = useRealSessionName
    ? (sessionId ? sessionId.slice(0, 12) : 'chat')
    : (sessionId ? sessionId.slice(0, 8) : 'chat');
  const directory = `kiro-ide:${workspaceHash.slice(0, 8)}`;
  const records = [];

  // Kiro IDE .chat metadata gives us real model info. We still report
  // `aws-bedrock` as provider when modelProvider looks Kiro-internal
  // (e.g. "qdev"), so it rolls up consistently with hex32. Normalise
  // shorthands (`opus`/`sonnet`/`haiku`) to canonical Claude ids and
  // fall back to the hex32 default if no modelId was recorded.
  const provider = 'aws-bedrock';
  const model = normalizeKiroModel(modelId) || HEX32_DEFAULT_MODEL;

  if (inputCtx > 0) {
    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId,
      sessionTitle,
      directory,
      created: startTime,
      completed: startTime,
      role: 'user',
      agent: null,
      provider,
      model,
      inputTokens: inputCtx,
      outputTokens: 0,
      humanInputTokens: humanLast,
      estimated: true,
      tools: [],
      toolEvents: [],
    }));
  }

  if (botOut > 0) {
    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId,
      sessionTitle,
      directory,
      created: startTime,
      completed: endTime,
      role: 'assistant',
      agent: null,
      provider,
      model,
      inputTokens: 0,
      outputTokens: botOut,
      humanInputTokens: 0,
      estimated: true,
      tools: [],
      toolEvents: [],
    }));
  }

  return records;
}

// ─── Main entry point ─────────────────────────────────────────────────────

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  // Discovery (cheap — just stat calls).
  const execFiles = listExecutionFiles();
  const chatFiles = listChatFiles();
  if (execFiles.length === 0 && chatFiles.length === 0) return [];

  // Pre-filter by mtime to avoid parsing files that are definitely out of
  // range. For .chat especially this matters — we skip tens of thousands of
  // files for a typical 7-day report.
  const execFresh = execFiles.filter(f => f.mtimeMs >= cutoff);
  const chatFresh = chatFiles.filter(f => f.mtimeMs >= cutoff);

  // ── Hex32 pass ──
  // These files are relatively small and few (hundreds, not thousands) so
  // we buffer them + their work items, then batch-tokenize. This keeps the
  // existing code path for the format that's still actively written.
  const hex32Parsed = [];
  const workItems = [];
  for (const ef of execFresh) {
    const p = parseHex32(ef);
    if (!p || p.startTime < cutoff) continue;
    hex32Parsed.push(p);

    if (p.contextText) workItems.push({ id: `kide-ctx:${p.execId}`, texts: [p.contextText] });
    if (p.userText) workItems.push({ id: `kide-user:${p.execId}`, texts: [p.userText] });
    for (const step of p.orderedActions) {
      if (step.kind === 'say') {
        const text = extractSayText(step.action);
        if (text) workItems.push({ id: `kide-say:${p.execId}:${step.i}`, texts: [text] });
      } else if (step.kind === 'tool') {
        const a = step.action;
        const args = extractToolArgs(a);
        const output = extractToolOutput(a);
        workItems.push({ id: `kide-toolin:${p.execId}:${step.i}`, texts: [safeStringify(args)] });
        if (output) workItems.push({ id: `kide-toolout:${p.execId}:${step.i}`, texts: [output] });
      }
    }
    // Drop the bulky raw-text fields once their work items are queued; we'll
    // look up tokens by id later.
    p.contextText = null;
    p.userText = null;
  }
  const hex32ExecIds = new Set(hex32Parsed.map(p => p.execId).filter(Boolean));

  console.error(`[kiro-ide] hex32: ${hex32Parsed.length} execs, tokenizing ${workItems.length} items...`);
  const tokenMap = workItems.length ? tokenizeAll(workItems) : new Map();

  const records = [];
  for (const e of hex32Parsed) {
    for (const r of buildHex32Records({ entry: e, tokenMap, useRealSessionName })) {
      records.push(r);
    }
  }
  // Release hex32 working memory before starting .chat stream.
  hex32Parsed.length = 0;
  workItems.length = 0;
  tokenMap.clear();

  // ── .chat stream pass ──
  // .chat files can number in the tens of thousands for long-term users, and
  // each file is large (avg ~130KB). Buffering all of them would blow out
  // memory, so we parse + tokenize + emit each file in sequence and let its
  // contents be garbage-collected before moving on.
  let chatCount = 0;
  let chatSkippedDup = 0;
  for (let idx = 0; idx < chatFresh.length; idx++) {
    const cf = chatFresh[idx];
    if (idx % 500 === 0 && chatFresh.length > 1000) {
      process.stderr.write(`\r[kiro-ide] .chat: ${idx}/${chatFresh.length} (${chatCount} emitted, ${chatSkippedDup} dedup-skipped)`);
    }
    const p = parseChat(cf);
    if (!p || p.startTime < cutoff) continue;
    if (p.execId && hex32ExecIds.has(p.execId)) {
      chatSkippedDup++;
      continue;
    }

    // Tokenize inline so we don't hold raw text beyond this iteration.
    const humanText = p.humanParts.join('\n');
    const toolText = p.toolParts.join('\n');
    const botText = p.botParts.join('\n');
    const inputCtx = countTokens(humanText ? (toolText ? humanText + '\n' + toolText : humanText) : toolText);
    const humanLast = countTokens(p.lastHumanText);
    const botOut = countTokens(botText);

    // Release large strings + parsed arrays before building records.
    p.humanParts = null;
    p.toolParts = null;
    p.botParts = null;
    p.lastHumanText = null;

    for (const r of buildChatRecords({
      entry: p,
      tokens: { inputCtx, humanLast, botOut },
      useRealSessionName,
    })) {
      records.push(r);
    }
    chatCount++;
  }
  if (chatFresh.length > 1000) process.stderr.write('\n');
  if (chatCount || chatSkippedDup) {
    console.error(`[kiro-ide] .chat: ${chatCount} orphan turns emitted, ${chatSkippedDup} deduped against hex32`);
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
