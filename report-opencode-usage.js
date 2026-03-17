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
  const opts = { days: 7, report: 'hours', output: null, summaryOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1], 10) || 7;
    if (args[i] === '--report' && args[i + 1]) opts.report = args[i + 1];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[i + 1];
    if (args[i] === '--summary-only') opts.summaryOnly = true;
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: report-opencode-usage.js [options]

Options:
  --days <n>              Number of days to report on (default: 7)
  --report <hours|sessions>  Report type (default: hours)
  --output <file>         Output file path (default: stdout)
  --summary-only          Only output totals, no per-hour/session breakdown
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

function dbQueryRaw(sql) {
  if (!hasDB) return '';
  try {
    return execSync(`sqlite3 "${DB_PATH}" ${JSON.stringify(sql)}`, { maxBuffer: 200 * 1024 * 1024 }).toString();
  } catch { return ''; }
}

function dbQueryJSON(sql) {
  if (!hasDB) return [];
  try {
    const out = execSync(`sqlite3 -json "${DB_PATH}" ${JSON.stringify(sql)}`, { maxBuffer: 100 * 1024 * 1024 });
    return JSON.parse(out.toString() || '[]');
  } catch { return []; }
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

// Pre-loaded DB data
let dbMessagesBySession = new Map();
let dbPartsByMessage = new Map();

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
    `SELECT p.message_id || '${FIELD_SEP}' || p.data || '${ROW_SEP}' FROM part p INNER JOIN message m ON p.message_id = m.id WHERE m.time_created >= ${cutoff}`
  );

  for (const record of partRaw.split(ROW_SEP)) {
    if (!record.trim()) continue;
    const fsIdx = record.indexOf(FIELD_SEP);
    if (fsIdx < 0) continue;
    const messageId = record.slice(0, fsIdx).trim();
    const dataStr = record.slice(fsIdx + FIELD_SEP.length);
    try {
      const data = JSON.parse(dataStr);
      if (!dbPartsByMessage.has(messageId)) dbPartsByMessage.set(messageId, []);
      dbPartsByMessage.get(messageId).push(data);
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
    .map(f => readJSON(path.join(dir, f)))
    .filter(Boolean);
}

function getMessageParts(messageID) {
  const dbParts = dbPartsByMessage.get(messageID) || [];
  if (dbParts.length > 0) return dbParts;
  return getPartsFromFiles(messageID);
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
        toolMeta.set(id, { msgId: m.id, tool: p.tool, hasInput: !!inputText, hasOutput: !!outputText });
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
  for (const tw of toolWork) {
    const total = tokenMap.get(tw.id) || 0;
    const meta = toolMeta.get(tw.id);
    if (!toolTokensByMsg.has(meta.msgId)) toolTokensByMsg.set(meta.msgId, []);
    toolTokensByMsg.get(meta.msgId).push({ tool: meta.tool, inputTokens: meta.hasInput ? total : 0, outputTokens: meta.hasOutput && !meta.hasInput ? total : 0 });
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

    records.push({
      sessionId: session.id,
      sessionTitle: session.title || session.slug || session.id,
      directory: session.directory || null,
      created: m.time.created,
      provider,
      model,
      inputTokens,
      outputTokens,
      estimated,
      tools,
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
    if (!modelMap.has(key)) modelMap.set(key, { provider: r.provider, model: r.model, input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 });
    const b = modelMap.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    for (const t of r.tools) b.tool_input_tokens += t.inputTokens;
    b.requests++;
  }
  return [...modelMap.values()].sort((a, b) => b.input_tokens - a.input_tokens);
}

function buildHourlyReport(records, period) {
  const buckets = new Map();

  for (const r of records) {
    const hour = floorToHour(r.created);
    const key = `${hour}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      buckets.set(key, { hour, provider: r.provider, model: r.model, input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0, tools: new Map() });
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
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
    t.requests += u.requests;
    return t;
  }, { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 });

  const model_totals = buildModelTotals(records);
  const tool_totals = aggregateTools(records);

  return { report_type: 'hourly', period, generated_at: new Date().toISOString(), totals, model_totals, tool_totals, usage };
}

function buildSessionsReport(records, period) {
  const buckets = new Map();

  for (const r of records) {
    const key = `${r.sessionId}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        session_id: r.sessionId,
        session_title: r.sessionTitle,
        directory: r.directory,
        started_at: r.created,
        ended_at: r.created,
        provider: r.provider,
        model: r.model,
        input_tokens: 0,
        output_tokens: 0,
        estimated_tokens: 0,
        tool_input_tokens: 0,
        requests: 0,
      });
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    for (const t of r.tools) b.tool_input_tokens += t.inputTokens;
    b.requests++;
    if (r.created < b.started_at) b.started_at = r.created;
    if (r.created > b.ended_at) b.ended_at = r.created;
  }

  const sessions = [...buckets.values()]
    .map(s => ({ ...s, started_at: new Date(s.started_at).toISOString(), ended_at: new Date(s.ended_at).toISOString() }))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  const totals = sessions.reduce((t, s) => {
    t.input_tokens += s.input_tokens;
    t.output_tokens += s.output_tokens;
    t.estimated_tokens += s.estimated_tokens;
    t.tool_input_tokens += s.tool_input_tokens;
    t.requests += s.requests;
    return t;
  }, { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 });

  const model_totals = buildModelTotals(records);
  const tool_totals = aggregateTools(records);

  return { report_type: 'sessions', period, generated_at: new Date().toISOString(), totals, model_totals, tool_totals, sessions };
}

// --- Main ---

function main() {
  const opts = parseArgs();

  if (!hasDB && !hasFiles) {
    console.error(`OpenCode storage not found at: ${OPENCODE_DIR}`);
    process.exit(1);
  }
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
    report = { report_type: report.report_type, period: report.period, generated_at: report.generated_at, totals: report.totals, model_totals: report.model_totals, tool_totals: report.tool_totals };
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
