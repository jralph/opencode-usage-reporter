// VS Code Copilot Chat adapter.
//
// Reads Copilot Chat session data from VS Code's workspaceStorage and
// globalStorage directories. Supports both:
//   - v1.109+ JSONL mutation-log format (*.jsonl): kind:0 = initial state,
//     kind:1 = request added/updated, kind:2 = response merged.
//   - Legacy full-snapshot format (*.json, pre-v1.109).
//
// Auto-detects Code, Code - Insiders, and VSCodium app variants. Cursor is
// explicitly excluded — it has its own adapter.
//
// Token counts: prefer result.metadata.usage.prompt_tokens / completion_tokens
// when > 1. Fallback: tokenize locally and mark estimated: true.

const fs = require('fs');
const path = require('path');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSON, readJSONL, listDir, makeRecord } = require('../lib/util');

const APP_SUPPORT = path.join(process.env.HOME, 'Library/Application Support');

// Ordered list of VS Code variant roots. VSCodium is checked only if present.
const VARIANT_ROOTS = [
  path.join(APP_SUPPORT, 'Code'),
  path.join(APP_SUPPORT, 'Code - Insiders'),
  path.join(APP_SUPPORT, 'VSCodium'),
];

const TOOL_NAME = 'copilot-vscode';

function isAvailable() {
  return VARIANT_ROOTS.some(r => fs.existsSync(r));
}

// Try to resolve a human-readable workspace directory from a workspaceStorage
// hash folder. VS Code writes {hash}/workspace.json with a `folder` URI.
function resolveWorkspaceDir(hashDir) {
  const wsJson = readJSON(path.join(hashDir, 'workspace.json'));
  if (!wsJson) return null;
  const folder = wsJson.folder || wsJson.workspace;
  if (typeof folder !== 'string' || !folder) return null;
  // Typically a file:// URI; decode to a local path.
  try {
    const u = new URL(folder);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
  } catch {}
  // Bare path fallback (non-URI strings)
  if (!folder.includes('://')) return folder;
  return null;
}

// Collect all chatSession files (*.jsonl + *.json) from every variant root.
// Skips files whose mtime < cutoff for efficiency.
// Returns [{ filePath, hashDir, isGlobal }].
function listSessionFiles(cutoff) {
  const files = [];
  for (const root of VARIANT_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const userDir = path.join(root, 'User');

    // workspaceStorage/{hash}/chatSessions/
    const workspaceStorageDir = path.join(userDir, 'workspaceStorage');
    for (const hash of listDir(workspaceStorageDir)) {
      const hashDir = path.join(workspaceStorageDir, hash);
      let hashStat;
      try { hashStat = fs.statSync(hashDir); } catch { continue; }
      if (!hashStat.isDirectory()) continue;
      const chatSessionsDir = path.join(hashDir, 'chatSessions');
      if (!fs.existsSync(chatSessionsDir)) continue;
      for (const file of listDir(chatSessionsDir)) {
        if (!file.endsWith('.jsonl') && !file.endsWith('.json')) continue;
        const filePath = path.join(chatSessionsDir, file);
        try {
          const fstat = fs.statSync(filePath);
          if (fstat.mtimeMs < cutoff) continue;
        } catch { continue; }
        files.push({ filePath, hashDir, isGlobal: false });
      }
    }

    // globalStorage/emptyWindowChatSessions/ — sessions not tied to any workspace
    const emptyWindowDir = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(emptyWindowDir)) {
      for (const file of listDir(emptyWindowDir)) {
        if (!file.endsWith('.jsonl') && !file.endsWith('.json')) continue;
        const filePath = path.join(emptyWindowDir, file);
        try {
          const fstat = fs.statSync(filePath);
          if (fstat.mtimeMs < cutoff) continue;
        } catch { continue; }
        files.push({ filePath, hashDir: null, isGlobal: true });
      }
    }
  }
  return files;
}

// Reconstruct a session object from a v1.109+ JSONL mutation-log file.
//   kind:0 → initial full state (v contains the full session object)
//   kind:1 → request added or updated (v contains a request object with requestId)
//   kind:2 → response attached to a request (v contains requestId + response data)
// Known VS Code bug #14160: some files are missing kind:0. In that case we
// synthesise a minimal session and accumulate from kind:1/2 lines only.
function parseJsonlSession(filePath) {
  const lines = readJSONL(filePath);
  let session = null;
  // Preserve insertion order; requestId → request object
  const requestMap = new Map();

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const { kind, v } = line;
    if (v === null || v === undefined) continue;

    if (kind === 0) {
      session = Object.assign({}, v);
      if (Array.isArray(v.requests)) {
        for (const req of v.requests) {
          if (req && req.requestId) requestMap.set(req.requestId, Object.assign({}, req));
        }
      }
    } else if (kind === 1) {
      if (v.requestId) {
        const existing = requestMap.get(v.requestId);
        requestMap.set(v.requestId, Object.assign({}, existing || {}, v));
      }
    } else if (kind === 2) {
      if (v.requestId) {
        const existing = requestMap.get(v.requestId);
        requestMap.set(v.requestId, Object.assign({}, existing || {}, v));
      }
    }
  }

  // If no kind:0 line was found, synthesise a minimal session object.
  if (!session) {
    session = { requests: [] };
    // Attempt to recover sessionId from any accumulated request.
    for (const [, req] of requestMap) {
      if (req.sessionId) { session.sessionId = req.sessionId; break; }
    }
  }

  // Replace requests array with ordered, merged values from the mutation map.
  session.requests = [...requestMap.values()];
  return session;
}

