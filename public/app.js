'use strict';
/* ── State ── */
let reports = [];
let allReportData = [];
let currentReport = null;
let selectedProvider = null;
let selectedCLIs = null;   // Set<string> or null = all
let charts = {};
let pricing = {};

/* ── Helpers ── */
const $ = s => document.querySelector(s);
const fmt = n => n == null ? '0' : n.toLocaleString();
const fmtM = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
const pct = (a, b) => b ? ((a/b)*100).toFixed(1)+'%' : '0%';
const badgeClass = p => 'badge badge-' + (['github-copilot','openai','google','anthropic'].includes(p) ? p : 'default');

const COLORS = ['#6c5ce7','#74b9ff','#00b894','#e17055','#fdcb6e','#a29bfe','#55efc4','#fab1a0','#81ecec','#ffeaa7','#dfe6e9','#636e72'];

/* ── Multi-CLI palette + helpers ── */
const CLI_COLORS = {
  'opencode':        '#6c5ce7',
  'kiro':            '#00cec9',
  'kiro-ide':        '#81ecec',
  'claude-code':     '#e17055',
  'codex':           '#55efc4',
  'cursor':          '#fd79a8',
  'copilot-cli':     '#fdcb6e',
  'copilot-vscode':  '#74b9ff',
};
const CLI_FALLBACK_PALETTE = ['#a29bfe','#ff7675','#ffeaa7','#badc58','#7ed6df','#e056fd','#f368e0'];
function cliColor(name) {
  if (!name) return '#8b8fa8';
  if (CLI_COLORS[name]) return CLI_COLORS[name];
  // Deterministic fallback
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CLI_FALLBACK_PALETTE[h % CLI_FALLBACK_PALETTE.length];
}
function cliBadge(name) {
  if (!name) return '';
  return `<span class="cli-badge" style="--cli-color:${cliColor(name)}">${name}</span>`;
}

/* Detect if this report has any multi-CLI metadata */
function isMultiTool(r) {
  if (!r) return false;
  if (Array.isArray(r.cli_tool_totals) && r.cli_tool_totals.length) return true;
  if (r.sources && r.sources.tools) return true;
  const probe = (arr) => Array.isArray(arr) && arr.some(x => x && x.cli_tool);
  return probe(r.sessions) || probe(r.usage) || probe(r.warnings) || probe(r.model_totals) || probe(r.tool_totals);
}

/* Return sorted list of CLI names known to this report */
function reportCLIs(r) {
  if (!r) return [];
  const set = new Set();
  if (r.cli_tool_totals) r.cli_tool_totals.forEach(x => x.cli_tool && set.add(x.cli_tool));
  if (r.sources && r.sources.tools) Object.keys(r.sources.tools).forEach(t => set.add(t));
  const probe = (arr) => Array.isArray(arr) && arr.forEach(x => x && x.cli_tool && set.add(x.cli_tool));
  probe(r.sessions); probe(r.usage); probe(r.warnings); probe(r.model_totals); probe(r.tool_totals);
  return [...set].sort();
}

function cliActive(name) {
  if (!selectedCLIs) return true;
  if (name == null) return true; // rows without cli_tool pass through
  return selectedCLIs.has(name);
}

function destroyCharts() { Object.values(charts).forEach(c => c.destroy()); charts = {}; }

function updateProviderDropdown() {
  const sel = $('#provider-select');
  const providers = [...new Set((currentReport?.model_totals || []).map(m => m.provider))].sort();
  sel.innerHTML = '<option value="">All Providers</option>' + providers.map(p => `<option value="${p}"${p === selectedProvider ? ' selected' : ''}>${p}</option>`).join('');
  sel.onchange = () => { selectedProvider = sel.value || null; route(); };
}

/* ── CLI filter UI ── */
function updateCLIFilter() {
  const wrap = document.getElementById('cli-filter');
  if (!wrap) return;
  const clis = reportCLIs(currentReport);
  if (!clis.length || !isMultiTool(currentReport)) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  renderCLIFilterMenu(clis);
  updateCLIFilterLabel(clis);
}

function renderCLIFilterMenu(clis) {
  const menu = document.getElementById('cli-filter-menu');
  const cliTotals = {};
  (currentReport?.cli_tool_totals || []).forEach(c => { cliTotals[c.cli_tool] = c; });
  const srcCounts = currentReport?.sources?.tools || {};
  const active = selectedCLIs || new Set(clis);
  menu.innerHTML = `
    <div class="cli-filter-head">
      <span>Filter CLIs</span>
      <button type="button" data-act="all">All</button>
    </div>
    ${clis.map(c => {
      const t = cliTotals[c];
      const tok = t ? fmtM((t.input_tokens||0) + (t.output_tokens||0)) : (srcCounts[c] ? fmt(srcCounts[c]) + ' msgs' : '');
      return `<label class="cli-filter-item" data-cli="${c}">
        <input type="checkbox" ${active.has(c) ? 'checked' : ''}>
        <span class="cli-dot" style="background:${cliColor(c)}"></span>
        <span>${c}</span>
        <span class="cli-count">${tok}</span>
      </label>`;
    }).join('')}
  `;
  menu.querySelector('[data-act="all"]').onclick = () => {
    selectedCLIs = null;
    menu.querySelectorAll('input').forEach(cb => cb.checked = true);
    updateCLIFilterLabel(clis); route();
  };
  menu.querySelectorAll('.cli-filter-item').forEach(el => {
    el.addEventListener('change', () => {
      const checked = [...menu.querySelectorAll('.cli-filter-item')].filter(x => x.querySelector('input').checked).map(x => x.dataset.cli);
      selectedCLIs = (checked.length === clis.length) ? null : new Set(checked);
      updateCLIFilterLabel(clis); route();
    });
  });
}

function updateCLIFilterLabel(clis) {
  const countEl = document.getElementById('cli-filter-count');
  if (!countEl) return;
  const active = selectedCLIs ? selectedCLIs.size : clis.length;
  countEl.textContent = `${active}/${clis.length}`;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('#cli-filter-btn');
  const menu = document.getElementById('cli-filter-menu');
  if (btn) {
    menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', menu.classList.contains('open'));
    e.stopPropagation();
  } else if (menu && menu.classList.contains('open') && !e.target.closest('#cli-filter-menu')) {
    menu.classList.remove('open');
  }
});

/* ── Sources footer ── */
function updateSourcesFooter() {
  const el = document.getElementById('sources-footer');
  if (!el) return;
  const s = currentReport?.sources?.tools;
  if (!s || !Object.keys(s).length) { el.style.display = 'none'; return; }
  const pills = Object.entries(s)
    .sort((a,b) => b[1] - a[1])
    .map(([k,v]) => `<span class="source-pill" style="--cli-color:${cliColor(k)}"><span class="cli-dot"></span>${k} <b>${fmt(v)}</b></span>`)
    .join('');
  el.style.display = '';
  el.innerHTML = `<span class="sources-label">Sources</span>${pills}<span style="opacity:0.6">records ingested per CLI</span>`;
}

function getFilteredReport() {
  let r = currentReport;
  if (!r) return r;

  // ── CLI filter ──
  if (selectedCLIs && isMultiTool(r)) {
    const keep = x => !x || !x.cli_tool || selectedCLIs.has(x.cli_tool);
    const fSessions = r.sessions ? r.sessions.filter(keep) : r.sessions;
    const fUsage = r.usage ? r.usage.filter(keep) : r.usage;
    const fWarnings = r.warnings ? r.warnings.filter(keep) : r.warnings;
    const fCliTotals = r.cli_tool_totals ? r.cli_tool_totals.filter(keep) : r.cli_tool_totals;

    // For model_totals/tool_totals: if rows carry cli_tool (per-tool format) we can filter.
    // If they don't (combined format), pass through — they're pre-merged across all CLIs and
    // cannot be split without re-aggregation. In that case recompute a reasonable totals from cli_tool_totals.
    const rowHasCli = Array.isArray(r.model_totals) && r.model_totals.some(m => m && m.cli_tool);
    const fModelTotals = rowHasCli ? r.model_totals.filter(keep) : r.model_totals;
    const toolHasCli = Array.isArray(r.tool_totals) && r.tool_totals.some(t => t && t.cli_tool);
    const fToolTotals = toolHasCli ? r.tool_totals.filter(keep) : r.tool_totals;

    // Recompute top-level totals from filtered cli_tool_totals when available
    let fTotals = r.totals;
    if (fCliTotals) {
      const keys = ['input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens','estimated_tokens','tool_input_tokens','human_input_tokens','requests'];
      fTotals = {};
      keys.forEach(k => fTotals[k] = 0);
      fCliTotals.forEach(c => keys.forEach(k => fTotals[k] += (c[k] || 0)));
    }

    r = { ...r, totals: fTotals, sessions: fSessions, usage: fUsage, warnings: fWarnings,
          cli_tool_totals: fCliTotals, model_totals: fModelTotals, tool_totals: fToolTotals };
  }

  // ── Provider filter (pre-existing) ──
  if (!selectedProvider) return r;
  const p = selectedProvider;
  const modelTotals = (r.model_totals || []).filter(m => m.provider === p);
  const totals = { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 };
  modelTotals.forEach(m => { for (const k in totals) totals[k] += m[k] || 0; });
  const usage = r.usage?.filter(u => u.provider === p);
  const sessions = r.sessions?.filter(s => s.provider === p);
  const toolMap = {};
  const addTools = (src) => { if (!src) return; src.forEach(u => { if (!u.tools) return; Object.entries(u.tools).forEach(([t, v]) => { if (!toolMap[t]) toolMap[t] = { tool: t, calls: 0, input_tokens: 0, output_tokens: 0 }; if (typeof v === 'object') { toolMap[t].calls += v.calls || 0; toolMap[t].input_tokens += v.input_tokens || 0; } }); }); };
  addTools(usage);
  if (!usage?.length && sessions?.length) {
    (r.tool_totals || []).forEach(t => { toolMap[t.tool] = { ...t }; });
  }
  const toolTotals = Object.values(toolMap).sort((a, b) => b.input_tokens - a.input_tokens);
  return { ...r, totals, model_totals: modelTotals, tool_totals: toolTotals.length ? toolTotals : r.tool_totals, usage, sessions, warnings: r.warnings };
}

Chart.defaults.color = '#8b8fa8';
Chart.defaults.borderColor = '#2e3348';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
Chart.defaults.font.size = 11;

