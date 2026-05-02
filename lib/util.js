// Small utilities shared across adapters.

const fs = require('fs');
const os = require('os');
const path = require('path');

function safeStringify(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  try { return JSON.stringify(val); } catch { return String(val); }
}

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function writableTmpDir() {
  const dirs = [process.env.TMPDIR, process.env.TEMP, process.env.TMP, os.tmpdir(), '/tmp']
    .filter(Boolean);
  for (const dir of [...new Set(dirs)]) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  return '/tmp';
}

function windowsUserProfiles() {
  if (process.env.USERPROFILE) return [];
  const roots = [process.env.WSL_USERS_ROOT || '/mnt/c/Users'];
  const profiles = [];
  for (const root of roots) {
    for (const name of listDir(root)) {
      const profile = path.join(root, name);
      try {
        if (fs.statSync(profile).isDirectory()) profiles.push(profile);
      } catch {}
    }
  }
  return profiles;
}

function homeCandidates() {
  return [...new Set([
    process.env.HOME,
    process.env.USERPROFILE,
    ...windowsUserProfiles(),
  ].filter(Boolean))];
}

function readJSONL(fp) {
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Build a record shape matching the orchestrator's expectation.
//
// Token fields map to distinct billable buckets so downstream cost
// calculations can weight them correctly:
//
//   inputTokens          — fresh / uncached input (100% cost)
//   outputTokens         — generated output, including tool-use blocks (100%)
//   cacheReadTokens      — prompt-cache reads (typically ~10% of input cost)
//   cacheCreationTokens  — prompt-cache writes (typically 125% of input cost,
//                          aka cache_creation on Anthropic / 5m TTL)
//
// `humanInputTokens` is a separate side metric: the count of tokens the
// user actually typed. It never sums into billable totals by itself.
//
// Adapters that don't have provider cache metadata leave cacheRead /
// cacheCreation at 0; adapters that do (opencode, claude-code, codex,
// copilot-cli) MUST populate them separately from inputTokens so we don't
// double-count. "Total billable tokens" = input + output + cacheRead +
// cacheCreation.
function makeRecord({
  tool,
  sessionId,
  sessionTitle,
  directory = null,
  created,
  completed = null,
  role,
  agent = null,
  provider,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
  humanInputTokens = 0,
  estimated = false,
  tools = [],
  toolEvents = [],
}) {
  return {
    tool,
    sessionId,
    sessionTitle,
    directory,
    created,
    completed: completed || created,
    role,
    agent,
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
  };
}

module.exports = { safeStringify, readJSON, readJSONL, listDir, homeCandidates, writableTmpDir, makeRecord };
