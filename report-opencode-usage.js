#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OPENCODE_DIR = path.join(process.env.HOME, '.local/share/opencode');
const STORAGE = path.join(OPENCODE_DIR, 'storage');
const SESSION_DIR = path.join(STORAGE, 'session');
const MESSAGE_DIR = path.join(STORAGE, 'message');
const PART_DIR = path.join(STORAGE, 'part');
const DB_PATH = path.join(OPENCODE_DIR, 'opencode.db');

// --- CLI parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, report: 'hours', output: null, summaryOnly: false, useRealSessionName: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1], 10) || 7;
    if (args[i] === '--report' && args[i + 1]) opts.report = args[i + 1];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[i + 1];
    if (args[i] === '--summary-only') opts.summaryOnly = true;
    if (args[i] === '--use-real-session-name') opts.useRealSessionName = true;
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: report-opencode-usage.js [options]

Options:
  --days <n>              Number of days to report on (default: 7)
  --report <hours|sessions>  Report type (default: hours)
  --output <file>         Output file path (default: stdout)
  --summary-only          Only output totals, no per-hour/session breakdown
  --use-real-session-name Include actual session titles instead of anonymised IDs
  --help                  Show this help`);
      process.exit(0);
    }
  }
  if (!['hours', 'sessions'].includes(opts.report)) {
    console.error(`Invalid report type: "${opts.report}". Use "hours" or "sessions".`);
    process.exit(1);
  }
  return opts;
}

// --- Data reading ---

const hasDB = fs.existsSync(DB_PATH);
const hasFiles = fs.existsSync(SESSION_DIR);

// Large SQLite result sets (tool parts over a month can exceed 400 MB) would overflow
// execSync's default maxBuffer and be silently swallowed, producing reports with zero
// tool calls. Stream output to a temp file instead so size is unbounded.
function dbQueryRaw(sql) {
  if (!hasDB) return '';
  const tmp = path.join(require('os').tmpdir(), `opencode-usage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
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
  if (!hasDB) return [];
  const tmp = path.join(require('os').tmpdir(), `opencode-usage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

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

// Runtime options (set in main before data collection)
let useRealSessionName = false;

// Pre-loaded DB data
let dbMessagesBySession = new Map();
let dbPartsByMessage = new Map();
let dbPartsById = new Map();

const FIELD_SEP = '|||F|||';
const ROW_SEP = '|||R|||';

function loadDBData(cutoff) {
  if (!hasDB) return;

  const msgRaw = dbQueryRaw(
    `SELECT id || '${FIELD_SEP}' || session_id || '${FIELD_SEP}' || data || '${ROW_SEP}' FROM message WHERE time_created >= ${cutoff}`
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
      if (!dbMessagesBySession.has(sessionId)) dbMessagesBySession.set(sessionId, []);
      dbMessagesBySession.get(sessionId).push({ id, ...data });
      msgIds.push(id);
    } catch {}
  }

  if (msgIds.length === 0) return;

  const partRaw = dbQueryRaw(
    `SELECT p.id || '${FIELD_SEP}' || p.message_id || '${FIELD_SEP}' || p.data || '${ROW_SEP}' FROM part p INNER JOIN message m ON p.message_id = m.id WHERE m.time_created >= ${cutoff}`
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
      if (!dbPartsByMessage.has(messageId)) dbPartsByMessage.set(messageId, []);
      dbPartsByMessage.get(messageId).push(part);
      dbPartsById.set(partId, part);
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

function getMessages(sessionID, cutoff) {
  const seen = new Set();
  const messages = [];
  const dbMsgs = dbMessagesBySession.get(sessionID) || [];
  for (const m of dbMsgs) {
    seen.add(m.id);
    messages.push(m);
  }
  if (!hasDB) {
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

function getPartsFromFiles(messageID) {
  const dir = path.join(PART_DIR, messageID);
  return listDir(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = readJSON(path.join(dir, f));
      if (!data) return null;
      const id = f.replace('.json', '');
      const part = { id, ...data };
      dbPartsById.set(id, part);
      return part;
    })
    .filter(Boolean);
}

function getMessageParts(messageID) {
  const dbParts = dbPartsByMessage.get(messageID) || [];
  if (dbParts.length > 0) return dbParts;
  return getPartsFromFiles(messageID);
}

// Recursively build flame events from a task part's metadata.summary.
// Returns flat array of {tool, start, end, depth, title} for the flame chart.
function buildFlameEvents(part, depth = 0, visited = new Set()) {
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
    const child = dbPartsById.get(item.id);
    if (!child) continue;
    events.push(...buildFlameEvents(child, depth + 1, visited));
  }
  return events;
}

function safeStringify(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

// --- Tokenization ---

function progressBar(current, total, label) {
  const width = 30;
  const pct = total === 0 ? 1 : current / total;
  const filled = Math.round(width * pct);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stderr.write(`\r  [${bar}] ${Math.round(pct * 100)}% ${label}`);
  if (current >= total) process.stderr.write('\n');
}

function tokenizeAll(workItems) {
  if (workItems.length === 0) return new Map();

  const { getTokenizer } = require('@anthropic-ai/tokenizer');
  const tokenizer = getTokenizer();
  const map = new Map();
  const total = workItems.length;

  for (let i = 0; i < total; i++) {
    const item = workItems[i];
    let tokens = 0;
    for (const text of item.texts) {
      if (text) tokens += tokenizer.encode(text.normalize('NFKC'), 'all').length;
    }
    map.set(item.id, tokens);
    if (i % 100 === 0 || i === total - 1) {
      progressBar(i + 1, total, `${i + 1}/${total} items`);
    }
  }

  tokenizer.free();
  return map;
}

// --- Report generation ---

function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function gatherRawMessages(sessions, cutoff) {
  const raw = [];
  const sessionMap = new Map();
  for (const s of sessions) sessionMap.set(s.id, s);

  const sessionIds = hasDB
    ? [...new Set([...dbMessagesBySession.keys()])]
    : sessions.map(s => s.id);

  for (const sid of sessionIds) {
    const session = sessionMap.get(sid);
    if (!session) continue;
    const messages = getMessages(sid, cutoff);
    for (const m of messages) {
      raw.push({ session, message: m });
    }
  }
  return raw;
}

function gatherTokenWork(rawMessages) {
  const estimateWork = [];
  const toolWork = [];
  const toolMeta = new Map();

  for (const { message: m } of rawMessages) {
    const parts = getMessageParts(m.id);
    const inputTokens = m.tokens?.input || 0;
    const outputTokens = m.tokens?.output || 0;

    if (inputTokens === 0 && outputTokens === 0) {
      const texts = parts.filter(p => p.text).map(p => p.text);
      if (texts.length > 0) {
        estimateWork.push({ id: `est:${m.id}`, texts });
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type !== 'tool' || !p.tool) continue;
      const inputText = safeStringify(p.state?.input);
      const outputText = safeStringify(p.state?.output);
      if (inputText || outputText) {
        const id = `tool:${m.id}:${i}`;
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

function collectUsageData(sessions, cutoff) {
  const rawMessages = gatherRawMessages(sessions, cutoff);

  const { estimateWork, toolWork, toolMeta } = gatherTokenWork(rawMessages);
  console.error(`${rawMessages.length} messages, tokenizing ${estimateWork.length + toolWork.length} items...`);

  const tokenMap = tokenizeAll([...estimateWork, ...toolWork]);

  const toolTokensByMsg = new Map();
  const toolEventsByMsg = new Map();
  for (const tw of toolWork) {
    const total = tokenMap.get(tw.id) || 0;
    const meta = toolMeta.get(tw.id);
    if (!toolTokensByMsg.has(meta.msgId)) toolTokensByMsg.set(meta.msgId, []);
    toolTokensByMsg.get(meta.msgId).push({ tool: meta.tool, inputTokens: meta.hasInput ? total : 0, outputTokens: meta.hasOutput && !meta.hasInput ? total : 0 });
    if (!toolEventsByMsg.has(meta.msgId)) toolEventsByMsg.set(meta.msgId, []);
    // For task parts, recursively expand their summary for nested flame events.
    // For other tools, emit a flat event at depth 0.
    if (meta.tool === 'task' && meta.start && meta.end && meta.partRef) {
      const flameEvents = buildFlameEvents(meta.partRef, 0);
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
    let inputTokens = m.tokens?.input || 0;
    let outputTokens = m.tokens?.output || 0;
    let estimated = false;

    if (inputTokens === 0 && outputTokens === 0) {
      const est = tokenMap.get(`est:${m.id}`) || 0;
      if (est === 0) continue;
      if (m.role === 'user') inputTokens = est;
      else outputTokens = est;
      estimated = true;
    }

    const tools = toolTokensByMsg.get(m.id) || [];
    const toolEvents = toolEventsByMsg.get(m.id) || [];

    records.push({
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
      humanInputTokens: m.role === 'user' ? inputTokens : 0,
      estimated,
      tools,
      toolEvents,
    });
  }

  return records;
}

function aggregateTools(records) {
  const toolMap = new Map();
  for (const r of records) {
    for (const t of r.tools) {
      if (!toolMap.has(t.tool)) toolMap.set(t.tool, { tool: t.tool, calls: 0, input_tokens: 0, output_tokens: 0 });
      const b = toolMap.get(t.tool);
      b.calls++;
      b.input_tokens += t.inputTokens;
      b.output_tokens += t.outputTokens;
    }
  }
  return [...toolMap.values()].sort((a, b) => b.input_tokens + b.output_tokens - a.input_tokens - a.output_tokens);
}

function buildModelTotals(records) {
  const modelMap = new Map();
  for (const r of records) {
    const key = `${r.provider}|${r.model}`;
    if (!modelMap.has(key)) modelMap.set(key, { provider: r.provider, model: r.model, input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 });
    const b = modelMap.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) b.tool_input_tokens += t.inputTokens;
    b.requests++;
  }
  return [...modelMap.values()].sort((a, b) => b.input_tokens - a.input_tokens);
}

// --- Warnings / waste detection ---

function detectWarnings(records, toolTotals, sessionDetails) {
  const warnings = [];

  // Per-session warnings
  for (const s of sessionDetails) {
    // Excessive iteration: >40 requests in a session
    if (s.requests > 40) {
      warnings.push({ type: 'excessive_iteration', severity: 'severe', session_id: s.session_id,
        detail: `${s.requests} requests in session ${s.session_id}. Possible thrashing or micromanagement.` });
    }
    // Wasted compute: >5 requests but 0 tool calls (no productive output)
    if (s.requests > 5 && s.tool_calls === 0) {
      warnings.push({ type: 'wasted_compute', severity: 'severe', session_id: s.session_id,
        detail: `${s.requests} requests with zero tool calls in session ${s.session_id}. Tokens burned with no tool usage.` });
    }
    // Low token efficiency: >50:1 total tokens to tool output tokens
    const totalTok = s.input_tokens + s.output_tokens;
    const toolOutTok = s.tool_output_tokens || 0;
    if (toolOutTok > 0 && totalTok / toolOutTok > 50) {
      warnings.push({ type: 'low_token_efficiency', severity: 'warn', session_id: s.session_id,
        detail: `${Math.round(totalTok / toolOutTok)}:1 token ratio in session ${s.session_id}. High context overhead for output produced.` });
    }
    // Output heavy: output tokens > input tokens and >5k output
    if (s.output_tokens > s.input_tokens && s.output_tokens > 5000) {
      warnings.push({ type: 'output_heavy', severity: 'info', session_id: s.session_id,
        detail: `${s.output_tokens} output vs ${s.input_tokens} input in session ${s.session_id}. Unusually verbose generation.` });
    }
    // Long running: >30 min
    if (s.started_at && s.ended_at) {
      const dur = new Date(s.ended_at) - new Date(s.started_at);
      if (dur > 30 * 60 * 1000) {
        const mins = Math.round(dur / 60000);
        warnings.push({ type: 'long_running', severity: 'info', session_id: s.session_id,
          detail: `${mins}m duration for session ${s.session_id}. May indicate stuck or slow processing.` });
      }
    }
    // Excessive full-file reads: >10 full reads or >50k tokens from full reads
    if (s.file_changes) {
      const fc = s.file_changes;
      if (fc.full_reads > 10) {
        warnings.push({ type: 'excessive_full_reads', severity: 'warn', session_id: s.session_id,
          detail: `${fc.full_reads} full-file reads (${fc.full_read_tokens} tokens) in session ${s.session_id}. Use partial reads to reduce context.` });
      } else if (fc.full_read_tokens > 50000) {
        warnings.push({ type: 'expensive_full_reads', severity: 'warn', session_id: s.session_id,
          detail: `${fc.full_read_tokens} tokens from ${fc.full_reads} full-file reads in session ${s.session_id}. Large files being read entirely.` });
      }
    }
  }

  // Per-session tool event warnings (inefficient reads, unbounded bash, read-then-small-edit)
  const boundedPipe = /\|\s*(head|tail|wc|grep|awk|sed|cut|sort|uniq|less|more)\b/;
  const bySession = new Map();
  for (const r of records) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(...r.toolEvents.map(te => ({ ...te, sessionId: r.sessionId })));
  }
  for (const [sid, events] of bySession) {
    // Inefficient reads
    const fullReads = events.filter(te => te.tool === 'read' && te.args && !te.args.offset && !te.args.limit && !te.args.startLine && !te.args.endLine && !te.args.start_line && !te.args.end_line);
    if (fullReads.length > 5) {
      const totalTok = fullReads.reduce((s, te) => s + (te.tokens || 0), 0);
      warnings.push({ type: 'inefficient_reads', severity: 'warn', session_id: sid,
        detail: `${fullReads.length} full-file reads without offset/limit (${totalTok} tokens) in session ${sid}. Use partial reads to reduce context.` });
    }
    // Unbounded bash
    const unbounded = events.filter(te => te.tool === 'bash' && (te.args?.command || te.args?.cmd) && !boundedPipe.test(te.args?.command || te.args?.cmd || '') && (te.tokens || 0) > 2000);
    if (unbounded.length > 0) {
      warnings.push({ type: 'unbounded_bash', severity: 'warn', session_id: sid,
        detail: `${unbounded.length} bash commands with >2k output tokens and no pipe to head/tail/grep in session ${sid}. Pipe output to limit context waste.` });
    }
    // Read-then-small-edit
    let rse = 0;
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1], cur = events[i];
      if (prev.tool !== 'read' || !['edit', 'write'].includes(cur.tool)) continue;
      const prevFile = prev.args?.filePath || prev.args?.path || '';
      const curFile = cur.args?.filePath || cur.args?.path || '';
      if (!prevFile || prevFile !== curFile) continue;
      if (prev.args?.offset || prev.args?.limit || prev.args?.startLine || prev.args?.endLine || prev.args?.start_line || prev.args?.end_line) continue;
      const editSize = (cur.args?.new_str || cur.args?.newStr || cur.args?.content || cur.args?.file_text || '').length;
      if ((prev.tokens || 0) > 1000 && editSize < 500) rse++;
    }
    if (rse > 0) {
      warnings.push({ type: 'read_then_small_edit', severity: 'warn', session_id: sid,
        detail: `${rse} full-file reads followed by small edits in session ${sid}. Partial reads would reduce token waste.` });
    }

    // Dead context detection
    // 1. Duplicate reads: same file read multiple times with same/no params
    const readKeys = new Map();
    let dupReadTokens = 0, dupReadCount = 0;
    for (const te of events) {
      if (te.tool !== 'read') continue;
      const file = te.args?.filePath || te.args?.path || '';
      const key = `${file}|${te.args?.startLine || ''}|${te.args?.endLine || ''}|${te.args?.start_line || ''}|${te.args?.end_line || ''}`;
      if (readKeys.has(key)) { dupReadCount++; dupReadTokens += te.tokens || 0; }
      else readKeys.set(key, true);
    }
    if (dupReadCount > 3 && dupReadTokens > 5000) {
      warnings.push({ type: 'duplicate_reads', severity: 'warn', session_id: sid,
        detail: `${dupReadCount} duplicate file reads (${dupReadTokens} tokens) in session ${sid}. Same file read multiple times with same params.` });
    }

    // 2. Superseded writes: file written then read again (write content became stale context)
    const writtenFiles = new Map();
    let supersededTokens = 0, supersededCount = 0;
    for (const te of events) {
      const file = te.args?.filePath || te.args?.path || '';
      if (!file) continue;
      if (te.tool === 'write' || te.tool === 'edit') {
        writtenFiles.set(file, te.tokens || 0);
      } else if (te.tool === 'read' && writtenFiles.has(file)) {
        supersededTokens += writtenFiles.get(file);
        supersededCount++;
        writtenFiles.delete(file);
      }
    }
    if (supersededCount > 2 && supersededTokens > 3000) {
      warnings.push({ type: 'superseded_writes', severity: 'info', session_id: sid,
        detail: `${supersededCount} writes superseded by later reads (~${supersededTokens} tokens) in session ${sid}. Write content became stale context.` });
    }

    // 3. Errored tool inputs: tool calls that failed (input tokens wasted)
    const errored = events.filter(te => te.error && (te.tokens || 0) > 500);
    if (errored.length > 0) {
      const erroredTokens = errored.reduce((s, te) => s + (te.tokens || 0), 0);
      warnings.push({ type: 'errored_tool_inputs', severity: 'warn', session_id: sid,
        detail: `${errored.length} errored tool calls (${erroredTokens} tokens) in session ${sid}. Failed tool inputs wasted context.` });
    }
  }

  // Tool dominance: single tool >60% of all tool tokens
  const totalToolTok = toolTotals.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0);
  for (const t of toolTotals) {
    const toolTok = t.input_tokens + t.output_tokens;
    if (totalToolTok > 10000 && toolTok / totalToolTok > 0.6) {
      warnings.push({ type: 'tool_dominance', severity: 'info',
        detail: `"${t.tool}" accounts for ${Math.round(toolTok / totalToolTok * 100)}% of tool tokens (${toolTok}). May indicate over-reliance.` });
    }
    // Expensive tool: single tool >100k tokens
    if (toolTok > 100000) {
      warnings.push({ type: 'expensive_tool', severity: 'warn',
        detail: `"${t.tool}" consumed ${toolTok} tokens across ${t.calls} calls. Consider optimizing usage.` });
    }
  }

  return warnings;
}

// --- Session detail builder (always included) ---

function buildSessionDetails(records) {
  const buckets = new Map();

  for (const r of records) {
    const key = `${r.sessionId}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        session_id: r.sessionId,
        session_title: r.sessionTitle,
        directory: r.directory,
        started_at: r.created,
        ended_at: r.completed || r.created,
        provider: r.provider,
        model: r.model,
        input_tokens: 0,
        output_tokens: 0,
        estimated_tokens: 0,
        tool_input_tokens: 0,
        tool_output_tokens: 0,
        tool_calls: 0,
        human_input_tokens: 0,
        requests: 0,
        agents: {},
        tool_timeline: [],
      });
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) {
      b.tool_input_tokens += t.inputTokens;
      b.tool_output_tokens += t.outputTokens;
      b.tool_calls++;
    }
    b.requests++;
    if (r.created < b.started_at) b.started_at = r.created;
    const end = r.completed || r.created;
    if (end > b.ended_at) b.ended_at = end;

    // Agent tracking
    if (r.agent) {
      if (!b.agents[r.agent]) b.agents[r.agent] = { requests: 0, input_tokens: 0, output_tokens: 0, model: r.model };
      b.agents[r.agent].requests++;
      b.agents[r.agent].input_tokens += r.inputTokens;
      b.agents[r.agent].output_tokens += r.outputTokens;
      if (r.model) b.agents[r.agent].model = r.model;
    }

    // Tool timeline events for flame graph
    for (const te of r.toolEvents) {
      if (te.start && te.end) {
        b.tool_timeline.push({ tool: te.tool, start: te.start, end: te.end, tokens: te.tokens, depth: te.depth || 0, title: te.title });
      }
    }

    // Per-file anonymous summary (always)
    for (const te of r.toolEvents) {
      if (!te.args?.filePath || !['read', 'edit', 'write'].includes(te.tool)) continue;
      if (!b.fileChanges) b.fileChanges = { reads: 0, edits: 0, writes: 0, full_reads: 0, full_read_tokens: 0, unique_files: new Set(), additions: 0, deletions: 0 };
      b.fileChanges[te.tool === 'read' ? 'reads' : te.tool === 'edit' ? 'edits' : 'writes']++;
      b.fileChanges.unique_files.add(te.args.filePath);
      if (te.tool === 'read' && !te.args.offset && !te.args.limit && !te.args.startLine && !te.args.endLine && !te.args.start_line && !te.args.end_line) {
        b.fileChanges.full_reads++;
        b.fileChanges.full_read_tokens += te.tokens || 0;
      }
      b.fileChanges.unique_files.add(te.args.filePath);
      const countLines = s => (typeof s === 'string' && s.length > 0) ? s.split('\n').length : 0;
      if (te.tool === 'edit') {
        const oldStr = te.args.old_str || te.args.oldStr || '';
        const newStr = te.args.new_str || te.args.newStr || '';
        b.fileChanges.deletions += countLines(oldStr);
        b.fileChanges.additions += countLines(newStr);
      } else if (te.tool === 'write') {
        const content = te.args.content || te.args.file_text || '';
        b.fileChanges.additions += countLines(content);
      }
    }

    // Per-file stats (opt-in, non-anonymous mode only)
    if (useRealSessionName) {
      if (!b.fileMap) b.fileMap = new Map();
      for (const te of r.toolEvents) {
        const filePath = te.args?.filePath;
        if (!filePath || !['read', 'edit', 'write'].includes(te.tool)) continue;
        if (!b.fileMap.has(filePath)) b.fileMap.set(filePath, { path: filePath, calls: 0, input_tokens: 0, tools: {} });
        const f = b.fileMap.get(filePath);
        f.calls++;
        f.input_tokens += te.tokens || 0;
        f.tools[te.tool] = (f.tools[te.tool] || 0) + 1;
      }
    }
  }

  return [...buckets.values()]
    .map(s => {
      const files = s.fileMap && s.fileMap.size > 0
        ? [...s.fileMap.values()].sort((a, b) => b.input_tokens - a.input_tokens)
        : undefined;
      const { fileMap: _fm, fileChanges: _fc, ...rest } = s;
      const file_changes = s.fileChanges
        ? { reads: s.fileChanges.reads, edits: s.fileChanges.edits, writes: s.fileChanges.writes, unique_files: s.fileChanges.unique_files.size, additions: s.fileChanges.additions, deletions: s.fileChanges.deletions, full_reads: s.fileChanges.full_reads, full_read_tokens: s.fileChanges.full_read_tokens }
        : undefined;
      return {
        ...rest,
        started_at: new Date(s.started_at).toISOString(),
        ended_at: new Date(s.ended_at).toISOString(),
        agents: Object.keys(s.agents).length > 0 ? s.agents : undefined,
        tool_timeline: s.tool_timeline.length > 0 ? s.tool_timeline.sort((a, b) => a.start - b.start) : undefined,
        file_changes,
        files,
      };
    })
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