// Parse a legacy full-snapshot JSON session file.
function parseJsonSession(filePath) {
  return readJSON(filePath);
}

// Extract plain text from a response.value[] array.
// Handles markdownContent entries and falls through for unknown text-like shapes.
function extractResponseText(responseValue) {
  if (!Array.isArray(responseValue)) return '';
  const parts = [];
  for (const entry of responseValue) {
    if (!entry) continue;
    if (entry.kind === 'markdownContent') {
      const text = entry.content?.value;
      if (typeof text === 'string' && text) parts.push(text);
    } else if (typeof entry.value === 'string' && entry.kind !== 'toolInvocation') {
      // Catch any other text-like entries that expose a .value string
      parts.push(entry.value);
    }
  }
  return parts.join('\n');
}

// Extract tool invocation entries from a response.value[] array.
function extractToolInvocations(responseValue) {
  if (!Array.isArray(responseValue)) return [];
  const calls = [];
  for (const entry of responseValue) {
    if (entry && entry.kind === 'toolInvocation') {
      calls.push({
        toolName: typeof entry.toolName === 'string' ? entry.toolName : 'unknown',
        toolInputs: entry.toolInputs || {},
        toolOutput: entry.toolOutput != null ? String(entry.toolOutput) : '',
        isError: entry.isError === true,
      });
    }
  }
  return calls;
}

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const sessionFiles = listSessionFiles(cutoff);
  if (sessionFiles.length === 0) return [];

  // Pass 1: parse all session files, build raw request descriptors and
  // accumulate tokenise work items. tokenizeAll() is called once at the end.
  const rawRequests = [];
  const workItems = [];

  // Cache workspace dirs so we only read each hash folder's workspace.json once.
  const dirCache = new Map();

  for (const { filePath, hashDir, isGlobal } of sessionFiles) {
    let session;
    try {
      session = filePath.endsWith('.jsonl')
        ? parseJsonlSession(filePath)
        : parseJsonSession(filePath);
    } catch {
      continue;
    }
    if (!session) continue;

    const requests = Array.isArray(session.requests) ? session.requests : [];
    if (requests.length === 0) continue;

    const rawSessionId = session.sessionId
      || path.basename(filePath, path.extname(filePath));

    // Resolve workspace directory from {hash}/workspace.json.
    let directory = null;
    if (!isGlobal && hashDir) {
      if (dirCache.has(hashDir)) {
        directory = dirCache.get(hashDir);
      } else {
        directory = resolveWorkspaceDir(hashDir);
        dirCache.set(hashDir, directory);
      }
    }

    // Pre-compute session title for useRealSessionName mode.
    const customTitle = session.customTitle || null;
    const firstUserText = requests
      .map(r => (typeof r.message?.text === 'string' ? r.message.text.trim() : ''))
      .find(t => t.length > 0) || null;
    const realTitle = customTitle || (firstUserText ? firstUserText.slice(0, 60) : null);
    const shortId = rawSessionId.slice(0, 8);
    const sessionTitle = useRealSessionName ? (realTitle || shortId) : shortId;

    for (const req of requests) {
      if (!req || typeof req !== 'object') continue;

      const ts = req.timestamp || session.creationDate || 0;
      if (ts < cutoff) continue;

      const reqId = req.requestId || `${rawSessionId}:${ts}`;
      const modelId = typeof req.modelId === 'string' ? req.modelId : '';
      const model = modelId.replace(/^copilot\//, '') || 'unknown';
      const agent = req.agent?.id || null;

      // Usage from result.metadata.usage — prefer when > 1 (> 1 guards against
      // VS Code's known 0/1 placeholder writes).
      const usageMeta = req.result?.metadata?.usage || null;
      const promptTokens = usageMeta ? (Number(usageMeta.prompt_tokens) || 0) : 0;
      const completionTokens = usageMeta ? (Number(usageMeta.completion_tokens) || 0) : 0;
      const hasRealInput = promptTokens > 1;
      const hasRealOutput = completionTokens > 1;

      // --- User record ---
      const userText = typeof req.message?.text === 'string' ? req.message.text : '';
      const userMsgId = `cv-user:${reqId}`;
      const userTextKey = `cv-text:${userMsgId}`;

      rawRequests.push({
        reqId: userMsgId,
        sessionId: rawSessionId,
        sessionTitle,
        directory,
        ts,
        role: 'user',
        model,
        agent,
        inputOverride: 0,
        outputOverride: 0,
        needsInputEstimate: false,
        needsOutputEstimate: false,
        humanTextKey: userText ? userTextKey : null,
        isAssistant: false,
        toolCalls: [],
      });

      if (userText) {
        workItems.push({ id: userTextKey, texts: [userText] });
      }

      // --- Assistant record ---
      const responseValue = req.response?.value || [];
      const assistantText = extractResponseText(responseValue);
      const toolCalls = extractToolInvocations(responseValue);
      const assistantMsgId = `cv-asst:${reqId}`;

      rawRequests.push({
        reqId: assistantMsgId,
        sessionId: rawSessionId,
        sessionTitle,
        directory,
        ts,
        role: 'assistant',
        model,
        agent,
        inputOverride: hasRealInput ? promptTokens : 0,
        outputOverride: hasRealOutput ? completionTokens : 0,
        needsInputEstimate: !hasRealInput,
        needsOutputEstimate: !hasRealOutput,
        inputEstimateKey: userText ? userTextKey : null,
        isAssistant: true,
        toolCalls,
      });

      if (!hasRealOutput && assistantText) {
        workItems.push({ id: `cv-text:${assistantMsgId}`, texts: [assistantText] });
      }

      // Tokenize each tool's inputs and outputs separately for accurate split.
      for (let j = 0; j < toolCalls.length; j++) {
        const tc = toolCalls[j];
        const inputText = safeStringify(tc.toolInputs);
        const outputText = tc.toolOutput;
        if (inputText) workItems.push({ id: `cv-tool-in:${assistantMsgId}:${j}`, texts: [inputText] });
        if (outputText) workItems.push({ id: `cv-tool-out:${assistantMsgId}:${j}`, texts: [outputText] });
      }
    }
  }

  console.error(
    `[copilot-vscode] ${rawRequests.length} raw records across ${sessionFiles.length} files, ` +
    `tokenizing ${workItems.length} items...`
  );

  // Single tokenizeAll() call for all work accumulated above.
  const tokenMap = tokenizeAll(workItems);

  // Pass 2: build final records using resolved token counts.
  const records = [];

  for (const raw of rawRequests) {
    const {
      reqId, sessionId, sessionTitle, directory, ts, role, model, agent,
      inputOverride, outputOverride, needsInputEstimate, needsOutputEstimate,
      inputEstimateKey, humanTextKey, isAssistant, toolCalls,
    } = raw;

    let inputTokens = 0;
    let outputTokens = 0;
    let humanInputTokens = 0;
    let estimated = false;

    if (isAssistant) {
      if (needsInputEstimate && inputEstimateKey) {
        inputTokens = tokenMap.get(inputEstimateKey) || 0;
        if (inputTokens > 0) estimated = true;
      } else {
        inputTokens = inputOverride || 0;
      }

      if (!needsOutputEstimate) {
        outputTokens = outputOverride || 0;
      } else {
        outputTokens = tokenMap.get(`cv-text:${reqId}`) || 0;
        if (outputTokens > 0) estimated = true;
      }
    } else {
      humanInputTokens = humanTextKey ? (tokenMap.get(humanTextKey) || 0) : 0;
      if (humanInputTokens > 0) estimated = true;
    }

    const tools = [];
    const toolEvents = [];

    if (isAssistant) {
      for (let j = 0; j < toolCalls.length; j++) {
        const tc = toolCalls[j];
        const inputToks = tokenMap.get(`cv-tool-in:${reqId}:${j}`) || 0;
        const outputToks = tokenMap.get(`cv-tool-out:${reqId}:${j}`) || 0;
        tools.push({
          tool: tc.toolName,
          inputTokens: inputToks,
          outputTokens: outputToks,
        });
        toolEvents.push({
          tool: tc.toolName,
          tokens: inputToks + outputToks,
          start: ts,
          end: ts,
          args: tc.toolInputs,
          error: tc.isError,
          depth: 0,
        });
      }
    }

    // Skip records that carry no useful signal.
    if (inputTokens === 0 && outputTokens === 0 && humanInputTokens === 0 && tools.length === 0) continue;

    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId,
      sessionTitle,
      directory,
      created: ts,
      completed: ts,
      role,
      agent,
      provider: 'github-copilot',
      model,
      inputTokens,
      outputTokens,
      humanInputTokens,
      estimated,
      tools,
      toolEvents,
    }));
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
