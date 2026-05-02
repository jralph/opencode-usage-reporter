// OpenCode adapter — extracted from the original monolithic reporter.
//
// Reads session/message/part data from OpenCode's SQLite database
// (`~/.local/share/opencode/opencode.db`) and/or JSON file storage
// (`~/.local/share/opencode/storage/`). Auto-detects and merges both.
//
// Returns records in the shared internal shape (see lib/util.js `makeRecord`)
// plus a `toolName` field that downstream aggregation groups on.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tokenizeAll } = require('../lib/tokenize');
const { safeStringify, readJSON, listDir, writableTmpDir, makeRecord } = require('../lib/util');

const OPENCODE_DIR = path.join(process.env.HOME, '.local/share/opencode');
const STORAGE = path.join(OPENCODE_DIR, 'storage');
const SESSION_DIR = path.join(STORAGE, 'session');
const MESSAGE_DIR = path.join(STORAGE, 'message');
const PART_DIR = path.join(STORAGE, 'part');
const DB_PATH = path.join(OPENCODE_DIR, 'opencode.db');

const TOOL_NAME = 'opencode';
let sqliteAvailable = null;

function hasSqlite() {
  if (sqliteAvailable !== null) return sqliteAvailable;
  try {
    execSync('command -v sqlite3', { stdio: 'ignore', shell: '/bin/sh' });
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

function canUseDB() {
  return fs.existsSync(DB_PATH) && hasSqlite();
}

function isAvailable() {
  return canUseDB() || fs.existsSync(SESSION_DIR);
}

function describeSources() {
  const parts = [];
  if (canUseDB()) parts.push('SQLite');
  else if (fs.existsSync(DB_PATH)) parts.push('SQLite unavailable (sqlite3 missing)');
  if (fs.existsSync(SESSION_DIR)) parts.push('JSON files');
  return parts.join(' + ') || 'none';
}

// --- SQLite helpers ---

const FIELD_SEP = '|||F|||';
const ROW_SEP = '|||R|||';

function dbQueryRaw(sql) {
  if (!canUseDB()) return '';
  const tmp = path.join(writableTmpDir(), `opencode-usage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
  try {
    execSync(`sqlite3 "${DB_PATH}" ${JSON.stringify(sql)} > "${tmp}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
    return fs.readFileSync(tmp, 'utf8');
  } catch (err) {
    console.error(`sqlite3 query failed: ${err.message}`);
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function dbQueryJSON(sql) {
  if (!canUseDB()) return [];
  const tmp = path.join(writableTmpDir(), `opencode-usage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    execSync(`sqlite3 -json "${DB_PATH}" ${JSON.stringify(sql)} > "${tmp}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
    const out = fs.readFileSync(tmp, 'utf8');
    return JSON.parse(out || '[]');
  } catch (err) {
    console.error(`sqlite3 query failed: ${err.message}`);
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// --- Session loading ---

function getSessionsFromFiles() {
  const sessions = [];
  for (const project of listDir(SESSION_DIR)) {
    const projectDir = path.join(SESSION_DIR, project);
    try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch { continue; }
    for (const file of listDir(projectDir).filter(f => f.endsWith('.json'))) {
      const s = readJSON(path.join(projectDir, file));
      if (s) sessions.push(s);
    }
  }
  return sessions;
}

function getSessionsFromDB() {
  return dbQueryJSON('SELECT id, slug, directory, title, time_created, time_updated FROM session').map(row => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    directory: row.directory,
    time: { created: row.time_created, updated: row.time_updated },
  }));
}

function getAllSessions() {
  const seen = new Set();
  const sessions = [];
  for (const s of [...getSessionsFromDB(), ...getSessionsFromFiles()]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    sessions.push(s);
  }
  return sessions;
}

// --- Message / part loading ---

function loadDBData(cutoff, ctx) {
  if (!fs.existsSync(DB_PATH)) return;

  const msgRaw = dbQueryRaw(
    `SELECT id || '${FIELD_SEP}' || session_id || '${FIELD_SEP}' || data || '${ROW_SEP}' FROM message WHERE time_created >= ${cutoff} ORDER BY time_created ASC`
  );

  const msgIds = [];
  for (const record of msgRaw.split(ROW_SEP)) {
    if (!record.trim()) continue;
    const fsIdx = record.indexOf(FIELD_SEP);
    const fsIdx2 = record.indexOf(FIELD_SEP, fsIdx + FIELD_SEP.length);
    if (fsIdx < 0 || fsIdx2 < 0) continue;
    const id = record.slice(0, fsIdx).trim();
    const sessionId = record.slice(fsIdx + FIELD_SEP.length, fsIdx2);
    const dataStr = record.slice(fsIdx2 + FIELD_SEP.length);
    try {
      const data = JSON.parse(dataStr);
      if (!ctx.dbMessagesBySession.has(sessionId)) ctx.dbMessagesBySession.set(sessionId, []);
      ctx.dbMessagesBySession.get(sessionId).push({ id, ...data });
      msgIds.push(id);
    } catch {}
  }

  if (msgIds.length === 0) return;

  const partRaw = dbQueryRaw(
    `SELECT p.id || '${FIELD_SEP}' || p.message_id || '${FIELD_SEP}' || p.data || '${ROW_SEP}' FROM part p INNER JOIN message m ON p.message_id = m.id WHERE m.time_created >= ${cutoff} ORDER BY m.time_created ASC, p.id ASC`
  );

  for (const record of partRaw.split(ROW_SEP)) {
    if (!record.trim()) continue;
    const fsIdx = record.indexOf(FIELD_SEP);
    if (fsIdx < 0) continue;
    const partId = record.slice(0, fsIdx).trim();
    const rest = record.slice(fsIdx + FIELD_SEP.length);
    const fsIdx2 = rest.indexOf(FIELD_SEP);
    if (fsIdx2 < 0) continue;
    const messageId = rest.slice(0, fsIdx2);
    const dataStr = rest.slice(fsIdx2 + FIELD_SEP.length);
    try {
      const data = JSON.parse(dataStr);
      const part = { id: partId, ...data };
      if (!ctx.dbPartsByMessage.has(messageId)) ctx.dbPartsByMessage.set(messageId, []);
      ctx.dbPartsByMessage.get(messageId).push(part);
      ctx.dbPartsById.set(partId, part);
    } catch {}
  }
}

function getMessagesFromFiles(sessionID) {
  const dir = path.join(MESSAGE_DIR, sessionID);
  return listDir(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = readJSON(path.join(dir, f));
      if (!data) return null;
      return { id: f.replace('.json', ''), ...data };
    })
    .filter(Boolean);
}

function getMessages(sessionID, cutoff, ctx) {
  const seen = new Set();
  const messages = [];
  const dbMsgs = ctx.dbMessagesBySession.get(sessionID) || [];
  for (const m of dbMsgs) {
    seen.add(m.id);
    messages.push(m);
  }
  if (!canUseDB()) {
    for (const m of getMessagesFromFiles(sessionID)) {
      if (seen.has(m.id)) continue;
      const created = m.time?.created;
      if (!created || created < cutoff) continue;
      seen.add(m.id);
      messages.push(m);
    }
  }
  return messages;
}

function getPartsFromFiles(messageID, ctx) {
  const dir = path.join(PART_DIR, messageID);
  return listDir(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = readJSON(path.join(dir, f));
      if (!data) return null;
      const id = f.replace('.json', '');
      const part = { id, ...data };
      ctx.dbPartsById.set(id, part);
      return part;
    })
    .filter(Boolean);
}

function getMessageParts(messageID, ctx) {
  const dbParts = ctx.dbPartsByMessage.get(messageID) || [];
  if (dbParts.length > 0) return dbParts;
  return getPartsFromFiles(messageID, ctx);
}

// Recursively build flame events from a task part's metadata.summary.
function buildFlameEvents(part, depth, visited, ctx) {
  if (!part || visited.has(part.id)) return [];
  visited.add(part.id);
  const events = [];
  const start = part.state?.time?.start;
  const end = part.state?.time?.end;
  if (!start || !end) return events;
  const subagentType = part.state?.input?.subagent_type;
  const title = (subagentType ? `[${subagentType}] ` : '') + (part.state?.input?.description || part.state?.title || part.tool);
  events.push({ tool: part.tool, start, end, depth, title });
  const summary = part.state?.metadata?.summary || [];
  for (const item of summary) {
    const child = ctx.dbPartsById.get(item.id);
    if (!child) continue;
    events.push(...buildFlameEvents(child, depth + 1, visited, ctx));
  }
  return events;
}

// --- Record building ---

function gatherRawMessages(sessions, cutoff, ctx) {
  const raw = [];
  const sessionMap = new Map();
  for (const s of sessions) sessionMap.set(s.id, s);

  const sessionIds = fs.existsSync(DB_PATH)
    ? [...new Set([...ctx.dbMessagesBySession.keys()])]
    : sessions.map(s => s.id);

  for (const sid of sessionIds) {
    const session = sessionMap.get(sid);
    if (!session) continue;
    const messages = getMessages(sid, cutoff, ctx);
    for (const m of messages) {
      raw.push({ session, message: m });
    }
  }
  return raw;
}

function gatherTokenWork(rawMessages, ctx) {
  const estimateWork = [];
  const toolWork = [];
  const toolMeta = new Map();

  for (const { message: m } of rawMessages) {
    const parts = getMessageParts(m.id, ctx);
    // OpenCode mirrors Anthropic's usage breakdown: fresh input, output,
    // cache reads (discounted), cache writes (premium). We keep them
    // separate so cost math can weight each bucket correctly.
    const tk = m.tokens || {};
    const cache = tk.cache || {};
    const inputTokens = tk.input || 0;
    const outputTokens = (tk.output || 0) + (tk.reasoning || 0);
    const cacheReadTokens = cache.read || 0;
    const cacheCreationTokens = cache.write || 0;
    const hasRealUsage = inputTokens || outputTokens || cacheReadTokens || cacheCreationTokens;

    const texts = parts.filter(p => p.text).map(p => p.text);
    if (m.role === 'user' && texts.length > 0) {
      estimateWork.push({ id: `oc-human:${m.id}`, texts });
    }

    if (!hasRealUsage) {
      if (texts.length > 0) {
        estimateWork.push({ id: `oc-est:${m.id}`, texts });
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type !== 'tool' || !p.tool) continue;
      const inputText = safeStringify(p.state?.input);
      const outputText = safeStringify(p.state?.output);
      if (inputText || outputText) {
        const id = `oc-tool:${m.id}:${i}`;
        toolWork.push({ id, texts: [inputText, outputText].filter(Boolean) });
        toolMeta.set(id, {
          msgId: m.id, tool: p.tool, hasInput: !!inputText, hasOutput: !!outputText,
          args: p.state?.input || {},
          error: !!(p.state?.error || p.state?.status === 'error'),
          start: p.state?.time?.start || null,
          end: p.state?.time?.end || null,
          partRef: p.tool === 'task' ? p : null,
        });
      }
    }
  }

  return { estimateWork, toolWork, toolMeta };
}

function collect({ cutoff, useRealSessionName }) {
  if (!isAvailable()) return [];

  const ctx = {
    dbMessagesBySession: new Map(),
    dbPartsByMessage: new Map(),
    dbPartsById: new Map(),
  };

  console.error(`[opencode] Sources: ${describeSources()}`);

  loadDBData(cutoff, ctx);
  const sessions = getAllSessions();
  const rawMessages = gatherRawMessages(sessions, cutoff, ctx);

  const { estimateWork, toolWork, toolMeta } = gatherTokenWork(rawMessages, ctx);
  console.error(`[opencode] ${rawMessages.length} messages, tokenizing ${estimateWork.length + toolWork.length} items...`);

  const tokenMap = tokenizeAll([...estimateWork, ...toolWork]);

  const toolTokensByMsg = new Map();
  const toolEventsByMsg = new Map();
  for (const tw of toolWork) {
    const total = tokenMap.get(tw.id) || 0;
    const meta = toolMeta.get(tw.id);
    if (!toolTokensByMsg.has(meta.msgId)) toolTokensByMsg.set(meta.msgId, []);
    toolTokensByMsg.get(meta.msgId).push({ tool: meta.tool, inputTokens: meta.hasInput ? total : 0, outputTokens: meta.hasOutput && !meta.hasInput ? total : 0 });
    if (!toolEventsByMsg.has(meta.msgId)) toolEventsByMsg.set(meta.msgId, []);
    if (meta.tool === 'task' && meta.start && meta.end && meta.partRef) {
      const flameEvents = buildFlameEvents(meta.partRef, 0, new Set(), ctx);
      toolEventsByMsg.get(meta.msgId).push(...flameEvents);
    } else if (meta.tool !== 'task') {
      toolEventsByMsg.get(meta.msgId).push({
        tool: meta.tool, tokens: total, start: meta.start, end: meta.end, args: meta.args, error: meta.error, depth: 0,
      });
    }
  }

  const records = [];
  for (const { session, message: m } of rawMessages) {
    const provider = m.providerID || m.model?.providerID || 'unknown';
    const model = m.modelID || m.model?.modelID || 'unknown';
    const tk = m.tokens || {};
    const cache = tk.cache || {};
    let inputTokens = tk.input || 0;
    let outputTokens = (tk.output || 0) + (tk.reasoning || 0);
    let cacheReadTokens = cache.read || 0;
    let cacheCreationTokens = cache.write || 0;
    let humanInputTokens = m.role === 'user' ? (tokenMap.get(`oc-human:${m.id}`) || 0) : 0;
    let estimated = false;

    if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheCreationTokens) {
      const est = tokenMap.get(`oc-est:${m.id}`) || 0;
      if (m.role === 'assistant') outputTokens = est;
      estimated = true;
    }

    const tools = toolTokensByMsg.get(m.id) || [];
    const toolEvents = toolEventsByMsg.get(m.id) || [];
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0 && humanInputTokens === 0 && tools.length === 0) continue;

    records.push(makeRecord({
      tool: TOOL_NAME,
      sessionId: session.id,
      sessionTitle: useRealSessionName ? (session.title || session.slug || session.id.slice(0, 8)) : session.id.slice(0, 8),
      directory: session.directory || null,
      created: m.time.created,
      completed: m.time?.completed || m.time.created,
      role: m.role,
      agent: m.agent || m.mode || null,
      provider,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      humanInputTokens,
      estimated,
      tools,
      toolEvents,
    }));
  }

  return records;
}

module.exports = { name: TOOL_NAME, isAvailable, collect };