/* ── Merge reports ── */
function mergeReports(reportDataList) {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 };
  const modelMap = {};
  const toolMap = {};
  const cliMap = {};
  const sourcesTools = {};
  const allUsage = [];
  const allSessions = [];
  const allWarnings = [];
  let minStart = null, maxEnd = null, maxDays = 0;
  let anyMultiTool = false;

  reportDataList.forEach(r => {
    if (isMultiTool(r)) anyMultiTool = true;
    Object.keys(totals).forEach(k => totals[k] += (r.totals?.[k] || 0));

    if (r.period) {
      if (!minStart || r.period.start < minStart) minStart = r.period.start;
      if (!maxEnd || r.period.end > maxEnd) maxEnd = r.period.end;
      if (r.period.days > maxDays) maxDays = r.period.days;
    }

    // model_totals — keyed by (cli_tool, provider, model) so the CLI filter
    // can still narrow rows in the merged "All Reports" view. Rows without
    // a cli_tool (legacy reports) collapse into a single 'unknown' bucket.
    (r.model_totals || []).forEach(m => {
      const cli = m.cli_tool || null;
      const key = (cli || '') + '|' + m.provider + '|' + m.model;
      if (!modelMap[key]) modelMap[key] = { cli_tool: cli, provider: m.provider, model: m.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 };
      ['input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens','estimated_tokens','tool_input_tokens','human_input_tokens','requests'].forEach(k => modelMap[key][k] += m[k] || 0);
    });

    (r.tool_totals || []).forEach(t => {
      const cli = t.cli_tool || null;
      const key = (cli || '') + '|' + t.tool;
      if (!toolMap[key]) toolMap[key] = { cli_tool: cli, tool: t.tool, calls: 0, input_tokens: 0, output_tokens: 0 };
      toolMap[key].calls += t.calls || 0;
      toolMap[key].input_tokens += t.input_tokens || 0;
      toolMap[key].output_tokens += t.output_tokens || 0;
    });

    // cli_tool_totals
    (r.cli_tool_totals || []).forEach(c => {
      const k = c.cli_tool; if (!k) return;
      if (!cliMap[k]) cliMap[k] = { cli_tool: k, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, tool_output_tokens: 0, human_input_tokens: 0, requests: 0, sessions: 0, tool_calls: 0 };
      ['input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens','estimated_tokens','tool_input_tokens','tool_output_tokens','human_input_tokens','requests','sessions','tool_calls'].forEach(kk => cliMap[k][kk] += c[kk] || 0);
    });

    if (r.sources && r.sources.tools) {
      Object.entries(r.sources.tools).forEach(([k, v]) => { sourcesTools[k] = (sourcesTools[k] || 0) + (v || 0); });
    }

    if (r.usage) allUsage.push(...r.usage);
    if (r.sessions) allSessions.push(...r.sessions);
    if (r.warnings) allWarnings.push(...r.warnings);
  });

  const days = maxDays || (minStart && maxEnd ? Math.ceil((new Date(maxEnd) - new Date(minStart)) / 86400000) : 0);

  const billable = x => (x.input_tokens||0) + (x.output_tokens||0) + (x.cache_read_tokens||0) + (x.cache_creation_tokens||0);
  return {
    report_type: 'combined',
    period: { start: minStart, end: maxEnd, days },
    generated_at: new Date().toISOString(),
    totals,
    sources: anyMultiTool ? { tools: sourcesTools } : undefined,
    cli_tool_totals: Object.keys(cliMap).length ? Object.values(cliMap).sort((a,b) => billable(b) - billable(a)) : undefined,
    model_totals: Object.values(modelMap).sort((a,b) => billable(b) - billable(a)),
    tool_totals: Object.values(toolMap).sort((a,b) => b.input_tokens - a.input_tokens),
    usage: allUsage.length ? allUsage : undefined,
    sessions: allSessions.length ? allSessions : undefined,
    warnings: allWarnings.length ? allWarnings : undefined,
  };
}

/* ── Data loading ── */
async function loadReports() {
  const [reportsRes, pricingRes] = await Promise.all([
    fetch('/api/reports'),
    fetch('/api/pricing').catch(() => null),
  ]);
  reports = await reportsRes.json();
  if (pricingRes && pricingRes.ok) pricing = await pricingRes.json();
  const sel = $('#report-select');

  // Load all full report data for merging
  allReportData = await Promise.all(reports.map(async r => {
    const resp = await fetch(`/api/reports/${encodeURIComponent(r.filename)}`);
    return resp.json();
  }));

  let options = '';
  options += '<option value="__combined__">All Reports (Combined)</option>';
  options += reports.map(r => `<option value="${r.filename}">${r.filename} (${r.report_type}, ${r.period.days}d)</option>`).join('');
  sel.innerHTML = options;
  sel.onchange = () => selectReport(sel.value);

  if (reports.length) {
    const merged = mergeReports(allReportData);
    merged._developer_count = allReportData.length;
    selectReportDirect(merged);
  }
}

function selectReportDirect(data) {
  currentReport = data;
  const navFiles = document.getElementById('nav-files');
  if (navFiles) navFiles.style.display = data.file_stats ? '' : 'none';
  // Reset CLI filter when swapping reports
  selectedCLIs = null;
  updateProviderDropdown();
  updateCLIFilter();
  updateSourcesFooter();
  route();
}

async function selectReport(filename) {
  if (filename === '__combined__') {
    const merged = mergeReports(allReportData);
    // Track how many individual reports (developers) contributed to this view
    // so per-developer metrics (e.g. avg active hours on the Timeline page)
    // can divide correctly.
    merged._developer_count = allReportData.length;
    selectReportDirect(merged);
    return;
  }
  const idx = reports.findIndex(r => r.filename === filename);
  if (idx >= 0) {
    const single = { ...allReportData[idx], _developer_count: 1 };
    selectReportDirect(single);
  }
}

/* ── Router ── */
function route() {
  if (!currentReport) return;
  destroyCharts();
  const hash = location.hash || '#/';
  const page = hash.replace('#/', '') || 'dashboard';
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === (page || 'dashboard')));
  const pages = { dashboard: renderDashboard, models: renderModels, tools: renderTools, timeline: renderTimeline, sessions: renderSessions, warnings: renderWarnings, files: renderFiles };
  (pages[page] || pages.dashboard)();
}

window.addEventListener('hashchange', route);

/* ── Format token cost estimate ── */
//
// Pricing is keyed by model identifier. The server publishes three flavours
// of keys in the same map:
//   1. Full OpenRouter id    e.g. "anthropic/claude-opus-4.7"
//   2. Short model name      e.g. "claude-opus-4.7"  (alias → canonical)
//   3. Short name with known provider prefix fallback (for lookups below)
//
// This means models routed through a non-first-party provider (e.g.
// `github-copilot/claude-opus-4.7`, `amazon-bedrock/anthropic.claude-opus-4-7`)
// resolve to the same underlying Anthropic pricing.
// Known vendor-registry prefixes used by Bedrock and similar routers, which
// embed the canonical model id as `vendor.modelname` or `region.vendor.modelname`.
// We only strip these when they appear as a leading dot-segment — do NOT
// split on every '.' or we'd mangle real model names like `claude-opus-4.6`
// or `moonshotai.kimi-k2.5` into single-digit suffixes.
const VENDOR_PREFIXES = new Set([
  'anthropic', 'amazon', 'meta', 'cohere', 'mistral', 'mistralai', 'ai21',
  'stability', 'openai', 'google', 'xai', 'x-ai', 'deepseek', 'qwen',
  'global', 'us', 'eu', 'apac', // Bedrock region/scope prefixes
]);

function normalizeModelName(model) {
  if (!model) return null;
  // Strip any provider-level prefix.
  let short = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  // Peel off leading vendor/region dot-segments one at a time.
  while (short.includes('.')) {
    const first = short.slice(0, short.indexOf('.'));
    if (!VENDOR_PREFIXES.has(first.toLowerCase())) break;
    short = short.slice(first.length + 1);
  }
  return short;
}

function findPricing(model) {
  if (!model) return null;

  // Helper: reject entries that are only placeholders. OpenRouter uses
  // `prompt: "-1"` for variable-pricing aggregator models like
  // `openrouter/auto` — these will happily match our short-name fallback
  // and produce nonsense negative costs otherwise.
  const usable = p => p && p.prompt >= 0 && p.completion >= 0;

  if (usable(pricing[model])) return pricing[model];

  const short = normalizeModelName(model);
  if (short && usable(pricing[short])) return pricing[short];

  // Try swapping dash-based version separators for dots, since Bedrock IDs
  // use `claude-opus-4-7` while OpenRouter uses `claude-opus-4.7`.
  if (short) {
    const dotted = short.replace(/-(\d+)-(\d+)$/g, '-$1.$2');
    if (dotted !== short && usable(pricing[dotted])) return pricing[dotted];
  }

  // Last-ditch: look for any key ending with `/short`. Require the short
  // name to look like a real model id (alphanumeric with separators), not
  // a single-digit or placeholder fragment.
  if (short && /[a-z]/i.test(short) && short.length >= 4) {
    const k = Object.keys(pricing).find(pk => (pk === short || pk.endsWith('/' + short)) && usable(pricing[pk]));
    if (k) return pricing[k];
  }
  return null;
}

// Fallback cache-rate multipliers when a model's OpenRouter entry doesn't
// publish `input_cache_read` / `input_cache_write`. Applied as ratios of the
// base `prompt` price. Matches published provider pricing:
//   • Anthropic (Claude): read 0.1×, creation 1.25× (5m TTL)
//   • OpenAI:             cached input ~0.5× (GPT-5 family)
//   • Google (Gemini):    cached input ~0.25×
function cacheFallbackMultipliers(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return { read: 0.5, creation: 1.0 };
  if (m.includes('gemini')) return { read: 0.25, creation: 1.0 };
  return { read: 0.1, creation: 1.25 }; // Anthropic default
}

function estimateCost(inputTokens, outputTokens, model, cacheReadTokens = 0, cacheCreationTokens = 0) {
  const r = findPricing(model);
  if (!r) return null;
  let cost = (inputTokens / 1e6) * r.prompt + (outputTokens / 1e6) * r.completion;

  if (cacheReadTokens || cacheCreationTokens) {
    const fb = cacheFallbackMultipliers(model);
    const readRate = r.cache_read != null ? r.cache_read : r.prompt * fb.read;
    const creationRate = r.cache_creation != null ? r.cache_creation : r.prompt * fb.creation;
    cost += (cacheReadTokens / 1e6) * readRate + (cacheCreationTokens / 1e6) * creationRate;
  }

  return cost;
}

/* ── Totals row helper ── */
function totalsRow(cols) {
  return `<tr style="font-weight:700;border-top:2px solid var(--accent)">${cols.map(c => `<td class="${c.cls||''}">${c.v}</td>`).join('')}</tr>`;
}

/* ── Coverage banner ──
   Some CLIs rotate/purge their local history (Kiro CLI keeps only the last
   couple of weeks, Cursor trims long-running composer state, etc.). The
   orchestrator emits `data_availability` warnings when any CLI's earliest
   record is significantly newer than the requested period; this banner
   surfaces that at the top of the dashboard so totals aren't silently
   misleading. */
function renderCoverageBanner(r) {
  const gaps = (r.warnings || []).filter(w => w.type === 'data_availability' && (!selectedCLIs || selectedCLIs.has(w.cli_tool)));
  if (!gaps.length) return '';

  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const items = gaps.map(g => {
    const cli = g.cli_tool || 'unknown';
    const earliest = fmtDate(g.earliest_record);
    const latest = fmtDate(g.latest_record);
    const periodStart = fmtDate(g.period_start);
    return `<li><span class="cb-tool" style="color:${cliColor(cli)}">${cli}</span>: only covers <span class="cb-range">${earliest} → ${latest}</span> (requested period starts ${periodStart}).</li>`;
  }).join('');

  return `
    <div class="coverage-banner">
      <div class="cb-icon">⏱</div>
      <div>
        <div class="cb-title">Limited data coverage for some CLIs</div>
        <div class="cb-body">
          No records found for the start of the requested period for these tools — either they weren't in use yet, or their local history was rotated/purged. Totals below reflect only what's still on disk.
          <ul>${items}</ul>
        </div>
      </div>
    </div>`;
}

