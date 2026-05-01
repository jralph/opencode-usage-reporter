// Small utilities shared across adapters.

const fs = require('fs');

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
// user actually typed (subset of inputTokens). It never sums into totals.
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

module.exports = { safeStringify, readJSON, readJSONL, listDir, makeRecord };
