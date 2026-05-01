// Claude Code adapter.
//
// Reads Claude Code session data from `~/.claude/projects/{sanitized-project-path}/{session-id}.jsonl`.
// Each JSONL file is a single session. Lines have types: summary (first line, skip),
// user, assistant, tool_result. Other types (queue-operation, file-history-snapshot,
// system) are ignored.
//
// Token counts from the JSONL are used where reliable. `output_tokens` is
// frequently a placeholder (1-2) for assistant messages that have only text — in
// that case the text is tokenized locally and the record is marked `estimated: true`.
// `input_tokens` is trusted when `usage` is present (it's accurate even for small
// values — Claude sometimes legitimately sends very small prompts after cache hits).

const fs = require('fs');
const path = require('path');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSONL, listDir, makeRecord } = require('../lib/util');

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude/projects');
const TOOL_NAME = 'claude-code';

function isAvailable() {
  return fs.existsSync(CLAUDE_PROJECTS_DIR);
}

// Collect all *.jsonl files under ~/.claude/projects/, skipping files whose
// mtime is older than cutoff for efficiency.
function listSessionFiles(cutoff) {
  const files = [];
  for (const projectDir of listDir(CLAUDE_PROJECTS_DIR)) {
    const projectPath = path.join(CLAUDE_PROJECTS_DIR, projectDir);
    let stat;
    try { stat = fs.statSync(projectPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of listDir(projectPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectPath, file);
      try {
        const fstat = fs.statSync(filePath);
        if (fstat.mtimeMs < cutoff) continue;
      } catch { continue; }
      files.push(filePath);
    }
  }
  return files;
}

// Extract plain text from a user message content field (string or content array).
function extractUserText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// Extract plain text from assistant message content (array of blocks).
function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// Extract tool_use blocks from assistant message content.
function extractToolUses(content) {
  const calls = [];
  if (!Array.isArray(content)) return calls;
  for (const block of content) {
    if (block && block.type === 'tool_use') {
      calls.push({
        id: block.id || '',
        tool: block.name || 'unknown',
        input: block.input || {},
      });
    }
  }
  return calls;
}

// Normalise a tool_result content field to a string.
function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return safeStringify(content);
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item) parts.push(safeStringify(item));
  }
  return parts.join('\n');
}

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const sessionFiles = listSessionFiles(cutoff);
  if (sessionFiles.length === 0) return [];

  // Pass 1: parse all session files, gather raw message data and tokenize work.
  const rawMessages = [];   // { msgId, sessionId, sessionTitle, directory, ts, role, model, usage, toolCalls, toolUseIds }
  // Tool results keyed by `${sessionId}:${tool_use_id}` — Claude's tool_use ids
  // (toolu_…) are not globally unique, so a raw-id map would let one session's
  // result overwrite another's.
  const toolResultMap = new Map();
  const workItems = [];

  // Track per-session state for cwd and model inheritance.
  const sessionCwd = new Map();       // sessionId → cwd
  const sessionLastModel = new Map(); // sessionId → model string
  const sessionSummary = new Map();   // sessionId → summary text
  const summaryByFile = new Map();    // filePath → summary text (temporary)

  for (const filePath of sessionFiles) {
    const lines = readJSONL(filePath);
    if (lines.length === 0) continue;

    // First line may be a summary — capture it.
    let startIdx = 0;
    if (lines[0] && lines[0].type === 'summary') {
      summaryByFile.set(filePath, lines[0].summary || null);
      startIdx = 1;
    }

    // Determine sessionId from first real message.
    let sessionId = null;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (line && line.sessionId) { sessionId = line.sessionId; break; }
    }
    if (!sessionId) continue;

    // Register summary now that we have sessionId.
    const summaryText = summaryByFile.get(filePath);
    if (summaryText && !sessionSummary.has(sessionId)) {
      sessionSummary.set(sessionId, summaryText);
    }

    // Walk lines to build per-line records.
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.type) continue;
      const type = line.type;
      if (type === 'queue-operation' || type === 'file-history-snapshot' || type === 'system') continue;

      const ts = line.timestamp ? Date.parse(line.timestamp) : 0;
      if (ts < cutoff) continue;

      const lineSid = line.sessionId || sessionId;

      if (type === 'user') {
        // Cache cwd from first user message in this session.
        if (!sessionCwd.has(lineSid) && line.cwd) {
          sessionCwd.set(lineSid, line.cwd);
        }

        const usage = line.message?.usage || null;
        const content = line.message?.content;
        const text = extractUserText(content);
        const msgId = `cc:${lineSid}:${line.uuid || i}`;

        rawMessages.push({
          msgId,
          sessionId: lineSid,
          ts,
          role: 'user',
          model: null,   // resolved later
          usage,
          toolCalls: [],
          text,
        });

        if (!usage && text) {
          workItems.push({ id: `cc-text:${msgId}`, texts: [text] });
        }

      } else if (type === 'assistant') {
        const msg = line.message || {};
        const model = msg.model || sessionLastModel.get(lineSid) || 'unknown';
        sessionLastModel.set(lineSid, model);

        const usage = msg.usage || null;
        const content = msg.content;
        const toolCalls = extractToolUses(content);
        const text = extractAssistantText(content);
        const msgId = `cc:${lineSid}:${line.uuid || `a${i}`}`;

        // Determine if output_tokens is a placeholder (1 or 2) AND there are no tool_use blocks.
        const outputToksReported = usage ? (usage.output_tokens || 0) : 0;
        const needsOutputEstimate = toolCalls.length === 0 && outputToksReported <= 2 && text.length > 0;

        rawMessages.push({
          msgId,
          sessionId: lineSid,
          ts,
          role: 'assistant',
          model,
          usage,
          toolCalls,
          text,
          needsOutputEstimate,
        });

        if (needsOutputEstimate && text) {
          workItems.push({ id: `cc-text:${msgId}`, texts: [text] });
        }

        for (let j = 0; j < toolCalls.length; j++) {
          const tc = toolCalls[j];
          workItems.push({ id: `cc-toolin:${msgId}:${j}`, texts: [safeStringify(tc.input)] });
        }

      } else if (type === 'tool_result') {
        const tr = line.toolUseResult || {};
        const trId = tr.tool_use_id;
        if (!trId) continue;
        const key = `${lineSid}:${trId}`;
        const text = extractToolResultText(tr.content);
        toolResultMap.set(key, {
          ts,
          text,
          isError: tr.is_error === true,
        });
        workItems.push({ id: `cc-toolout:${key}`, texts: [text] });
      }
    }
  }

  console.error(`[claude-code] ${rawMessages.length} messages across ${sessionFiles.length} session files, tokenizing ${workItems.length} items...`);

  const tokenMap = tokenizeAll(workItems);

  // Pass 2: build records.
  const records = [];

  // We need to resolve model for user messages (inherit from last assistant in session).
  // rawMessages is in file order; process in order and track last model per session.
  const lastModelSeen = new Map();

  for (const msg of rawMessages) {
    const { msgId, sessionId: sid, ts, role, usage, toolCalls, needsOutputEstimate } = msg;

    // Resolve model.
    let model;
    if (role === 'assistant') {
      model = msg.model || 'unknown';
      lastModelSeen.set(sid, model);
    } else {
      model = lastModelSeen.get(sid) || 'unknown';
    }

    const directory = sessionCwd.get(sid) || null;
    const summaryText = sessionSummary.get(sid) || null;
    const sessionTitle = useRealSessionName
      ? (summaryText || sid.slice(0, 8))
      : sid.slice(0, 8);

    // Token counts — Anthropic's usage response splits cached reads/writes
    // from fresh input, so we keep them in separate buckets for accurate
    // cost weighting (cache reads ~10% of input, cache creation ~125%).
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let estimated = false;

    if (usage) {
      inputTokens = usage.input_tokens || 0;
      cacheReadTokens = usage.cache_read_input_tokens || 0;
      cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      outputTokens = usage.output_tokens || 0;
    }

    if (role === 'user' && !usage) {
      inputTokens = tokenMap.get(`cc-text:${msgId}`) || 0;
      estimated = true;
    }

    if (role === 'assistant' && needsOutputEstimate) {
      outputTokens = tokenMap.get(`cc-text:${msgId}`) || 0;
      estimated = true;
    }

    // Build tools and toolEvents.
    const tools = [];
    const toolEvents = [];

    for (let j = 0; j < toolCalls.length; j++) {
      const tc = toolCalls[j];
      const inputToks = tokenMap.get(`cc-toolin:${msgId}:${j}`) || 0;
      const trKey = `${sid}:${tc.id}`;
      const result = toolResultMap.get(trKey);
      const outputToks = result ? (tokenMap.get(`cc-toolout:${trKey}`) || 0) : 0;
      tools.push({ tool: tc.tool, inputTokens: inputToks, outputTokens: outputToks });
      toolEvents.push({
        tool: tc.tool,
        tokens: inputToks + outputToks,
        start: ts,
        end: result?.ts || ts,
        args: tc.input,
        error: result ? result.isError : false,
        depth: 0,
      });
    }

    // Skip empty records.
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0 && tools.length === 0) continue;

    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId: sid,
      sessionTitle,
      directory,
      created: ts,
      completed: ts,
      role,
      agent: null,
      provider: 'anthropic',
      model,
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
