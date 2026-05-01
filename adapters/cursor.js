// Cursor IDE adapter.
//
// Reads Cursor chat/composer history from SQLite databases:
//   - Global DB:    ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   - Workspace DBs: ~/Library/Application Support/Cursor/User/workspaceStorage/{hash}/state.vscdb
//
// Schema:
//   ItemTable(key TEXT PRIMARY KEY, value BLOB)      — workspace DBs
//   cursorDiskKV(key TEXT UNIQUE, value BLOB)        — global DB
//
// Values are JSON strings. Composer list lives in workspace DBs under
// `composer.composerData`; per-bubble data in global DB under
// `bubbleId:{composerId}:{bubbleId}`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, listDir, makeRecord } = require('../lib/util');

const CURSOR_USER_DIR = path.join(
  os.homedir(),
  'Library/Application Support/Cursor/User'
);
const GLOBAL_DB = path.join(CURSOR_USER_DIR, 'globalStorage/state.vscdb');
const WORKSPACE_STORAGE_DIR = path.join(CURSOR_USER_DIR, 'workspaceStorage');

const TOOL_NAME = 'cursor';

// Composer IDs are UUIDs in every Cursor version observed to date. Validate
// before interpolating into SQL to fail closed on unexpected formats and
// avoid both injection risk and silently-broken LIKE queries.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidComposerId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

function isAvailable() {
  return fs.existsSync(GLOBAL_DB);
}

// --- SQLite helpers ---
// Mirrors opencode.js pattern: route output through a temp file to avoid
// maxBuffer limits on large result sets.

function dbQueryJSON(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const tmp = path.join(
    os.tmpdir(),
    `cursor-usage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  try {
    execSync(`sqlite3 -json "${dbPath}" ${JSON.stringify(sql)} > "${tmp}"`, {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const out = fs.readFileSync(tmp, 'utf8');
    return JSON.parse(out || '[]');
  } catch (err) {
    console.error(`[cursor] sqlite3 query failed on ${path.basename(dbPath)}: ${err.message}`);
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function parseValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;          // already parsed by -json
  try { return JSON.parse(raw); } catch { return null; }
}

// --- Workspace / composer discovery ---

function listWorkspaceDBs() {
  const dbs = [];
  for (const hash of listDir(WORKSPACE_STORAGE_DIR)) {
    const dbPath = path.join(WORKSPACE_STORAGE_DIR, hash, 'state.vscdb');
    if (fs.existsSync(dbPath)) dbs.push({ hash, dbPath });
  }
  return dbs;
}

// Returns an array of { composerId, name, createdAt, lastUpdatedAt,
//                       unifiedMode, workspaceHash }
function getComposers(cutoff) {
  const composers = [];
  const seen = new Set();

  for (const { hash, dbPath } of listWorkspaceDBs()) {
    const rows = dbQueryJSON(
      dbPath,
      "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
    );
    for (const row of rows) {
      const data = parseValue(row.value);
      if (!data) continue;
      const list = Array.isArray(data.allComposers) ? data.allComposers : [];
      for (const c of list) {
        if (!c.composerId) continue;
        if (!isValidComposerId(c.composerId)) {
          console.error(`[cursor] skipping composer with unexpected id format: ${c.composerId}`);
          continue;
        }
        if (seen.has(c.composerId)) continue;
        seen.add(c.composerId);

        // Normalise timestamps — may be ms numbers or ISO strings
        const lastUpdated =
          typeof c.lastUpdatedAt === 'number'
            ? c.lastUpdatedAt
            : Date.parse(c.lastUpdatedAt || '') || 0;
        if (lastUpdated < cutoff) continue;

        const createdAt =
          typeof c.createdAt === 'number'
            ? c.createdAt
            : Date.parse(c.createdAt || '') || lastUpdated;

        composers.push({
          composerId: c.composerId,
          name: c.name || null,
          createdAt,
          lastUpdatedAt: lastUpdated,
          unifiedMode: c.unifiedMode || null,
          workspaceHash: hash,
        });
      }
    }
  }
  return composers;
}

// --- Bubble (message) loading from global DB ---

// Returns the ordered bubble header list for a composer:
// [{ bubbleId, type }, ...]
function getBubbleHeaders(composerId) {
  const rows = dbQueryJSON(
    GLOBAL_DB,
    `SELECT value FROM cursorDiskKV WHERE key = 'composerData:${composerId}'`
  );
  for (const row of rows) {
    const data = parseValue(row.value);
    if (!data) continue;
    const headers = data.fullConversationHeadersOnly;
    if (Array.isArray(headers)) return headers;
  }
  return [];
}

// Batch-fetch all bubbles for a composer in one query, return map bubbleId → data
function getBubblesForComposer(composerId) {
  const rows = dbQueryJSON(
    GLOBAL_DB,
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${composerId}:%'`
  );
  const map = new Map();
  for (const row of rows) {
    const data = parseValue(row.value);
    if (!data) continue;
    // Extract bubbleId from key pattern bubbleId:{composerId}:{bubbleId}
    const prefix = `bubbleId:${composerId}:`;
    const bubbleId =
      typeof row.key === 'string' && row.key.startsWith(prefix)
        ? row.key.slice(prefix.length)
        : (data.bubbleId || null);
    if (bubbleId) map.set(bubbleId, data);
  }
  return map;
}

// --- Tool data extraction ---

function extractToolName(tfd) {
  return tfd.toolName || tfd.name || tfd.tool || 'unknown';
}

