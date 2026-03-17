#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const STORAGE = path.join(process.env.HOME, '.local/share/opencode/storage');
const SESSION_DIR = path.join(STORAGE, 'session');
const MESSAGE_DIR = path.join(STORAGE, 'message');

// --- CLI parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, report: 'hours', output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1], 10) || 7;
    if (args[i] === '--report' && args[i + 1]) opts.report = args[i + 1];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[i + 1];
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: report-opencode-usage.js [options]

Options:
  --days <n>              Number of days to report on (default: 7)
  --report <hours|sessions>  Report type (default: hours)
  --output <file>         Output file path (default: stdout)
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

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function getAllSessions() {
  const sessions = [];
  for (const project of listDir(SESSION_DIR)) {
    const projectDir = path.join(SESSION_DIR, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const file of listDir(projectDir).filter(f => f.endsWith('.json'))) {
      const s = readJSON(path.join(projectDir, file));
      if (s) sessions.push(s);
    }
  }
  return sessions;
}

function getMessages(sessionID) {
  const dir = path.join(MESSAGE_DIR, sessionID);
  return listDir(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readJSON(path.join(dir, f)))
    .filter(Boolean);
}

// --- Report generation ---

function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function collectUsageData(sessions, cutoff) {
  const records = [];

  for (const session of sessions) {
    const messages = getMessages(session.id);
    for (const m of messages) {
      const created = m.time?.created;
      if (!created || created < cutoff) continue;

      const provider = m.model?.providerID || 'unknown';
      const model = m.model?.modelID || 'unknown';
      const inputTokens = m.tokens?.input || 0;
      const outputTokens = m.tokens?.output || 0;

      if (inputTokens === 0 && outputTokens === 0) continue;

      records.push({
        sessionId: session.id,
        sessionTitle: session.title || session.slug || session.id,
        directory: session.directory || null,
        created,
        provider,
        model,
        inputTokens,
        outputTokens,
      });
    }
  }

  return records;
}

function buildHourlyReport(records, period) {
  const buckets = new Map();

  for (const r of records) {
    const hour = floorToHour(r.created);
    const key = `${hour}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      buckets.set(key, { hour, provider: r.provider, model: r.model, input_tokens: 0, output_tokens: 0, requests: 0 });
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    b.requests++;
  }

  const usage = [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const totals = usage.reduce((t, u) => {
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
    t.requests += u.requests;
    return t;
  }, { input_tokens: 0, output_tokens: 0, requests: 0 });

  return { report_type: 'hourly', period, generated_at: new Date().toISOString(), totals, usage };
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
        requests: 0,
      });
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
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
    t.requests += s.requests;
    return t;
  }, { input_tokens: 0, output_tokens: 0, requests: 0 });

  return { report_type: 'sessions', period, generated_at: new Date().toISOString(), totals, sessions };
}

// --- Main ---

function main() {
  const opts = parseArgs();

  if (!fs.existsSync(SESSION_DIR)) {
    console.error(`OpenCode storage not found at: ${STORAGE}`);
    process.exit(1);
  }

  const now = Date.now();
  const cutoff = now - opts.days * 86400000;
  const period = {
    start: new Date(cutoff).toISOString(),
    end: new Date(now).toISOString(),
    days: opts.days,
  };

  const sessions = getAllSessions();
  const records = collectUsageData(sessions, cutoff);

  const report = opts.report === 'sessions'
    ? buildSessionsReport(records, period)
    : buildHourlyReport(records, period);

  const json = JSON.stringify(report, null, 2);

  if (opts.output) {
    fs.writeFileSync(opts.output, json);
    console.error(`Report written to ${opts.output} (${report.totals.requests} requests, ${report.totals.input_tokens} in / ${report.totals.output_tokens} out tokens)`);
  } else {
    console.log(json);
  }
}

main();