/* ── Dashboard Page ── */
function renderDashboard() {
  const r = getFilteredReport();
  const t = r.totals;
  // Total billable tokens = fresh input + output + cache reads + cache writes.
  // Each bucket is priced differently but they all contribute to usage
  // numbers, so summing gives the "raw token volume you paid for" figure.
  const cacheRead = t.cache_read_tokens || 0;
  const cacheCreation = t.cache_creation_tokens || 0;
  const cacheTotal = cacheRead + cacheCreation;
  const totalTokens = t.input_tokens + t.output_tokens + cacheRead + cacheCreation;
  const avgPerReq = t.requests ? Math.round(totalTokens / t.requests) : 0;
  const toolPct = t.input_tokens ? ((t.tool_input_tokens / t.input_tokens) * 100).toFixed(1) : 0;

  // Cache hit rate — the fraction of input-side tokens served from cache.
  // cache_read is billed at ~10% of input price, so a high hit rate means
  // your effective cost is far below the nominal prompt rate. Cache writes
  // (creation) are the "cost of seeding" — premium-priced context the
  // next turn can read cheaply.
  const totalInputSide = t.input_tokens + cacheRead + cacheCreation;
  const cacheHitPct = totalInputSide ? ((cacheRead / totalInputSide) * 100).toFixed(1) : '0';
  const cachePct = totalTokens ? ((cacheTotal / totalTokens) * 100).toFixed(1) : '0';

  let totalCost = 0;
  (r.model_totals || []).forEach(m => {
    const c = estimateCost(
      m.input_tokens, m.output_tokens, m.model,
      m.cache_read_tokens || 0, m.cache_creation_tokens || 0,
    );
    if (c) totalCost += c;
  });

  const deadContextTypes = new Set(['duplicate_reads', 'superseded_writes', 'errored_tool_inputs', 'read_then_small_edit', 'inefficient_reads', 'unbounded_bash', 'excessive_full_reads', 'expensive_full_reads']);
  const deadWarnings = (r.warnings || []).filter(w => deadContextTypes.has(w.type));
  const deadSessions = new Set(deadWarnings.map(w => w.session_id).filter(Boolean)).size;

  const app = $('#app');
  app.innerHTML = `
    ${renderCoverageBanner(r)}
    ${renderCLISummary(r)}
    <div class="cards">
      <div class="card"><div class="card-label">Total Tokens</div><div class="card-value accent">${fmtM(totalTokens)}</div><div class="card-sub">${fmt(t.input_tokens)} in / ${fmt(t.output_tokens)} out</div></div>
      <div class="card"><div class="card-label">Requests</div><div class="card-value blue">${fmt(t.requests)}</div><div class="card-sub">~${fmt(avgPerReq)} tokens/req</div></div>
      <div class="card"><div class="card-label">Cache Tokens</div><div class="card-value" style="color:#00cec9">${fmtM(cacheTotal)}</div><div class="card-sub">${fmtM(cacheRead)} read · ${fmtM(cacheCreation)} write</div></div>
      <div class="card"><div class="card-label">Cache Hit Rate</div><div class="card-value" style="color:#00cec9">${cacheHitPct}%</div><div class="card-sub">${cacheHitPct}% of input from cache · billed at ~10%</div></div>
      <div class="card"><div class="card-label">Tool Tokens</div><div class="card-value green">${fmtM(t.tool_input_tokens)}</div><div class="card-sub">${toolPct}% of input</div></div>
      <div class="card"><div class="card-label">Human Input</div><div class="card-value">${fmtM(t.human_input_tokens || 0)}</div><div class="card-sub">${pct(t.human_input_tokens || 0, t.input_tokens)} of input</div></div>
      <div class="card"><div class="card-label">Est. API Cost</div><div class="card-value yellow">${totalCost > 0 ? '$'+totalCost.toFixed(2) : 'N/A'}</div><div class="card-sub">Input + output + cache-weighted</div></div>
      <div class="card"><div class="card-label">Dead Context</div><div class="card-value" style="color:${deadWarnings.length ? 'var(--red)' : 'var(--green)'}">${deadWarnings.length}</div><div class="card-sub">${deadSessions} sessions · <a href="#/warnings" style="color:var(--accent2)">details →</a></div></div>
      <div class="card"><div class="card-label">Estimated Tokens</div><div class="card-value">${fmtM(t.estimated_tokens)}</div><div class="card-sub">${pct(t.estimated_tokens, totalTokens)} of total (not API-reported)</div></div>
      <div class="card"><div class="card-label">Period</div><div class="card-value" style="font-size:1.1rem">${r.period.days}d</div><div class="card-sub">${new Date(r.period.start).toLocaleDateString()} – ${new Date(r.period.end).toLocaleDateString()}</div></div>
    </div>
    ${(r.warnings && r.warnings.length) ? `<div class="chart-box" style="margin-bottom:1.5rem"><h3>⚠ Warnings (${r.warnings.length})</h3>${r.warnings.slice(0,5).map(w => `<div class="warning-item ${w.severity}" style="margin-top:0.5rem"><div class="warning-type">${w.type.replace(/_/g,' ')}</div><div class="warning-detail">${w.detail}</div></div>`).join('')}${r.warnings.length > 5 ? `<p style="margin-top:0.75rem;font-size:0.85rem"><a href="#/warnings" style="color:var(--accent2)">View all ${r.warnings.length} warnings →</a></p>` : ''}</div>` : ''}
    <div class="chart-grid">
      <div class="chart-box full"><h3>Token Usage Over Time</h3><div class="chart-wrap tall"><canvas id="ch-timeline"></canvas></div></div>
      <div class="chart-box"><h3>Tokens by Provider</h3><div class="chart-wrap"><canvas id="ch-provider-pie"></canvas></div></div>
      <div class="chart-box"><h3>Requests by Provider</h3><div class="chart-wrap"><canvas id="ch-req-pie"></canvas></div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Top 10 Tools by Token Usage</h3><div class="chart-wrap"><canvas id="ch-tools-bar"></canvas></div></div>
      <div class="chart-box"><h3>Top 10 Tools by Call Count</h3><div class="chart-wrap"><canvas id="ch-tools-calls"></canvas></div></div>
    </div>`;

  renderDashboardCharts(r);
  renderCLISummaryChart(r);
}

/* ── CLI summary card (dashboard) ── */
function renderCLISummary(r) {
  const totals = r.cli_tool_totals;
  if (!totals || !totals.length) return '';
  // Rank and display by true billable volume: input + output + cache reads +
  // cache writes. Cached tokens dominate for heavy Claude users (~99% of
  // request input for cache-hit turns) so leaving them out made the list
  // ordering and headline numbers badly misleading.
  const billable = c => (c.input_tokens||0) + (c.output_tokens||0) + (c.cache_read_tokens||0) + (c.cache_creation_tokens||0);
  const sorted = [...totals].sort((a,b) => billable(b) - billable(a));
  const rows = sorted.map(c => {
    const total = billable(c);
    const cacheTotal = (c.cache_read_tokens||0) + (c.cache_creation_tokens||0);
    const dim = selectedCLIs && !selectedCLIs.has(c.cli_tool) ? ' dimmed' : '';
    const cacheLine = cacheTotal > 0
      ? `<div class="cli-io">${fmtM(c.input_tokens||0)} in · ${fmtM(c.output_tokens||0)} out · ${fmtM(cacheTotal)} cache</div>`
      : `<div class="cli-io">${fmtM(c.input_tokens||0)} in · ${fmtM(c.output_tokens||0)} out</div>`;
    return `<div class="cli-row${dim}" style="--cli-color:${cliColor(c.cli_tool)}">
      <span class="cli-swatch"></span>
      <div class="cli-info">
        <div class="cli-name">${c.cli_tool}</div>
        <div class="cli-meta">${fmt(c.requests)} req · ${fmt(c.sessions)} sessions · ${fmt(c.tool_calls)} tool calls</div>
      </div>
      <div class="cli-numbers">
        <div class="cli-tokens">${fmtM(total)}</div>
        ${cacheLine}
      </div>
    </div>`;
  }).join('');
  return `<section class="cli-summary">
    <div class="cli-summary-head">
      <h3>CLIs in this report</h3>
      <span class="cli-summary-sub">${sorted.length} source${sorted.length === 1 ? '' : 's'} · click filter above to narrow</span>
    </div>
    <div class="cli-summary-grid">
      <div class="cli-summary-list">${rows}</div>
      <div class="cli-summary-chart"><canvas id="ch-cli-summary"></canvas></div>
    </div>
  </section>`;
}

function renderCLISummaryChart(r) {
  const totals = r.cli_tool_totals;
  if (!totals || !totals.length) return;
  const el = document.getElementById('ch-cli-summary');
  if (!el) return;
  const billable = c => (c.input_tokens||0) + (c.output_tokens||0) + (c.cache_read_tokens||0) + (c.cache_creation_tokens||0);
  const sorted = [...totals].sort((a,b) => billable(b) - billable(a));
  const labels = sorted.map(c => c.cli_tool);
  const anyCache = sorted.some(c => (c.cache_read_tokens||0) + (c.cache_creation_tokens||0) > 0);
  const datasets = anyCache
    ? [
        { label: 'Input',  data: sorted.map(c => c.input_tokens || 0),           backgroundColor: sorted.map(c => cliColor(c.cli_tool)),          stack: 's' },
        { label: 'Output', data: sorted.map(c => c.output_tokens || 0),          backgroundColor: sorted.map(c => cliColor(c.cli_tool) + 'cc'), stack: 's' },
        { label: 'Cache read',  data: sorted.map(c => c.cache_read_tokens || 0),     backgroundColor: sorted.map(c => cliColor(c.cli_tool) + '88'), stack: 's' },
        { label: 'Cache write', data: sorted.map(c => c.cache_creation_tokens || 0), backgroundColor: sorted.map(c => cliColor(c.cli_tool) + '55'), stack: 's' },
      ]
    : [
        { label: 'Input',  data: sorted.map(c => c.input_tokens || 0),  backgroundColor: sorted.map(c => cliColor(c.cli_tool)), stack: 's' },
        { label: 'Output', data: sorted.map(c => c.output_tokens || 0), backgroundColor: sorted.map(c => cliColor(c.cli_tool) + '88'), stack: 's' },
      ];
  charts.cliSummary = new Chart(el, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 10 } } },
      scales: { x: { stacked: true, ticks: { callback: v => fmtM(v) } }, y: { stacked: true } },
    },
  });
}

