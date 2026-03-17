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
    if (args[i] === '--reports' && args[i + 1]) opts.reports = args[++i];
    else if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: report-analytics serve --reports <dir> [--port <n>]

Options:
  --reports <dir>  Directory containing report JSON files (required)
  --port <n>       Port to listen on (default: 3000)
  --help           Show this help`);
      process.exit(0);
    }
  }
  // strip "serve" subcommand if present
  if (!opts.reports) {
    console.error('Error: --reports <dir> is required');
    process.exit(1);
  }
  return opts;
}

function loadReports(dir) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) {
    console.error(`Error: reports directory not found: ${absDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(absDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(absDir, f), 'utf8'));
    return { filename: f, data };
  });
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

function fetchOpenRouterPricing() {
  return new Promise((resolve, reject) => {
    if (pricingCache && Date.now() - pricingFetchedAt < PRICING_TTL) return resolve(pricingCache);
    https.get('https://openrouter.ai/api/v1/models', res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const models = JSON.parse(body).data || [];
          pricingCache = models.reduce((acc, m) => {
            const p = m.pricing;
            if (p && (p.prompt !== '0' || p.completion !== '0')) {
              acc[m.id] = { prompt: parseFloat(p.prompt) * 1e6, completion: parseFloat(p.completion) * 1e6 };
            }
            return acc;
          }, {});
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