function extractToolParams(tfd) {
  return tfd.params !== undefined
    ? tfd.params
    : tfd.input !== undefined
    ? tfd.input
    : tfd.arguments !== undefined
    ? tfd.arguments
    : null;
}

function extractToolResult(tfd) {
  return tfd.result !== undefined
    ? tfd.result
    : tfd.output !== undefined
    ? tfd.output
    : null;
}

// --- collect ---

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const composers = getComposers(cutoff);
  if (composers.length === 0) return [];

  console.error(`[cursor] ${composers.length} active composer(s) found`);

  // Pass 1: gather raw bubbles + build tokenization work items.
  const rawBubbles = [];   // { composer, bubble }
  const workItems = [];    // { id, texts }

  for (const composer of composers) {
    const headers = getBubbleHeaders(composer.composerId);
    const bubbleMap = getBubblesForComposer(composer.composerId);

    for (const header of headers) {
      const bubbleId = header.bubbleId || header.id;
      if (!bubbleId) continue;
      const bubble = bubbleMap.get(bubbleId);
      if (!bubble) continue;

      const bubbleRef = `cursor:${composer.composerId}:${bubbleId}`;

      // Determine token counts
      const tc = bubble.tokenCount || {};
      const rawInput = tc.inputTokens || 0;
      const rawOutput = tc.outputTokens || 0;

      const needsEstimate =
        bubble.type === 1
          ? rawInput === 0
          : rawInput === 0 && rawOutput === 0;

      if (needsEstimate && bubble.text) {
        workItems.push({ id: `cursor-text:${bubbleRef}`, texts: [bubble.text] });
      }

      // Tool data
      const tfd = bubble.toolFormerData;
      if (tfd && typeof tfd === 'object') {
        const params = extractToolParams(tfd);
        const result = extractToolResult(tfd);
        const paramsStr = safeStringify(params);
        const resultStr = safeStringify(result);
        if (paramsStr) workItems.push({ id: `cursor-toolin:${bubbleRef}`, texts: [paramsStr] });
        if (resultStr) workItems.push({ id: `cursor-toolout:${bubbleRef}`, texts: [resultStr] });
      }

      rawBubbles.push({ composer, bubble, bubbleId, bubbleRef });
    }
  }

  console.error(
    `[cursor] ${rawBubbles.length} bubble(s) across ${composers.length} composer(s), tokenizing ${workItems.length} items...`
  );

  const tokenMap = tokenizeAll(workItems);

  // Pass 2: build records.
  const records = [];

  for (const { composer, bubble, bubbleRef } of rawBubbles) {
    const tc = bubble.tokenCount || {};

    // type 1 = user, type 2 = assistant
    const isUser = bubble.type === 1;
    const isAssistant = bubble.type === 2;
    if (!isUser && !isAssistant) continue;

    const role = isUser ? 'user' : 'assistant';

    let inputTokens = tc.inputTokens || 0;
    let outputTokens = isAssistant ? (tc.outputTokens || 0) : 0;
    let estimated = false;

    if (isUser && inputTokens === 0) {
      inputTokens = tokenMap.get(`cursor-text:${bubbleRef}`) || 0;
      if (inputTokens > 0) estimated = true;
    } else if (isAssistant && inputTokens === 0 && outputTokens === 0) {
      const est = tokenMap.get(`cursor-text:${bubbleRef}`) || 0;
      if (est > 0) {
        outputTokens = est;
        estimated = true;
      }
    }

    const tools = [];
    const toolEvents = [];

    const tfd = bubble.toolFormerData;
    if (tfd && typeof tfd === 'object') {
      const toolName = extractToolName(tfd);
      const toolInputTokens = tokenMap.get(`cursor-toolin:${bubbleRef}`) || 0;
      const toolOutputTokens = tokenMap.get(`cursor-toolout:${bubbleRef}`) || 0;

      if (toolInputTokens > 0 || toolOutputTokens > 0) {
        tools.push({ tool: toolName, inputTokens: toolInputTokens, outputTokens: toolOutputTokens });

        const ts = bubble.createdAt
          ? (typeof bubble.createdAt === 'number' ? bubble.createdAt : Date.parse(bubble.createdAt) || composer.lastUpdatedAt)
          : composer.lastUpdatedAt;

        toolEvents.push({
          tool: toolName,
          tokens: toolInputTokens + toolOutputTokens,
          start: ts,
          end: ts,
          args: extractToolParams(tfd) || {},
          error: false,
          depth: 0,
        });
      }
    }

    if (inputTokens === 0 && outputTokens === 0 && tools.length === 0) continue;

    const createdTs = bubble.createdAt
      ? (typeof bubble.createdAt === 'number' ? bubble.createdAt : Date.parse(bubble.createdAt) || composer.lastUpdatedAt)
      : composer.lastUpdatedAt;

    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId: composer.composerId,
      sessionTitle: useRealSessionName
        ? (composer.name || composer.composerId.slice(0, 8))
        : composer.composerId.slice(0, 8),
      directory: null,
      created: createdTs,
      completed: createdTs,
      role,
      agent: composer.unifiedMode || null,
      provider: 'cursor',
      model: bubble.modelName || bubble.model || 'cursor-default',
      inputTokens,
      outputTokens,
      humanInputTokens: role === 'user' ? inputTokens : 0,
      estimated,
      tools,
      toolEvents,
    }));
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