function renderDashboardCharts(r) {
  if (r.usage && r.usage.length) {
    // Hourly timeline — split by CLI tool if the report carries cli_tool on
    // usage rows (per-tool or combined format). Each hour bar is a stacked
    // bar with one segment per CLI, sized by that CLI's total tokens
    // (input + output) for that hour. This lets you see at a glance when
    // multiple tools were used in the same hour and which one dominated.
    // Hourly timeline — split by CLI tool if the report carries cli_tool on
    // usage rows (per-tool or combined format). Each hour bar is a stacked
    // bar with one segment per CLI, sized by that CLI's total billable
    // tokens (input + output + cache read + cache write) for that hour.
    // This lets you see at a glance when multiple tools were used in the
    // same hour and which one dominated.
    const hasCliTool = r.usage.some(u => u.cli_tool);
    const billable = u => u.input_tokens + u.output_tokens + (u.cache_read_tokens || 0) + (u.cache_creation_tokens || 0);

    const hourly = {};        // hourKey -> Map<cliOrLabel, tokens>
    const seenKeys = new Set();
    r.usage.forEach(u => {
      const h = u.hour;
      if (!hourly[h]) hourly[h] = new Map();
      if (hasCliTool) {
        const key = u.cli_tool || 'unknown';
        hourly[h].set(key, (hourly[h].get(key) || 0) + billable(u));
        seenKeys.add(key);
      } else {
        hourly[h].set('Input', (hourly[h].get('Input') || 0) + u.input_tokens);
        hourly[h].set('Output', (hourly[h].get('Output') || 0) + u.output_tokens);
        const cr = u.cache_read_tokens || 0;
        const cw = u.cache_creation_tokens || 0;
        if (cr) { hourly[h].set('Cache read', (hourly[h].get('Cache read') || 0) + cr); seenKeys.add('Cache read'); }
        if (cw) { hourly[h].set('Cache write', (hourly[h].get('Cache write') || 0) + cw); seenKeys.add('Cache write'); }
        seenKeys.add('Input'); seenKeys.add('Output');
      }
    });

    // Fill missing days with zero bars so the chart always spans the period.
    if (r.period) {
      const start = new Date(r.period.start); start.setUTCHours(0,0,0,0);
      const end = new Date(r.period.end); end.setUTCHours(0,0,0,0);
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const dayKey = d.toISOString().slice(0, 10);
        const hasDayData = Object.keys(hourly).some(h => h.startsWith(dayKey));
        if (!hasDayData) hourly[dayKey + 'T00:00:00Z'] = new Map();
      }
    }
    const hours = Object.keys(hourly).sort();
    const keys = [...seenKeys].sort();

    const NON_CLI_COLORS = {
      'Input': '#6c5ce7',
      'Output': '#00b894',
      'Cache read': '#00cec9',
      'Cache write': '#81ecec',
    };
    const datasets = keys.map(k => {
      const color = hasCliTool ? cliColor(k) : (NON_CLI_COLORS[k] || '#a29bfe');
      return {
        label: k,
        data: hours.map(h => hourly[h].get(k) || 0),
        backgroundColor: color,
        stack: 's',
      };
    });

    charts.timeline = new Chart($('#ch-timeline'), {
      type: 'bar', data: {
        labels: hours.map(h => { const d = new Date(h); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}) + ' ' + d.getHours() + ':00'; }),
        datasets,
      }, options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          tooltip: hasCliTool ? {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} tokens`,
            },
          } : {},
        },
        scales: { x: { stacked: true, ticks: { maxTicksLimit: 20, maxRotation: 45 } }, y: { stacked: true, ticks: { callback: v => fmtM(v) } } },
      },
    });
  }

  const providerAgg = {};
  (r.model_totals || []).forEach(m => {
    if (!providerAgg[m.provider]) providerAgg[m.provider] = { tokens: 0, requests: 0 };
    providerAgg[m.provider].tokens += m.input_tokens + m.output_tokens;
    providerAgg[m.provider].requests += m.requests;
  });
  const providers = Object.keys(providerAgg).sort((a,b) => providerAgg[b].tokens - providerAgg[a].tokens);

  charts.provPie = new Chart($('#ch-provider-pie'), {
    type: 'doughnut', data: { labels: providers, datasets: [{ data: providers.map(p => providerAgg[p].tokens), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
  charts.reqPie = new Chart($('#ch-req-pie'), {
    type: 'doughnut', data: { labels: providers, datasets: [{ data: providers.map(p => providerAgg[p].requests), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });

  const tools = (r.tool_totals || []).slice(0, 10);
  charts.toolsBar = new Chart($('#ch-tools-bar'), {
    type: 'bar', data: { labels: tools.map(t=>t.tool), datasets: [{ label: 'Tokens', data: tools.map(t=>t.input_tokens), backgroundColor: '#74b9ff' }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: v => fmtM(v) } } } }
  });
  charts.toolsCalls = new Chart($('#ch-tools-calls'), {
    type: 'bar', data: { labels: tools.map(t=>t.tool), datasets: [{ label: 'Calls', data: tools.map(t=>t.calls), backgroundColor: '#fdcb6e' }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

/* ── Models Page ── */
function renderModels() {
  const r = getFilteredReport();
  // Rank by full billable volume (includes cache). The dashboard and other
  // pages all sort the same way so the "most-used model" story stays
  // consistent — cached-context models would otherwise drop to the bottom
  // because their fresh input is tiny.
  const billable = m => (m.input_tokens||0) + (m.output_tokens||0) + (m.cache_read_tokens||0) + (m.cache_creation_tokens||0);
  const models = (r.model_totals || []).sort((a,b) => billable(b) - billable(a));
  const modelsHasCli = models.some(m => m.cli_tool);

  // Compute totals for footer
  const tIn = models.reduce((s,m) => s+m.input_tokens, 0);
  const tOut = models.reduce((s,m) => s+m.output_tokens, 0);
  const tCacheRead = models.reduce((s,m) => s+(m.cache_read_tokens||0), 0);
  const tCacheCreate = models.reduce((s,m) => s+(m.cache_creation_tokens||0), 0);
  const tTotal = tIn + tOut + tCacheRead + tCacheCreate;
  const tTool = models.reduce((s,m) => s+m.tool_input_tokens, 0);
  const tReqs = models.reduce((s,m) => s+m.requests, 0);
  const tAvg = tReqs ? Math.round(tTotal / tReqs) : 0;
  const tRatio = tIn ? (tOut / tIn * 100).toFixed(1) : '0';
  const tTotalInputSide = tIn + tCacheRead + tCacheCreate;
  const tCachePct = tTotalInputSide ? (tCacheRead / tTotalInputSide * 100).toFixed(1) : '0';
  let tCost = 0;
  models.forEach(m => {
    const c = estimateCost(m.input_tokens, m.output_tokens, m.model, m.cache_read_tokens || 0, m.cache_creation_tokens || 0);
    if (c) tCost += c;
  });

  let tableRows = models.map(m => {
    const cacheRead = m.cache_read_tokens || 0;
    const cacheWrite = m.cache_creation_tokens || 0;
    const total = m.input_tokens + m.output_tokens + cacheRead + cacheWrite;
    const cost = estimateCost(m.input_tokens, m.output_tokens, m.model, cacheRead, cacheWrite);
    const rate = findPricing(m.model);
    const ioRatio = m.input_tokens ? (m.output_tokens / m.input_tokens * 100).toFixed(1) : '0';
    const avgPerReq = m.requests ? Math.round(total / m.requests) : 0;
    const inputSide = m.input_tokens + cacheRead + cacheWrite;
    const cachePct = inputSide ? (cacheRead / inputSide * 100).toFixed(1) : '0';
    return `<tr>
      ${modelsHasCli ? `<td class="cli-cell">${cliBadge(m.cli_tool)}</td>` : ''}
      <td><span class="${badgeClass(m.provider)}">${m.provider}</span></td>
      <td>${m.model}</td>
      <td class="num">${fmt(m.input_tokens)}</td>
      <td class="num">${fmt(m.output_tokens)}</td>
      <td class="num">${fmt(cacheRead)}</td>
      <td class="num">${fmt(cacheWrite)}</td>
      <td class="num">${cachePct}%</td>
      <td class="num">${fmt(total)}</td>
      <td class="num">${fmt(m.tool_input_tokens)}</td>
      <td class="num">${fmt(m.human_input_tokens || 0)}</td>
      <td class="num">${fmt(m.requests)}</td>
      <td class="num">${fmt(avgPerReq)}</td>
      <td class="num">${ioRatio}%</td>
      <td class="num">${rate ? '$'+rate.prompt.toFixed(2) : '—'}</td>
      <td class="num">${rate ? '$'+rate.completion.toFixed(2) : '—'}</td>
      <td class="num">${cost != null ? '$'+cost.toFixed(2) : '—'}</td>
    </tr>`;
  }).join('');

  const tHuman = models.reduce((s,m) => s+(m.human_input_tokens||0), 0);

  tableRows += totalsRow([
    ...(modelsHasCli ? [{v:'',cls:''}] : []),
    {v:'',cls:''},{v:'Total',cls:''},
    {v:fmt(tIn),cls:'num'},{v:fmt(tOut),cls:'num'},
    {v:fmt(tCacheRead),cls:'num'},{v:fmt(tCacheCreate),cls:'num'},
    {v:tCachePct+'%',cls:'num'},
    {v:fmt(tTotal),cls:'num'},
    {v:fmt(tTool),cls:'num'},{v:fmt(tHuman),cls:'num'},{v:fmt(tReqs),cls:'num'},{v:fmt(tAvg),cls:'num'},
    {v:tRatio+'%',cls:'num'},{v:'',cls:'num'},{v:'',cls:'num'},
    {v:tCost>0?'$'+tCost.toFixed(2):'—',cls:'num'},
  ]);

  const grandTotal = tTotal;
  const byTokens = [...models].sort((a,b) => billable(b) - billable(a));
  const byReqs = [...models].sort((a,b) => b.requests - a.requests);

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Total Models</div><div class="card-value accent">${models.length}</div></div>
      <div class="card"><div class="card-label">Providers</div><div class="card-value blue">${new Set(models.map(m=>m.provider)).size}</div></div>
      <div class="card"><div class="card-label">Most Used Model</div><div class="card-value" style="font-size:1rem">${byTokens[0]?.model || '—'}</div><div class="card-sub">${byTokens[0] ? pct(billable(byTokens[0]), grandTotal)+' of tokens' : ''}</div></div>
      <div class="card"><div class="card-label">Most Requests</div><div class="card-value" style="font-size:1rem">${byReqs[0]?.model||'—'}</div><div class="card-sub">${fmt(byReqs[0]?.requests)} requests</div></div>
      <div class="card"><div class="card-label">Cache Hit Rate</div><div class="card-value" style="color:#00cec9">${tCachePct}%</div><div class="card-sub">${fmtM(tCacheRead)} read · ${fmtM(tCacheCreate)} write</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Token Distribution by Model</h3><div class="chart-wrap"><canvas id="ch-model-tokens"></canvas></div></div>
      <div class="chart-box"><h3>Input vs Output by Model</h3><div class="chart-wrap"><canvas id="ch-model-io"></canvas></div></div>
    </div>
    <div class="table-box"><h3>Model Details</h3>
      <table><thead><tr>${modelsHasCli ? '<th>CLI</th>' : ''}<th>Provider</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache Read</th><th class="num">Cache Write</th><th class="num">Cache %</th><th class="num">Total</th><th class="num">Tool Tokens</th><th class="num">Human Input</th><th class="num">Requests</th><th class="num">Avg/Req</th><th class="num">Out/In</th><th class="num">$/1M In</th><th class="num">$/1M Out</th><th class="num">Est. Cost</th></tr></thead>
      <tbody>${tableRows}</tbody></table>
    </div>`;

  const top = byTokens.slice(0, 8);
  charts.modelTokens = new Chart($('#ch-model-tokens'), {
    type: 'doughnut', data: { labels: top.map(m => m.model), datasets: [{ data: top.map(m => billable(m)), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
  charts.modelIO = new Chart($('#ch-model-io'), {
    type: 'bar', data: {
      labels: top.map(m => m.model),
      datasets: [
        { label: 'Input', data: top.map(m => m.input_tokens), backgroundColor: '#6c5ce7', stack: 's' },
        { label: 'Cache Read', data: top.map(m => m.cache_read_tokens || 0), backgroundColor: '#00cec9', stack: 's' },
        { label: 'Cache Write', data: top.map(m => m.cache_creation_tokens || 0), backgroundColor: '#81ecec', stack: 's' },
        { label: 'Output', data: top.map(m => m.output_tokens), backgroundColor: '#00b894', stack: 's' },
      ]
    }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { position: 'top' } } }
  });
}

/* ── Tools Page ── */
function renderTools() {
  const r = getFilteredReport();
  const tools = [...(r.tool_totals || [])].sort((a,b) => b.input_tokens - a.input_tokens);
  const totalToolTokens = tools.reduce((s,t) => s + t.input_tokens, 0);
  const totalCalls = tools.reduce((s,t) => s + t.calls, 0);

  const categories = {};
  tools.forEach(t => {
    let cat = 'other';
    if (['read','write','edit','apply_patch','glob','grep'].includes(t.tool)) cat = 'file-ops';
    else if (t.tool === 'bash') cat = 'execution';
    else if (t.tool.startsWith('chrome-devtools')) cat = 'browser';
    else if (['websearch','webfetch','web-search_brave_web_search','exa_web_search_exa','websearch_web_search_exa','fetch_fetch'].includes(t.tool)) cat = 'web';
    else if (['task','todowrite','skill','skill_use','session_read','question','call_omo_agent','background_output','background_cancel'].includes(t.tool)) cat = 'agent';
    else if (t.tool.startsWith('github_') || t.tool.startsWith('grep_app_')) cat = 'github';
    else if (t.tool.startsWith('context7_')) cat = 'docs';
    else if (t.tool.startsWith('lsp_') || t.tool === 'codesearch' || t.tool.startsWith('ast_')) cat = 'code-intel';
    if (!categories[cat]) categories[cat] = { tokens: 0, calls: 0, tools: 0 };
    categories[cat].tokens += t.input_tokens;
    categories[cat].calls += t.calls;
    categories[cat].tools++;
  });
  const catEntries = Object.entries(categories).sort((a,b) => b[1].tokens - a[1].tokens);

  let tableRows = tools.map(t => {
    const avgPerCall = t.calls ? Math.round(t.input_tokens / t.calls) : 0;
    return `<tr>
      <td>${t.tool}</td>
      <td class="num">${fmt(t.calls)}</td>
      <td class="num">${fmt(t.input_tokens)}</td>
      <td class="num">${fmt(avgPerCall)}</td>
      <td class="num">${pct(t.input_tokens, totalToolTokens)}</td>
      <td class="num">${pct(t.calls, totalCalls)}</td>
    </tr>`;
  }).join('');

  const totalAvg = totalCalls ? Math.round(totalToolTokens / totalCalls) : 0;
  tableRows += totalsRow([
    {v:'Total',cls:''},{v:fmt(totalCalls),cls:'num'},{v:fmt(totalToolTokens),cls:'num'},
    {v:fmt(totalAvg),cls:'num'},{v:'100%',cls:'num'},{v:'100%',cls:'num'},
  ]);

  const byCallsSort = [...tools].sort((a,b) => b.calls - a.calls);
  const byTokensSort = [...tools].sort((a,b) => b.input_tokens - a.input_tokens);

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Total Tools</div><div class="card-value accent">${tools.length}</div></div>
      <div class="card"><div class="card-label">Total Calls</div><div class="card-value blue">${fmt(totalCalls)}</div></div>
      <div class="card"><div class="card-label">Tool Tokens</div><div class="card-value green">${fmtM(totalToolTokens)}</div></div>
      <div class="card"><div class="card-label">Avg Tokens/Call</div><div class="card-value yellow">${fmt(totalAvg)}</div></div>
      <div class="card"><div class="card-label">Most Called</div><div class="card-value" style="font-size:1rem">${byCallsSort[0]?.tool||'—'}</div><div class="card-sub">${fmt(byCallsSort[0]?.calls)} calls</div></div>
      <div class="card"><div class="card-label">Most Tokens</div><div class="card-value" style="font-size:1rem">${byTokensSort[0]?.tool||'—'}</div><div class="card-sub">${fmtM(byTokensSort[0]?.input_tokens)} tokens</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Tool Categories by Tokens</h3><div class="chart-wrap"><canvas id="ch-cat-pie"></canvas></div></div>
      <div class="chart-box"><h3>Tool Categories by Calls</h3><div class="chart-wrap"><canvas id="ch-cat-calls"></canvas></div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box full"><h3>Top 15 Tools — Tokens vs Calls</h3><div class="chart-wrap tall"><canvas id="ch-tools-scatter"></canvas></div></div>
    </div>
    <div class="table-box"><h3>All Tools</h3>
      <table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Avg/Call</th><th class="num">% Tokens</th><th class="num">% Calls</th></tr></thead>
      <tbody>${tableRows}</tbody></table>
    </div>`;

  charts.catPie = new Chart($('#ch-cat-pie'), {
    type: 'doughnut', data: { labels: catEntries.map(e=>e[0]), datasets: [{ data: catEntries.map(e=>e[1].tokens), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
  charts.catCalls = new Chart($('#ch-cat-calls'), {
    type: 'doughnut', data: { labels: catEntries.map(e=>e[0]), datasets: [{ data: catEntries.map(e=>e[1].calls), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });

  const top15 = [...(r.tool_totals || [])].sort((a,b) => b.input_tokens - a.input_tokens).slice(0, 15);
  charts.toolsScatter = new Chart($('#ch-tools-scatter'), {
    type: 'bubble', data: {
      datasets: top15.map((t, i) => ({
        label: t.tool, data: [{ x: t.calls, y: t.input_tokens, r: Math.max(5, Math.min(30, Math.sqrt(t.calls) / 2)) }],
        backgroundColor: COLORS[i % COLORS.length] + '99',
      }))
    }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: 'Calls' } }, y: { title: { display: true, text: 'Tokens' }, ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } }
  });
}

/* ── Timeline Page ── */
function renderTimeline() {
  const r = getFilteredReport();
  const usage = r.usage || [];

  if (!usage.length) {
    $('#app').innerHTML = '<p style="color:var(--text2);padding:2rem">No time-series data in this report.</p>';
    return;
  }

  const byHour = {}, byDay = {}, byDayProvider = {}, byDayCli = {};
  const hasCliTool = usage.some(u => u.cli_tool);
  const cliToolsSeen = new Set();
  usage.forEach(u => {
    const h = u.hour || u.started_at;
    if (!h) return;
    const hourKey = h.slice(0, 13) + ':00:00Z';
    const dayKey = h.slice(0, 10);
    const hourNum = new Date(h).getUTCHours();
    const cacheRead = u.cache_read_tokens || 0;
    const cacheCreation = u.cache_creation_tokens || 0;
    const billable = u.input_tokens + u.output_tokens + cacheRead + cacheCreation;

    if (!byHour[hourKey]) byHour[hourKey] = { input: 0, output: 0, cache_read: 0, cache_creation: 0, requests: 0 };
    byHour[hourKey].input += u.input_tokens;
    byHour[hourKey].output += u.output_tokens;
    byHour[hourKey].cache_read += cacheRead;
    byHour[hourKey].cache_creation += cacheCreation;
    byHour[hourKey].requests += u.requests;

    if (!byDay[dayKey]) byDay[dayKey] = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, requests: 0, hours: new Set() };
    byDay[dayKey].input += u.input_tokens;
    byDay[dayKey].output += u.output_tokens;
    byDay[dayKey].cache_read += cacheRead;
    byDay[dayKey].cache_creation += cacheCreation;
    byDay[dayKey].total += billable;
    byDay[dayKey].requests += u.requests;
    byDay[dayKey].hours.add(hourNum);

    const pk = dayKey + '|' + (u.provider || 'unknown');
    if (!byDayProvider[pk]) byDayProvider[pk] = { day: dayKey, provider: u.provider || 'unknown', input: 0, output: 0, requests: 0 };
    byDayProvider[pk].input += u.input_tokens;
    byDayProvider[pk].output += u.output_tokens;
    byDayProvider[pk].requests += u.requests;

    if (hasCliTool) {
      const cli = u.cli_tool || 'unknown';
      cliToolsSeen.add(cli);
      const ck = dayKey + '|' + cli;
      if (!byDayCli[ck]) byDayCli[ck] = 0;
      byDayCli[ck] += billable;
    }
  });

  // Fill in missing days so the full period is represented
  if (r.period) {
    const start = new Date(r.period.start); start.setUTCHours(0,0,0,0);
    const end = new Date(r.period.end); end.setUTCHours(0,0,0,0);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dayKey = d.toISOString().slice(0, 10);
      if (!byDay[dayKey]) byDay[dayKey] = { input: 0, output: 0, requests: 0, hours: new Set() };
    }
  }
  const days = Object.keys(byDay).sort();
  const peakDay = days.reduce((best, d) => byDay[d].total > (byDay[best]?.total || 0) ? d : best, days[0]);
  const avgDaily = days.length ? Math.round(days.reduce((s,d) => s + byDay[d].requests, 0) / days.length) : 0;
  const totalActiveHours = days.reduce((s,d) => s + byDay[d].hours.size, 0);
  const avgActiveHoursPerDay = days.length ? (totalActiveHours / days.length).toFixed(1) : 0;
  // "Per developer" = cumulative active hours across the whole period,
  // divided by the number of reports contributing to this view. In a
  // single-report view that's just total active hours for that developer;
  // in the combined view it flattens across everyone.
  const devCount = r._developer_count || 1;
  const avgActiveHoursPerDev = devCount ? (totalActiveHours / devCount).toFixed(1) : 0;

  // Heatmap
  const heatmapData = {};
  let maxVal = 0;
  usage.forEach(u => {
    const h = u.hour || u.started_at;
    if (!h) return;
    const day = h.slice(0, 10);
    const hour = new Date(h).getUTCHours();
    const key = day + '-' + hour;
    heatmapData[key] = (heatmapData[key] || 0) + u.requests;
    if (heatmapData[key] > maxVal) maxVal = heatmapData[key];
  });

  let heatmapHTML = '';
  days.forEach(day => {
    const label = new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    let cells = '';
    for (let h = 0; h < 24; h++) {
      const val = heatmapData[day + '-' + h] || 0;
      const intensity = maxVal ? val / maxVal : 0;
      const bg = val === 0 ? 'var(--surface2)' : `rgba(108,92,231,${0.15 + intensity * 0.85})`;
      cells += `<div class="heatmap-cell" style="background:${bg}" data-tip="${label} ${h}:00 — ${val} reqs"></div>`;
    }
    heatmapHTML += `<div class="heatmap-grid"><div class="heatmap-row-label">${label}</div><div class="heatmap">${cells}</div></div>`;
  });
  heatmapHTML += `<div class="heatmap-grid"><div class="heatmap-row-label"></div><div class="heatmap-labels"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div></div>`;

  // Daily table with totals
  const tIn = days.reduce((s,d) => s+byDay[d].input, 0);
  const tOut = days.reduce((s,d) => s+byDay[d].output, 0);
  const tCacheRead = days.reduce((s,d) => s+byDay[d].cache_read, 0);
  const tCacheCreate = days.reduce((s,d) => s+byDay[d].cache_creation, 0);
  const tReqs = days.reduce((s,d) => s+byDay[d].requests, 0);
  const tHours = days.reduce((s,d) => s+byDay[d].hours.size, 0);

  let dayRows = days.map(d => {
    const dd = byDay[d];
    return `<tr>
      <td>${new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</td>
      <td class="num">${fmt(dd.input)}</td>
      <td class="num">${fmt(dd.output)}</td>
      <td class="num">${fmt(dd.cache_read)}</td>
      <td class="num">${fmt(dd.cache_creation)}</td>
      <td class="num">${fmt(dd.total)}</td>
      <td class="num">${fmt(dd.requests)}</td>
      <td class="num">${dd.hours.size}h</td>
    </tr>`;
  }).join('');

  dayRows += totalsRow([
    {v:'Total',cls:''},
    {v:fmt(tIn),cls:'num'},{v:fmt(tOut),cls:'num'},
    {v:fmt(tCacheRead),cls:'num'},{v:fmt(tCacheCreate),cls:'num'},
    {v:fmt(tIn+tOut+tCacheRead+tCacheCreate),cls:'num'},
    {v:fmt(tReqs),cls:'num'},{v:tHours+'h',cls:'num'},
  ]);

  $('#app').innerHTML = `
    ${renderCoverageBanner(r)}
    <div class="cards">
      <div class="card"><div class="card-label">Active Days</div><div class="card-value accent">${days.length}</div></div>
      <div class="card"><div class="card-label">Avg Requests/Day</div><div class="card-value blue">${fmt(avgDaily)}</div></div>
      <div class="card"><div class="card-label">Avg Active Hours / Developer</div><div class="card-value green">${avgActiveHoursPerDev}</div><div class="card-sub">${devCount} developer${devCount === 1 ? '' : 's'} · ${avgActiveHoursPerDay}h/day avg</div></div>
      <div class="card"><div class="card-label">Peak Day</div><div class="card-value" style="font-size:0.9rem">${peakDay ? new Date(peakDay+'T00:00:00Z').toLocaleDateString() : '—'}</div><div class="card-sub">${peakDay ? fmt(byDay[peakDay].requests)+' requests' : ''}</div></div>
    </div>
    <div class="chart-box full" style="margin-bottom:1.5rem"><h3>Activity Heatmap (UTC)</h3>${heatmapHTML}</div>
    <div class="chart-grid">
      <div class="chart-box full"><h3>Daily Token Usage</h3><div class="chart-wrap tall"><canvas id="ch-daily"></canvas></div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box full"><h3>Daily Requests by Provider</h3><div class="chart-wrap tall"><canvas id="ch-daily-prov"></canvas></div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box full"><h3>Daily Tool Token Usage (Top 8)</h3><div class="chart-wrap tall"><canvas id="ch-daily-tools"></canvas></div></div>
    </div>
    <div class="table-box"><h3>Daily Breakdown</h3>
      <table><thead><tr><th>Day</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache Read</th><th class="num">Cache Write</th><th class="num">Total</th><th class="num">Requests</th><th class="num">Active Hours</th></tr></thead>
      <tbody>${dayRows}</tbody></table>
    </div>`;

  // Daily tokens — split by CLI tool (total tokens per CLI per day) when
  // the report carries cli_tool on usage rows; otherwise fall back to the
  // classic Input/Output split.
  const dailyDatasets = hasCliTool
    ? [...cliToolsSeen].sort().map(cli => ({
        label: cli,
        data: days.map(d => byDayCli[d + '|' + cli] || 0),
        backgroundColor: cliColor(cli),
        stack: 's',
      }))
    : [
        { label: 'Input',       data: days.map(d => byDay[d].input),          backgroundColor: '#6c5ce7', stack: 's' },
        { label: 'Cache read',  data: days.map(d => byDay[d].cache_read),     backgroundColor: '#00cec9', stack: 's' },
        { label: 'Cache write', data: days.map(d => byDay[d].cache_creation), backgroundColor: '#81ecec', stack: 's' },
        { label: 'Output',      data: days.map(d => byDay[d].output),         backgroundColor: '#00b894', stack: 's' },
      ];

  charts.daily = new Chart($('#ch-daily'), {
    type: 'bar', data: {
      labels: days.map(d => new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric'})),
      datasets: dailyDatasets,
    }, options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' },
        tooltip: hasCliTool ? {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} tokens`,
          },
        } : {},
      },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => fmtM(v) } } },
    },
  });

  const allProviders = [...new Set(Object.values(byDayProvider).map(e => e.provider))];
  charts.dailyProv = new Chart($('#ch-daily-prov'), {
    type: 'bar', data: {
      labels: days.map(d => new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric'})),
      datasets: allProviders.map((p, i) => ({
        label: p,
        data: days.map(d => { const e = byDayProvider[d+'|'+p]; return e ? e.requests : 0; }),
        backgroundColor: COLORS[i % COLORS.length],
        stack: 's',
      }))
    }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } }
  });

  // Daily tool token usage
  const toolByDay = {};
  usage.forEach(u => {
    if (!u.tools) return;
    const dayKey = (u.hour || u.started_at || '').slice(0, 10);
    if (!dayKey) return;
    Object.entries(u.tools).forEach(([tool, d]) => {
      if (!toolByDay[tool]) toolByDay[tool] = {};
      toolByDay[tool][dayKey] = (toolByDay[tool][dayKey] || 0) + (d.input_tokens || 0);
    });
  });
  const topTools = Object.entries(toolByDay).sort((a,b) => {
    const sumA = Object.values(a[1]).reduce((s,v) => s+v, 0);
    const sumB = Object.values(b[1]).reduce((s,v) => s+v, 0);
    return sumB - sumA;
  }).slice(0, 8);
  if (topTools.length) {
    charts.dailyTools = new Chart($('#ch-daily-tools'), {
      type: 'bar', data: {
        labels: days.map(d => new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric'})),
        datasets: topTools.map(([tool, dayData], i) => ({
          label: tool,
          data: days.map(d => dayData[d] || 0),
          backgroundColor: COLORS[i % COLORS.length],
          stack: 's',
        }))
      }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { position: 'top' } } }
    });
  }
}