// Aggregate per-session file stats into a global file_stats array.
// Enriches each entry with the session's directory and a sessions count.
function buildFileStats(sessions) {
  if (!useRealSessionName) return undefined;
  const fileMap = new Map();
  for (const s of sessions) {
    if (!s.files) continue;
    for (const f of s.files) {
      if (!fileMap.has(f.path)) {
        fileMap.set(f.path, { path: f.path, calls: 0, input_tokens: 0, sessions: 0, directory: s.directory || null, tools: {} });
      }
      const entry = fileMap.get(f.path);
      entry.calls += f.calls;
      entry.input_tokens += f.input_tokens;
      entry.sessions++;
      for (const [tool, count] of Object.entries(f.tools)) {
        entry.tools[tool] = (entry.tools[tool] || 0) + count;
      }
    }
  }
  if (fileMap.size === 0) return undefined;
  return [...fileMap.values()].sort((a, b) => b.input_tokens - a.input_tokens);
}

function buildHourlyReport(records, period) {
  const buckets = new Map();

  for (const r of records) {
    const hour = floorToHour(r.created);
    const key = `${hour}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      buckets.set(key, { hour, provider: r.provider, model: r.model, input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0, tools: new Map() });
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) {
      b.tool_input_tokens += t.inputTokens;
      if (!b.tools.has(t.tool)) b.tools.set(t.tool, { calls: 0, input_tokens: 0 });
      const tb = b.tools.get(t.tool);
      tb.calls++;
      tb.input_tokens += t.inputTokens;
    }
    b.requests++;
  }

  const usage = [...buckets.values()]
    .map(b => ({ ...b, tools: Object.fromEntries(b.tools) }))
    .sort((a, b) => a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const totals = usage.reduce((t, u) => {
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
    t.estimated_tokens += u.estimated_tokens;
    t.tool_input_tokens += u.tool_input_tokens;
    t.human_input_tokens += u.human_input_tokens;
    t.requests += u.requests;
    return t;
  }, { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 });

  const model_totals = buildModelTotals(records);
  const tool_totals = aggregateTools(records);
  const sessions = buildSessionDetails(records);
  const warnings = detectWarnings(records, tool_totals, sessions);
  const file_stats = buildFileStats(sessions);

  return { report_type: 'hourly', period, generated_at: new Date().toISOString(), totals, model_totals, tool_totals, warnings, file_stats, sessions, usage };
}

function buildSessionsReport(records, period) {
  const sessions = buildSessionDetails(records);

  const totals = sessions.reduce((t, s) => {
    t.input_tokens += s.input_tokens;
    t.output_tokens += s.output_tokens;
    t.estimated_tokens += s.estimated_tokens;
    t.tool_input_tokens += s.tool_input_tokens;
    t.human_input_tokens += s.human_input_tokens;
    t.requests += s.requests;
    return t;
  }, { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 });

  const model_totals = buildModelTotals(records);
  const tool_totals = aggregateTools(records);
  const warnings = detectWarnings(records, tool_totals, sessions);
  const file_stats = buildFileStats(sessions);

  return { report_type: 'sessions', period, generated_at: new Date().toISOString(), totals, model_totals, tool_totals, warnings, file_stats, sessions };
}

// --- Main ---

function main() {
  const opts = parseArgs();

  if (!hasDB && !hasFiles) {
    console.error(`OpenCode storage not found at: ${OPENCODE_DIR}`);
    process.exit(1);
  }
  useRealSessionName = opts.useRealSessionName;
  const sources = [hasDB && 'SQLite', hasFiles && 'JSON files'].filter(Boolean).join(' + ');
  console.error(`Sources: ${sources}`);

  const now = Date.now();
  const cutoff = now - opts.days * 86400000;
  const period = {
    start: new Date(cutoff).toISOString(),
    end: new Date(now).toISOString(),
    days: opts.days,
  };

  loadDBData(cutoff);
  const sessions = getAllSessions();
  const records = collectUsageData(sessions, cutoff);

  let report = opts.report === 'sessions'
    ? buildSessionsReport(records, period)
    : buildHourlyReport(records, period);

  if (opts.summaryOnly) {
    report = { report_type: report.report_type, period: report.period, generated_at: report.generated_at, totals: report.totals, model_totals: report.model_totals, tool_totals: report.tool_totals, warnings: report.warnings };
  }

  const json = JSON.stringify(report, null, 2);

  if (opts.output) {
    fs.writeFileSync(opts.output, json);
    console.error(`Report written to ${opts.output} (${report.totals.requests} requests, ${report.totals.input_tokens} in / ${report.totals.output_tokens} out tokens)`);
  } else {
    console.log(json);
  }
}

main();
