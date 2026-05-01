#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { port: 3000, reports: null };
  for (let i = 0; i < args.length; i++) {
    // --reports accepts either a directory (load all *.json inside) or a
    // single .json file (load just that one report).
    // --report is accepted as an alias for the single-file case.
    if ((args[i] === '--reports' || args[i] === '--report') && args[i + 1]) opts.reports = args[++i];
    else if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: report-analytics serve --reports <path> [--port <n>]

Options:
  --reports <path>  Directory of report JSON files, or a single report.json file
  --report  <file>  Alias for passing a single report file
  --port <n>        Port to listen on (default: 3000)
  --help            Show this help

Examples:
  report-analytics serve --reports ./reports
  report-analytics serve --reports ./report.json
  report-analytics serve --report ./report.json --port 4000`);
      process.exit(0);
    }
  }
  if (!opts.reports) {
    console.error('Error: --reports <path> is required (directory or single JSON file)');
    process.exit(1);
  }
  return opts;
}

function loadReports(reportsPath) {
  const absPath = path.resolve(reportsPath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: reports path not found: ${absPath}`);
    process.exit(1);
  }
  const stat = fs.statSync(absPath);
  let files;
  let baseDir;
  if (stat.isFile()) {
    if (!absPath.endsWith('.json')) {
      console.error(`Error: expected a .json file or a directory, got: ${absPath}`);
      process.exit(1);
    }
    baseDir = path.dirname(absPath);
    files = [path.basename(absPath)];
  } else if (stat.isDirectory()) {
    baseDir = absPath;
    files = fs.readdirSync(absPath).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      console.error(`Warning: no .json files found in ${absPath}`);
    }
  } else {
    console.error(`Error: reports path is neither a file nor a directory: ${absPath}`);
    process.exit(1);
  }
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(baseDir, f), 'utf8'));
      return { filename: f, data };
    } catch (err) {
      console.error(`Warning: failed to parse ${f}: ${err.message}`);
      return null;
    }
  }).filter(Boolean);
}

function serveStatic(res, urlPath) {
  const publicDir = path.join(__dirname, 'public');
  let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/* ── OpenRouter pricing cache ── */
let pricingCache = null;
let pricingFetchedAt = 0;
const PRICING_TTL = 3600000; // 1 hour

// Canonical provider priority: when multiple OpenRouter entries share a
// short model name (e.g. `claude-opus-4.7` appears under `anthropic/` and
// some hypothetical `github-copilot/` mirror), prefer the provider listed
// first here. These are the providers that actually publish first-party
// pricing and cache rates.
const CANONICAL_PROVIDERS = ['anthropic', 'openai', 'google', 'x-ai', 'meta', 'mistralai', 'qwen', 'deepseek'];

function providerRank(id) {
  const slash = id.indexOf('/');
  if (slash < 0) return Number.MAX_SAFE_INTEGER;
  const provider = id.slice(0, slash);
  const idx = CANONICAL_PROVIDERS.indexOf(provider);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function fetchOpenRouterPricing() {
  return new Promise((resolve, reject) => {
    if (pricingCache && Date.now() - pricingFetchedAt < PRICING_TTL) return resolve(pricingCache);
    https.get('https://openrouter.ai/api/v1/models', res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const models = JSON.parse(body).data || [];
          // First pass: build the full id → pricing map (prompt, completion,
          // and cache rates when provided).
          //
          // OpenRouter publishes prices per-token in USD; multiply by 1e6
          // so the dashboard can compute `tokens/1e6 * rate`. `input_cache_read`
          // and `input_cache_write` are provider-native (e.g. Anthropic's 0.1×
          // / 1.25× multipliers for 5m TTL are already baked in).
          const byId = {};
          for (const m of models) {
            const p = m.pricing || {};
            if (p.prompt === '0' && p.completion === '0') continue;
            const entry = {
              prompt: parseFloat(p.prompt || 0) * 1e6,
              completion: parseFloat(p.completion || 0) * 1e6,
            };
            if (p.input_cache_read) entry.cache_read = parseFloat(p.input_cache_read) * 1e6;
            if (p.input_cache_write) entry.cache_creation = parseFloat(p.input_cache_write) * 1e6;
            byId[m.id] = entry;
          }

          // Second pass: add aliases keyed by the short model name alone so
          // that model identifiers routed through other providers (e.g.
          // `github-copilot/claude-opus-4.7`) still resolve. If two OpenRouter
          // entries share a short name, we keep the one from the most
          // canonical provider.
          const shortNameRanks = new Map();
          for (const id of Object.keys(byId)) {
            const slash = id.indexOf('/');
            if (slash < 0) continue;
            const short = id.slice(slash + 1);
            const rank = providerRank(id);
            const existingRank = shortNameRanks.get(short);
            if (existingRank === undefined || rank < existingRank) {
              shortNameRanks.set(short, rank);
              byId[short] = byId[id];
            }
          }

          pricingCache = byId;
          pricingFetchedAt = Date.now();
          resolve(pricingCache);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function main() {
  const opts = parseArgs();
  const reports = loadReports(opts.reports);
  console.log(`Loaded ${reports.length} report(s) from ${path.resolve(opts.reports)}`);

  // Pre-fetch pricing on startup
  fetchOpenRouterPricing().catch(e => console.warn('Failed to pre-fetch OpenRouter pricing:', e.message));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/pricing') {
      return fetchOpenRouterPricing()
        .then(data => json(res, data))
        .catch(() => { res.writeHead(502); res.end('Failed to fetch pricing'); });
    }
    if (url.pathname === '/api/reports') {
      return json(res, reports.map(r => ({
        filename: r.filename,
        report_type: r.data.report_type,
        period: r.data.period,
        generated_at: r.data.generated_at,
        totals: r.data.totals,
      })));
    }
    if (url.pathname.startsWith('/api/reports/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/reports/'.length));
      const report = reports.find(r => r.filename === name);
      if (!report) { res.writeHead(404); res.end('Report not found'); return; }
      return json(res, report.data);
    }
    // SPA: serve index.html for non-API, non-file routes
    if (!url.pathname.startsWith('/api') && !path.extname(url.pathname)) {
      return serveStatic(res, '/');
    }
    serveStatic(res, url.pathname);
  });

  server.listen(opts.port, () => {
    console.log(`Analytics UI: http://localhost:${opts.port}`);
  });
}

main();