/* ── Sessions Page ── */
function renderSessions() {
  const r = getFilteredReport();
  const sessions = r.sessions || [];

  if (!sessions.length) {
    $('#app').innerHTML = '<p style="color:var(--text2);padding:2rem">No session data in this report.</p>';
    return;
  }

  const sorted = [...sessions].sort((a,b) => (b.started_at||'').localeCompare(a.started_at||''));
  const sessionBillable = s => (s.input_tokens || 0) + (s.output_tokens || 0) + (s.cache_read_tokens || 0) + (s.cache_creation_tokens || 0);
  const totalTokens = sorted.reduce((s,x) => s + sessionBillable(x), 0);
  const totalCacheRead = sorted.reduce((s,x) => s + (x.cache_read_tokens || 0), 0);
  const totalCacheCreate = sorted.reduce((s,x) => s + (x.cache_creation_tokens || 0), 0);
  const totalFreshInput = sorted.reduce((s,x) => s + (x.input_tokens || 0), 0);
  const totalInputSide = totalFreshInput + totalCacheRead + totalCacheCreate;
  const overallCachePct = totalInputSide ? (totalCacheRead / totalInputSide * 100).toFixed(1) : '0';
  const totalReqs = sorted.reduce((s,x) => s + x.requests, 0);
  const avgTokens = sorted.length ? Math.round(totalTokens / sorted.length) : 0;
  const dirs = new Set(sorted.map(s => s.directory).filter(Boolean));

  const dur = s => {
    if (!s.started_at || !s.ended_at) return '\u2014';
    const mins = Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000);
    return mins >= 60 ? Math.floor(mins/60)+'h '+mins%60+'m' : mins+'m';
  };

  const hasFileData = !!r.file_stats;
  const warnsBySession = {};
  (r.warnings || []).forEach(w => { if (w.session_id) warnsBySession[w.session_id] = (warnsBySession[w.session_id] || 0) + 1; });
  let totalCost = 0;
  let rows = sorted.map((s, idx) => {
    const cacheRead = s.cache_read_tokens || 0;
    const cacheWrite = s.cache_creation_tokens || 0;
    const cacheTotal = cacheRead + cacheWrite;
    const total = s.input_tokens + s.output_tokens + cacheTotal;
    const cost = estimateCost(s.input_tokens, s.output_tokens, s.model, cacheRead, cacheWrite);
    if (cost) totalCost += cost;
    const inputSide = s.input_tokens + cacheRead + cacheWrite;
    const cachePct = inputSide ? (cacheRead / inputSide * 100).toFixed(0) : '0';
    const hasDetail = (s.agents && Object.keys(s.agents).length > 0) || (s.tool_timeline && s.tool_timeline.length > 0) || warnsBySession[s.session_id];
    const toolCalls = s.tool_calls || 0;
    const agentCount = s.agents ? Object.keys(s.agents).length : 0;
    const fileCount = s.files ? s.files.length : null;
    const fc = s.file_changes;
    const changesCell = fc ? `<span style="color:#00b894">+${fmt(fc.additions)}</span> <span style="color:#d63031">-${fmt(fc.deletions)}</span>` : '\u2014';
    const sessWarnCount = warnsBySession[s.session_id] || 0;
    // Column count for detail row colspan: base 14 columns + optional Files column.
    const colCount = fileCount !== null ? 16 : 15;
    return `<tr class="${hasDetail ? 'session-detail' : ''}" ${hasDetail ? `onclick="toggleSessionDetail(${idx})"` : ''}>
      <td>${s.session_title || s.session_id?.slice(0,8) || '\u2014'}</td>
      <td><span class="${badgeClass(s.provider)}">${s.provider}</span></td>
      <td>${s.model}</td>
      <td class="num">${fmt(total)}</td>
      <td class="num" title="${fmt(cacheRead)} read · ${fmt(cacheWrite)} write">${cacheTotal ? fmtM(cacheTotal) : '\u2014'}</td>
      <td class="num">${cacheTotal ? cachePct + '%' : '\u2014'}</td>
      <td class="num">${fmt(s.requests)}</td>
      <td class="num">${agentCount || '\u2014'}</td>
      <td class="num">${fmt(toolCalls)}</td>
      <td class="num">${fmt(s.tool_input_tokens)}</td>
      <td class="num">${cost != null ? '$'+cost.toFixed(2) : '\u2014'}</td>
      <td class="num">${dur(s)}</td>
      <td class="num" style="font-size:0.8rem;white-space:nowrap">${changesCell}</td>
      <td class="num">${sessWarnCount ? `<span style="color:var(--red)" title="${sessWarnCount} warnings">⚠ ${sessWarnCount}</span>` : '\u2014'}</td>
      <td style="font-size:0.75rem;color:var(--text2)" title="${s.directory||''}">${s.directory ? s.directory.split('/').slice(-2).join('/') : '\u2014'}</td>
      <td style="font-size:0.75rem;color:var(--text2)">${s.started_at ? new Date(s.started_at).toLocaleString() : '\u2014'}</td>
      ${fileCount !== null ? `<td class="num" style="color:var(--accent2)">${fileCount}</td>` : ''}
    </tr>
    <tr id="sess-detail-${idx}" style="display:none"><td colspan="${colCount}" style="padding:1rem;background:var(--surface2)">
      <div id="sess-detail-content-${idx}"></div>
    </td></tr>`;
  }).join('');

  const totalAdds = sorted.reduce((s,x) => s + (x.file_changes?.additions || 0), 0);
  const totalDels = sorted.reduce((s,x) => s + (x.file_changes?.deletions || 0), 0);
  const totalWarnCount = Object.values(warnsBySession).reduce((s, v) => s + v, 0);
  rows += totalsRow([
    {v:`${sorted.length} sessions`,cls:''},{v:'',cls:''},{v:'Total',cls:''},
    {v:fmt(totalTokens),cls:'num'},
    {v:fmt(totalCacheRead + totalCacheCreate),cls:'num'},
    {v:overallCachePct+'%',cls:'num'},
    {v:fmt(totalReqs),cls:'num'},
    {v:'',cls:'num'},
    {v:fmt(sorted.reduce((s,x)=>s+(x.tool_calls||0),0)),cls:'num'},
    {v:fmt(sorted.reduce((s,x)=>s+x.tool_input_tokens,0)),cls:'num'},
    {v:totalCost>0?'$'+totalCost.toFixed(2):'\u2014',cls:'num'},
    {v:'',cls:'num'},
    {v:`<span style="color:#00b894">+${fmt(totalAdds)}</span> <span style="color:#d63031">-${fmt(totalDels)}</span>`,cls:'num'},
    {v:totalWarnCount?`⚠ ${totalWarnCount}`:'\u2014',cls:'num'},
    {v:'',cls:''},{v:'',cls:''},
  ]);

  // Warning summary for sessions page
  const warnings = r.warnings || [];
  const warnCount = warnings.filter(w => w.severity === 'severe' || w.severity === 'warn').length;
  const warnCard = warnCount > 0
    ? `<div class="card"><div class="card-label">Warnings</div><div class="card-value" style="color:var(--red)">${warnCount}</div><div class="card-sub"><a href="#/warnings" style="color:var(--accent2)">View details →</a></div></div>`
    : `<div class="card"><div class="card-label">Warnings</div><div class="card-value green">0</div><div class="card-sub">No issues detected</div></div>`;

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Sessions</div><div class="card-value accent">${sorted.length}</div></div>
      <div class="card"><div class="card-label">Avg Tokens/Session</div><div class="card-value blue">${fmtM(avgTokens)}</div></div>
      <div class="card"><div class="card-label">Cache Hit Rate</div><div class="card-value" style="color:#00cec9">${overallCachePct}%</div><div class="card-sub">${fmtM(totalCacheRead)} read · ${fmtM(totalCacheCreate)} write</div></div>
      <div class="card"><div class="card-label">Projects</div><div class="card-value green">${dirs.size}</div></div>
      <div class="card"><div class="card-label">Est. Total Cost</div><div class="card-value yellow">${totalCost > 0 ? '$'+totalCost.toFixed(2) : 'N/A'}</div></div>
      ${warnCard}
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Sessions by Provider</h3><div class="chart-wrap"><canvas id="ch-sess-prov"></canvas></div></div>
      <div class="chart-box"><h3>Tokens by Model</h3><div class="chart-wrap"><canvas id="ch-sess-model"></canvas></div></div>
    </div>
    <div class="table-box"><h3>All Sessions <span style="font-size:0.75rem;color:var(--text2);font-weight:normal">(click rows with agent/tool data to expand)</span></h3>
      <table><thead><tr><th>Title</th><th>Provider</th><th>Model</th><th class="num">Tokens</th><th class="num" title="Cache read + write tokens">Cache</th><th class="num" title="Cache read / total input">Cache %</th><th class="num">Requests</th><th class="num">Agents</th><th class="num">Tool Calls</th><th class="num">Tool Tokens</th><th class="num">Est. Cost</th><th class="num">Duration</th><th class="num">Changes</th><th class="num">⚠</th><th>Project</th><th>Started</th>${hasFileData ? '<th class="num"><a href="#/files" style="color:var(--accent2)">Files ↗</a></th>' : ''}</tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;

  // Store sessions for detail expansion
  window._sessionData = sorted;

  const provAgg = {};
  sorted.forEach(s => { provAgg[s.provider] = (provAgg[s.provider]||0) + 1; });
  const provs = Object.entries(provAgg).sort((a,b) => b[1]-a[1]);
  charts.sessProv = new Chart($('#ch-sess-prov'), {
    type: 'doughnut', data: { labels: provs.map(p=>p[0]), datasets: [{ data: provs.map(p=>p[1]), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });

  const modelAgg = {};
  sorted.forEach(s => {
    const k = s.model;
    modelAgg[k] = (modelAgg[k]||0) + sessionBillable(s);
  });
  const models = Object.entries(modelAgg).sort((a,b) => b[1]-a[1]).slice(0,8);
  charts.sessModel = new Chart($('#ch-sess-model'), {
    type: 'doughnut', data: { labels: models.map(m=>m[0]), datasets: [{ data: models.map(m=>m[1]), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
}

/* ── Session detail toggle ── */
window.toggleSessionDetail = function(idx) {
  const row = document.getElementById('sess-detail-' + idx);
  const content = document.getElementById('sess-detail-content-' + idx);
  if (!row) return;
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'table-row';
  if (!visible && content && !content.dataset.loaded) {
    const s = window._sessionData[idx];
    let html = '';
    if (s.agents && Object.keys(s.agents).length > 0) {
      html += '<h3 style="font-size:0.9rem;color:var(--text2);margin-bottom:0.5rem">Agent Flow</h3>';
      html += renderAgentFlowChart(s.agents);
    }
    if (s.tool_timeline && s.tool_timeline.length > 0) {
      html += '<h3 style="font-size:0.9rem;color:var(--text2);margin:1rem 0 0.5rem">Tool Timeline</h3>';
      html += renderFlameChartSVG(s.tool_timeline, content.offsetWidth || 800);
    }
    if (s.files && s.files.length > 0) {
      html += '<h3 style="font-size:0.9rem;color:var(--text2);margin:1rem 0 0.5rem">Files Accessed</h3>';
      html += '<table style="font-size:0.75rem;width:100%"><thead><tr><th style="text-align:left">File</th><th style="text-align:right">Tokens</th><th style="text-align:right">Reads</th><th style="text-align:right">Edits</th><th style="text-align:right">Writes</th></tr></thead><tbody>';
      html += s.files.slice(0, 20).map(f => {
        const shortPath = f.path.length > 70 ? '…' + f.path.slice(-68) : f.path;
        return `<tr><td style="font-family:monospace" title="${f.path}">${shortPath}</td><td style="text-align:right">${fmt(f.input_tokens)}</td><td style="text-align:right">${f.tools.read||'\u2014'}</td><td style="text-align:right">${f.tools.edit||'\u2014'}</td><td style="text-align:right">${f.tools.write||'\u2014'}</td></tr>`;
      }).join('');
      if (s.files.length > 20) html += `<tr><td colspan="5" style="color:var(--text2);font-style:italic">…and ${s.files.length - 20} more files. <a href="#/files" style="color:var(--accent2)">View all in Files page →</a></td></tr>`;
      html += '</tbody></table>';
    } else if (s.file_changes) {
      const fc = s.file_changes;
      html += '<h3 style="font-size:0.9rem;color:var(--text2);margin:1rem 0 0.5rem">File Activity</h3>';
      html += `<div style="font-size:0.85rem">${fc.unique_files} files · ${fc.reads} reads${fc.full_reads ? ` (${fc.full_reads} full)` : ''} · ${fc.edits} edits · ${fc.writes} writes · <span style="color:#00b894">+${fmt(fc.additions)}</span> <span style="color:#d63031">-${fmt(fc.deletions)}</span></div>`;
    }
    // Session-specific warnings
    const r = getFilteredReport();
    const sessWarnings = (r.warnings || []).filter(w => w.session_id === s.session_id);
    if (sessWarnings.length > 0) {
      html += '<h3 style="font-size:0.9rem;color:var(--text2);margin:1rem 0 0.5rem">Warnings</h3>';
      html += sessWarnings.map(w => `<div style="font-size:0.8rem;padding:0.4rem 0.6rem;margin-bottom:0.3rem;background:var(--surface);border-radius:4px;border-left:3px solid ${w.severity==='severe'?'var(--red)':w.severity==='warn'?'var(--yellow)':'var(--blue)'}"><strong>${w.type.replace(/_/g,' ')}</strong>: ${w.detail.replace(/ in session \w+\.?/,'')}</div>`).join('');
    }
    if (!html) html = '<p style="color:var(--text2);font-size:0.85rem">No detail data available</p>';
    content.innerHTML = html;
    content.dataset.loaded = '1';
  }
};

/* ── Warnings Page ── */
function renderWarnings() {
  const r = getFilteredReport();
  const warnings = r.warnings || [];

  if (!warnings.length) {
    $('#app').innerHTML = '<div class="cards"><div class="card"><div class="card-label">Status</div><div class="card-value green">✓</div><div class="card-sub">No warnings detected</div></div></div>';
    return;
  }

  const bySeverity = { severe: 0, warn: 0, info: 0 };
  const byType = {};
  warnings.forEach(w => {
    bySeverity[w.severity] = (bySeverity[w.severity] || 0) + 1;
    byType[w.type] = (byType[w.type] || 0) + 1;
  });

  const deadContextTypes = new Set(['duplicate_reads', 'superseded_writes', 'errored_tool_inputs', 'read_then_small_edit', 'inefficient_reads', 'unbounded_bash', 'excessive_full_reads', 'expensive_full_reads']);
  const deadCount = warnings.filter(w => deadContextTypes.has(w.type)).length;
  const wasteCount = warnings.filter(w => ['excessive_iteration','wasted_compute','low_token_efficiency','output_heavy','long_running'].includes(w.type)).length;

  const items = warnings.map(w =>
    `<div class="warning-item ${w.severity}"><div class="warning-type">${w.type.replace(/_/g, ' ')}</div><div class="warning-detail">${w.detail}${w.session_id ? ' <span style="color:var(--text2);font-size:0.75rem">('+w.session_id.slice(0,8)+'…)</span>' : ''}</div></div>`
  ).join('');

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Total Warnings</div><div class="card-value accent">${warnings.length}</div></div>
      <div class="card"><div class="card-label">Severe</div><div class="card-value" style="color:var(--red)">${bySeverity.severe||0}</div></div>
      <div class="card"><div class="card-label">Warnings</div><div class="card-value yellow">${bySeverity.warn||0}</div></div>
      <div class="card"><div class="card-label">Info</div><div class="card-value blue">${bySeverity.info||0}</div></div>
      <div class="card"><div class="card-label">Dead Context</div><div class="card-value" style="color:${deadCount ? '#e17055' : 'var(--green)'}">${deadCount}</div><div class="card-sub">Wasted tokens from stale/duplicate context</div></div>
      <div class="card"><div class="card-label">Session Waste</div><div class="card-value" style="color:${wasteCount ? '#fdcb6e' : 'var(--green)'}">${wasteCount}</div><div class="card-sub">Inefficient session patterns</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>By Severity</h3><div class="chart-wrap"><canvas id="ch-warn-sev"></canvas></div></div>
      <div class="chart-box"><h3>By Type</h3><div class="chart-wrap"><canvas id="ch-warn-type"></canvas></div></div>
    </div>
    <div style="margin-bottom:1.5rem">${items}</div>`;

  const sevEntries = Object.entries(bySeverity).filter(e => e[1] > 0);
  const sevColors = { severe: '#e17055', warn: '#fdcb6e', info: '#74b9ff' };
  charts.warnSev = new Chart($('#ch-warn-sev'), {
    type: 'doughnut', data: { labels: sevEntries.map(e=>e[0]), datasets: [{ data: sevEntries.map(e=>e[1]), backgroundColor: sevEntries.map(e=>sevColors[e[0]]) }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
  const typeEntries = Object.entries(byType).sort((a,b) => b[1]-a[1]);
  charts.warnType = new Chart($('#ch-warn-type'), {
    type: 'bar', data: { labels: typeEntries.map(e=>e[0].replace(/_/g,' ')), datasets: [{ label: 'Count', data: typeEntries.map(e=>e[1]), backgroundColor: '#a29bfe' }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

/* ── Files Page ── */
function renderFiles() {
  const r = getFilteredReport();
  const files = r.file_stats || [];

  if (!files.length) {
    $('#app').innerHTML = '<p style="color:var(--text2);padding:2rem">No file data in this report. Generate with <code>--use-real-session-name</code>.</p>';
    return;
  }

  const totalTokens = files.reduce((s, f) => s + f.input_tokens, 0);
  const totalCalls = files.reduce((s, f) => s + f.calls, 0);
  const topFile = files[0];

  // Directory aggregation
  const dirMap = {};
  files.forEach(f => {
    const dir = f.directory || f.path.split('/').slice(0, -1).join('/') || '/';
    if (!dirMap[dir]) dirMap[dir] = { dir, files: 0, calls: 0, input_tokens: 0 };
    dirMap[dir].files++;
    dirMap[dir].calls += f.calls;
    dirMap[dir].input_tokens += f.input_tokens;
  });
  const dirs = Object.values(dirMap).sort((a, b) => b.input_tokens - a.input_tokens);

  // Extension aggregation
  const extMap = {};
  files.forEach(f => {
    const ext = f.path.includes('.') ? '.' + f.path.split('.').pop() : '(none)';
    if (!extMap[ext]) extMap[ext] = { ext, files: 0, calls: 0, input_tokens: 0 };
    extMap[ext].files++;
    extMap[ext].calls += f.calls;
    extMap[ext].input_tokens += f.input_tokens;
  });
  const exts = Object.values(extMap).sort((a, b) => b.input_tokens - a.input_tokens).slice(0, 12);

  // Tool breakdown across all files
  const toolTotals = {};
  files.forEach(f => Object.entries(f.tools).forEach(([t, c]) => { toolTotals[t] = (toolTotals[t] || 0) + c; }));

  const rows = files.map(f => {
    const reads = f.tools.read || 0;
    const edits = f.tools.edit || 0;
    const writes = f.tools.write || 0;
    const shortPath = f.path.length > 60 ? '…' + f.path.slice(-58) : f.path;
    return `<tr>
      <td title="${f.path}" style="font-size:0.75rem;font-family:monospace">${shortPath}</td>
      <td class="num">${fmt(f.input_tokens)}</td>
      <td class="num">${reads || '\u2014'}</td>
      <td class="num">${edits || '\u2014'}</td>
      <td class="num">${writes || '\u2014'}</td>
      <td class="num">${f.sessions}</td>
    </tr>`;
  }).join('');

  const topDir = dirs[0];

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Unique Files</div><div class="card-value accent">${files.length}</div><div class="card-sub">${dirs.length} directories</div></div>
      <div class="card"><div class="card-label">File Token Cost</div><div class="card-value blue">${fmtM(totalTokens)}</div><div class="card-sub">${fmt(totalCalls)} tool calls</div></div>
      <div class="card"><div class="card-label">Hottest File</div><div class="card-value" style="font-size:0.75rem;word-break:break-all">${topFile.path.split('/').pop()}</div><div class="card-sub">${fmtM(topFile.input_tokens)} tokens, ${topFile.calls} calls</div></div>
      <div class="card"><div class="card-label">Top Directory</div><div class="card-value" style="font-size:0.75rem;word-break:break-all">${topDir ? topDir.dir.split('/').pop() || topDir.dir : '\u2014'}</div><div class="card-sub">${topDir ? fmtM(topDir.input_tokens)+' tokens, '+topDir.files+' files' : ''}</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Top Directories by Token Cost</h3><div class="chart-wrap tall"><canvas id="ch-files-dirs"></canvas></div></div>
      <div class="chart-box"><h3>File Types by Token Cost</h3><div class="chart-wrap tall"><canvas id="ch-files-exts"></canvas></div></div>
    </div>
    <div class="table-box"><h3>All Files <span style="font-size:0.75rem;color:var(--text2);font-weight:normal">(sorted by token cost)</span></h3>
      <table><thead><tr><th>File</th><th class="num">Tokens</th><th class="num">Reads</th><th class="num">Edits</th><th class="num">Writes</th><th class="num">Sessions</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;

  const topDirs = dirs.slice(0, 12);
  charts.fileDirs = new Chart($('#ch-files-dirs'), {
    type: 'bar',
    data: {
      labels: topDirs.map(d => d.dir.split('/').slice(-2).join('/') || d.dir),
      datasets: [{ label: 'Tokens', data: topDirs.map(d => d.input_tokens), backgroundColor: COLORS[0] }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { display: false } } }
  });

  charts.fileExts = new Chart($('#ch-files-exts'), {
    type: 'bar',
    data: {
      labels: exts.map(e => e.ext),
      datasets: [{ label: 'Tokens', data: exts.map(e => e.input_tokens), backgroundColor: COLORS[1] }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { display: false } } }
  });
}

/* ── Flame Chart SVG helper ── */
function renderFlameChartSVG(events, width) {
  if (!events || events.length < 1) return '<p style="color:var(--text2);font-size:0.85rem">No timeline data</p>';
  const minT = Math.min(...events.map(e => e.start));
  const maxT = Math.max(...events.map(e => e.end));
  const range = maxT - minT || 1;

  // Check if events have depth info (hierarchical) or need overlap-avoidance
  const hasDepth = events.some(e => e.depth > 0);

  let rows;
  if (hasDepth) {
    // Group by depth level — each depth is its own row
    const maxDepth = Math.max(...events.map(e => e.depth || 0));
    rows = Array.from({ length: maxDepth + 1 }, () => []);
    for (const e of events) rows[e.depth || 0].push(e);
  } else {
    // Fallback: pack by overlap avoidance
    rows = [];
    for (const e of events) {
      let placed = false;
      for (const row of rows) {
        if (row.every(r => e.start >= r.end || e.end <= r.start)) { row.push(e); placed = true; break; }
      }
      if (!placed) rows.push([e]);
    }
  }

  const rowH = 20, pad = 2, w = width || 800;
  const h = rows.length * (rowH + pad) + 28;
  const toolColors = {};
  let colorIdx = 0;

  let svg = `<svg class="flame-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  // Depth labels when hierarchical
  if (hasDepth) {
    const labels = ['orchestrator', 'task', 'subtask', 'tool'];
    rows.forEach((_, ri) => {
      const label = labels[ri] || `depth ${ri}`;
      svg += `<text x="2" y="${ri * (rowH + pad) + 14}" fill="var(--text2)" font-size="9" opacity="0.6">${label}</text>`;
    });
  }
  // Time axis
  svg += `<line x1="0" y1="${h-20}" x2="${w}" y2="${h-20}" stroke="var(--border)"/>`;
  const durSec = Math.round(range / 1000);
  for (let i = 0; i <= 4; i++) {
    const x = (i / 4) * w;
    const t = Math.round((i / 4) * durSec);
    const label = t > 60 ? Math.round(t/60)+'m' : t+'s';
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    svg += `<text x="${x}" y="${h-5}" fill="var(--text2)" font-size="10" text-anchor="${anchor}">${label}</text>`;
  }

  rows.forEach((row, ri) => {
    const y = ri * (rowH + pad);
    for (const e of row) {
      if (!toolColors[e.tool]) toolColors[e.tool] = COLORS[colorIdx++ % COLORS.length];
      const x = ((e.start - minT) / range) * w;
      const ew = Math.max(((e.end - e.start) / range) * w, 3);
      const dur = e.end - e.start;
      const durLabel = dur > 1000 ? (dur/1000).toFixed(1)+'s' : dur+'ms';
      const label = e.title || e.tool;
      svg += `<rect x="${x}" y="${y}" width="${ew}" height="${rowH}" fill="${toolColors[e.tool]}" rx="2" opacity="${0.9 - (e.depth||0) * 0.1}"><title>${label} (${durLabel}${e.tokens ? ', '+e.tokens+' tok' : ''})</title></rect>`;
      if (ew > 50) svg += `<text x="${x+3}" y="${y+14}" fill="#fff" font-size="10">${label.length > ew/6 ? label.slice(0,Math.floor(ew/6))+'…' : label}</text>`;
    }
  });

  svg += '</svg>';
  return `<div class="flame-container">${svg}</div>`;
}

/* ── Agent Flow Chart helper ── */
function renderAgentFlowChart(agents) {
  if (!agents || !Object.keys(agents).length) return '';
  const entries = Object.entries(agents).sort((a,b) => (b[1].input_tokens+b[1].output_tokens) - (a[1].input_tokens+a[1].output_tokens));
  const maxTok = Math.max(...entries.map(([,a]) => a.input_tokens + a.output_tokens), 1);

  let html = '<div style="display:flex;flex-direction:column;gap:6px">';
  entries.forEach(([name, a], i) => {
    const total = a.input_tokens + a.output_tokens;
    const pctW = Math.max(5, (total / maxTok) * 100);
    const color = COLORS[i % COLORS.length];
    html += `<div style="display:flex;align-items:center;gap:8px;font-size:0.8rem">
      <span style="min-width:100px;color:var(--text2)">${name}</span>
      <div style="flex:1;height:16px;background:var(--surface2);border-radius:3px;overflow:hidden;position:relative">
        <div style="width:${pctW}%;height:100%;background:${color};border-radius:3px"></div>
        ${a.model ? `<span style="position:absolute;left:4px;top:1px;font-size:0.6rem;color:#fff;white-space:nowrap">${a.model}</span>` : ''}
      </div>
      <span style="min-width:60px;text-align:right;color:var(--text2)">${fmtM(total)}</span>
      <span style="min-width:30px;text-align:right;color:var(--text2)">${a.requests}r</span>
    </div>`;
  });
  html += '</div>';
  return html;
}

/* ── Export ── */
const EXPORT_PAGES = ['dashboard', 'models', 'tools', 'timeline', 'sessions', 'warnings', 'files'];
const PAGE_RENDERERS = { dashboard: renderDashboard, models: renderModels, tools: renderTools, timeline: renderTimeline, sessions: renderSessions, warnings: renderWarnings, files: renderFiles };

function showExportProgress(msg) {
  const overlay = document.createElement('div');
  overlay.className = 'export-overlay';
  overlay.id = 'export-overlay';
  const box = document.createElement('div');
  box.className = 'export-progress';
  box.id = 'export-progress';
  box.textContent = msg;
  document.body.append(overlay, box);
}
function hideExportProgress() {
  document.getElementById('export-overlay')?.remove();
  document.getElementById('export-progress')?.remove();
}

function waitForFrame() { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

async function renderAllPagesContainer() {
  const container = document.createElement('div');
  container.style.cssText = 'background:var(--bg);color:var(--text);padding:1.5rem;max-width:1400px';
  const app = $('#app');
  const savedHash = location.hash;
  const savedHTML = app.innerHTML;
  const pages = EXPORT_PAGES.filter(p => p !== 'files' || currentReport.file_stats);

  // Disable Chart.js animations for instant rendering
  Chart.defaults.animation = false;

  // Table of contents
  const toc = document.createElement('div');
  toc.style.cssText = 'margin-bottom:2rem;padding:1.25rem;background:#1a1d27;border:1px solid #2e3348;border-radius:10px';
  toc.innerHTML = `<h2 style="font-size:1.3rem;margin-bottom:0.75rem;color:#a29bfe">Contents</h2>
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${pages.map(p =>
      `<a href="#export-${p}" style="color:#74b9ff;text-decoration:none;padding:0.3rem 0.75rem;background:#242836;border-radius:4px;font-size:0.85rem">${p.charAt(0).toUpperCase() + p.slice(1)}</a>`
    ).join('')}</div>`;
  container.appendChild(toc);

  for (const page of pages) {
    destroyCharts();
    (PAGE_RENDERERS[page] || PAGE_RENDERERS.dashboard)();
    // Pre-expand session details for static export
    if (page === 'sessions' && window._sessionData) {
      window._sessionData.forEach((s, i) => {
        if ((s.agents && Object.keys(s.agents).length) || (s.tool_timeline && s.tool_timeline.length) || (s.files && s.files.length)) {
          toggleSessionDetail(i);
        }
      });
    }
    // Wait for Chart.js to paint (needs 2 animation frames)
    await waitForFrame();
    const section = document.createElement('div');
    section.id = `export-${page}`;
    section.style.cssText = 'margin-bottom:2rem;page-break-after:always';
    section.innerHTML = `<h2 style="font-size:1.3rem;margin-bottom:1rem;color:var(--accent2);border-bottom:1px solid var(--border);padding-bottom:0.5rem">${page.charAt(0).toUpperCase() + page.slice(1)}</h2>`;
    // Convert canvases to images in-place before cloning
    app.querySelectorAll('canvas').forEach(canvas => {
      try {
        const img = document.createElement('img');
        img.src = canvas.toDataURL('image/png');
        img.style.cssText = `width:${canvas.offsetWidth}px;height:${canvas.offsetHeight}px`;
        canvas.parentNode.replaceChild(img, canvas);
      } catch(e) {}
    });
    section.appendChild(app.cloneNode(true));
    container.appendChild(section);
  }

  // Restore animations and original page
  Chart.defaults.animation = true;
  destroyCharts();
  app.innerHTML = savedHTML;
  location.hash = savedHash;
  route();

  return container;
}

async function exportReport(format) {
  document.querySelector('.export-menu').classList.remove('open');
  if (!currentReport) return;

  if (format === 'json') {
    const blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `opencode-report-${Date.now()}.json`);
    return;
  }

  showExportProgress(`Generating ${format.toUpperCase()}…`);
  await new Promise(r => setTimeout(r, 50)); // let UI paint

  try {
    if (format === 'html') {
      const [css, js] = await Promise.all([fetch('/styles.css').then(r => r.text()), fetch('/app.js').then(r => r.text())]);
      const reportJSON = JSON.stringify(currentReport);
      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>
<style>${css}</style></head><body>
<nav id="nav">
  <div class="nav-brand">⚡ OpenCode Analytics</div>
  <div class="nav-links">
    <a href="#/" class="nav-link active" data-page="dashboard">Dashboard</a>
    <a href="#/models" class="nav-link" data-page="models">Models</a>
    <a href="#/tools" class="nav-link" data-page="tools">Tools</a>
    <a href="#/timeline" class="nav-link" data-page="timeline">Timeline</a>
    <a href="#/sessions" class="nav-link" data-page="sessions">Sessions</a>
    <a href="#/warnings" class="nav-link" data-page="warnings">Warnings</a>
    <a href="#/files" class="nav-link" data-page="files" id="nav-files" style="display:none">Files</a>
  </div>
</nav>
<main id="app"></main>
<script>
${js.replace(/loadReports\(\);\s*$/, '')}
// Bootstrap with embedded data
loadReports = function() { selectReportDirect(${reportJSON}); };
loadReports();
<\/script></body></html>`;
      downloadBlob(new Blob([html], { type: 'text/html' }), `opencode-report-${Date.now()}.html`);
    } else if (format === 'pdf') {
      const container = await renderAllPagesContainer();
      // Cap each section height to stay within browser canvas limits
      [...container.children].forEach(s => { s.style.maxHeight = '8000px'; s.style.overflow = 'hidden'; });
      document.body.appendChild(container);
      await html2pdf().set({
        margin: [10, 10],
        filename: `opencode-report-${Date.now()}.pdf`,
        image: { type: 'jpeg', quality: 0.8 },
        html2canvas: { scale: 1, backgroundColor: '#0f1117', useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
        pagebreak: { mode: ['css'], avoid: ['tr', '.card', '.chart-box'] },
      }).from(container).save();
      container.remove();
    }
  } catch (e) {
    console.error('Export failed:', e);
    alert('Export failed: ' + e.message);
  } finally {
    hideExportProgress();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Close export menu on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.export-dropdown')) {
    document.querySelector('.export-menu')?.classList.remove('open');
  }
});

/* ── Init ── */
loadReports();
