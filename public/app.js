'use strict';
/* ── State ── */
let reports = [];
let allReportData = [];
let currentReport = null;
let selectedProvider = null;
let charts = {};
let pricing = {};

/* ── Helpers ── */
const $ = s => document.querySelector(s);
const fmt = n => n == null ? '0' : n.toLocaleString();
const fmtM = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
const pct = (a, b) => b ? ((a/b)*100).toFixed(1)+'%' : '0%';
const badgeClass = p => 'badge badge-' + (['github-copilot','openai','google','anthropic'].includes(p) ? p : 'default');

const COLORS = ['#6c5ce7','#74b9ff','#00b894','#e17055','#fdcb6e','#a29bfe','#55efc4','#fab1a0','#81ecec','#ffeaa7','#dfe6e9','#636e72'];

function destroyCharts() { Object.values(charts).forEach(c => c.destroy()); charts = {}; }

function updateProviderDropdown() {
  const sel = $('#provider-select');
  const providers = [...new Set((currentReport?.model_totals || []).map(m => m.provider))].sort();
  sel.innerHTML = '<option value="">All Providers</option>' + providers.map(p => `<option value="${p}"${p === selectedProvider ? ' selected' : ''}>${p}</option>`).join('');
  sel.onchange = () => { selectedProvider = sel.value || null; route(); };
}

function getFilteredReport() {
  const r = currentReport;
  if (!r || !selectedProvider) return r;
  const p = selectedProvider;
  const modelTotals = (r.model_totals || []).filter(m => m.provider === p);
  const totals = { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 };
  modelTotals.forEach(m => { for (const k in totals) totals[k] += m[k] || 0; });
  const usage = r.usage?.filter(u => u.provider === p);
  const sessions = r.sessions?.filter(s => s.provider === p);
  // Recompute tool_totals from filtered usage/sessions
  const toolMap = {};
  const addTools = (src) => { if (!src) return; src.forEach(u => { if (!u.tools) return; Object.entries(u.tools).forEach(([t, v]) => { if (!toolMap[t]) toolMap[t] = { tool: t, calls: 0, input_tokens: 0, output_tokens: 0 }; if (typeof v === 'object') { toolMap[t].calls += v.calls || 0; toolMap[t].input_tokens += v.input_tokens || 0; } }); }); };
  addTools(usage);
  if (!usage?.length && sessions?.length) {
    // For session reports without per-row tools, fall back to original tool_totals (can't filter)
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
  const totals = { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 };
  const modelMap = {};
  const toolMap = {};
  const allUsage = [];
  const allSessions = [];
  const allWarnings = [];
  let minStart = null, maxEnd = null, maxDays = 0;

  reportDataList.forEach(r => {
    // totals
    Object.keys(totals).forEach(k => totals[k] += (r.totals?.[k] || 0));

    // period
    if (r.period) {
      if (!minStart || r.period.start < minStart) minStart = r.period.start;
      if (!maxEnd || r.period.end > maxEnd) maxEnd = r.period.end;
      if (r.period.days > maxDays) maxDays = r.period.days;
    }

    // model_totals — merge by provider+model
    (r.model_totals || []).forEach(m => {
      const key = m.provider + '|' + m.model;
      if (!modelMap[key]) modelMap[key] = { provider: m.provider, model: m.model, input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0 };
      ['input_tokens','output_tokens','estimated_tokens','tool_input_tokens','human_input_tokens','requests'].forEach(k => modelMap[key][k] += m[k] || 0);
    });

    // tool_totals — merge by tool name
    (r.tool_totals || []).forEach(t => {
      if (!toolMap[t.tool]) toolMap[t.tool] = { tool: t.tool, calls: 0, input_tokens: 0, output_tokens: 0 };
      toolMap[t.tool].calls += t.calls || 0;
      toolMap[t.tool].input_tokens += t.input_tokens || 0;
      toolMap[t.tool].output_tokens += t.output_tokens || 0;
    });

    // usage / sessions — concatenate
    if (r.usage) allUsage.push(...r.usage);
    if (r.sessions) allSessions.push(...r.sessions);

    // warnings — concatenate
    if (r.warnings) allWarnings.push(...r.warnings);
  });

  const days = maxDays || (minStart && maxEnd ? Math.ceil((new Date(maxEnd) - new Date(minStart)) / 86400000) : 0);

  return {
    report_type: 'combined',
    period: { start: minStart, end: maxEnd, days },
    generated_at: new Date().toISOString(),
    totals,
    model_totals: Object.values(modelMap).sort((a,b) => (b.input_tokens+b.output_tokens) - (a.input_tokens+a.output_tokens)),
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

  if (reports.length) selectReportDirect(mergeReports(allReportData));
}

function selectReportDirect(data) {
  currentReport = data;
  const navFiles = document.getElementById('nav-files');
  if (navFiles) navFiles.style.display = data.file_stats ? '' : 'none';
  updateProviderDropdown();
  route();
}

async function selectReport(filename) {
  if (filename === '__combined__') {
    selectReportDirect(mergeReports(allReportData));
    return;
  }
  const idx = reports.findIndex(r => r.filename === filename);
  if (idx >= 0) selectReportDirect(allReportData[idx]);
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
function findPricing(model) {
  const prefixes = ['anthropic/', 'openai/', 'google/', 'x-ai/', 'meta/', 'mistralai/', 'qwen/', 'deepseek/'];
  for (const p of prefixes) {
    if (pricing[p + model]) return pricing[p + model];
  }
  const key = Object.keys(pricing).find(k => k.endsWith('/' + model));
  return key ? pricing[key] : null;
}

function estimateCost(inputTokens, outputTokens, model) {
  const r = findPricing(model);
  if (!r) return null;
  return (inputTokens / 1e6) * r.prompt + (outputTokens / 1e6) * r.completion;
}

/* ── Totals row helper ── */
function totalsRow(cols) {
  return `<tr style="font-weight:700;border-top:2px solid var(--accent)">${cols.map(c => `<td class="${c.cls||''}">${c.v}</td>`).join('')}</tr>`;
}

/* ── Dashboard Page ── */
function renderDashboard() {
  const r = getFilteredReport();
  const t = r.totals;
  const totalTokens = t.input_tokens + t.output_tokens;
  const avgPerReq = t.requests ? Math.round(totalTokens / t.requests) : 0;
  const toolPct = t.input_tokens ? ((t.tool_input_tokens / t.input_tokens) * 100).toFixed(1) : 0;

  let totalCost = 0;
  (r.model_totals || []).forEach(m => {
    const c = estimateCost(m.input_tokens, m.output_tokens, m.model);
    if (c) totalCost += c;
  });

  const deadContextTypes = new Set(['duplicate_reads', 'superseded_writes', 'errored_tool_inputs', 'read_then_small_edit', 'inefficient_reads', 'unbounded_bash', 'excessive_full_reads', 'expensive_full_reads']);
  const deadWarnings = (r.warnings || []).filter(w => deadContextTypes.has(w.type));
  const deadSessions = new Set(deadWarnings.map(w => w.session_id).filter(Boolean)).size;

  const app = $('#app');
  app.innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Total Tokens</div><div class="card-value accent">${fmtM(totalTokens)}</div><div class="card-sub">${fmt(t.input_tokens)} in / ${fmt(t.output_tokens)} out</div></div>
      <div class="card"><div class="card-label">Requests</div><div class="card-value blue">${fmt(t.requests)}</div><div class="card-sub">~${fmt(avgPerReq)} tokens/req</div></div>
      <div class="card"><div class="card-label">Tool Tokens</div><div class="card-value green">${fmtM(t.tool_input_tokens)}</div><div class="card-sub">${toolPct}% of input</div></div>
      <div class="card"><div class="card-label">Human Input</div><div class="card-value">${fmtM(t.human_input_tokens || 0)}</div><div class="card-sub">${pct(t.human_input_tokens || 0, t.input_tokens)} of input</div></div>
      <div class="card"><div class="card-label">Est. API Cost</div><div class="card-value yellow">${totalCost > 0 ? '$'+totalCost.toFixed(2) : 'N/A'}</div><div class="card-sub">Based on known model rates</div></div>
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
}

function renderDashboardCharts(r) {
  if (r.usage && r.usage.length) {
    const hourly = {};
    r.usage.forEach(u => {
      const h = u.hour;
      if (!hourly[h]) hourly[h] = { input: 0, output: 0 };
      hourly[h].input += u.input_tokens;
      hourly[h].output += u.output_tokens;
    });
    // Fill in missing days with zero-value entries (one entry per day at 00:00)
    if (r.period) {
      const start = new Date(r.period.start); start.setUTCHours(0,0,0,0);
      const end = new Date(r.period.end); end.setUTCHours(0,0,0,0);
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const dayKey = d.toISOString().slice(0, 10);
        const hasDayData = Object.keys(hourly).some(h => h.startsWith(dayKey));
        if (!hasDayData) {
          hourly[dayKey + 'T00:00:00Z'] = { input: 0, output: 0 };
        }
      }
    }
    const hours = Object.keys(hourly).sort();
    charts.timeline = new Chart($('#ch-timeline'), {
      type: 'bar', data: {
        labels: hours.map(h => { const d = new Date(h); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}) + ' ' + d.getHours() + ':00'; }),
        datasets: [
          { label: 'Input', data: hours.map(h => hourly[h].input), backgroundColor: '#6c5ce7', stack: 's' },
          { label: 'Output', data: hours.map(h => hourly[h].output), backgroundColor: '#00b894', stack: 's' },
        ]
      }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } }, scales: { x: { ticks: { maxTicksLimit: 20, maxRotation: 45 } }, y: { ticks: { callback: v => fmtM(v) } } } }
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
  const models = (r.model_totals || []).sort((a,b) => (b.input_tokens+b.output_tokens) - (a.input_tokens+a.output_tokens));

  // Compute totals for footer
  const tIn = models.reduce((s,m) => s+m.input_tokens, 0);
  const tOut = models.reduce((s,m) => s+m.output_tokens, 0);
  const tTotal = tIn + tOut;
  const tTool = models.reduce((s,m) => s+m.tool_input_tokens, 0);
  const tReqs = models.reduce((s,m) => s+m.requests, 0);
  const tAvg = tReqs ? Math.round(tTotal / tReqs) : 0;
  const tRatio = tIn ? (tOut / tIn * 100).toFixed(1) : '0';
  let tCost = 0;
  models.forEach(m => { const c = estimateCost(m.input_tokens, m.output_tokens, m.model); if (c) tCost += c; });

  let tableRows = models.map(m => {
    const total = m.input_tokens + m.output_tokens;
    const cost = estimateCost(m.input_tokens, m.output_tokens, m.model);
    const rate = findPricing(m.model);
    const ioRatio = m.input_tokens ? (m.output_tokens / m.input_tokens * 100).toFixed(1) : '0';
    const avgPerReq = m.requests ? Math.round(total / m.requests) : 0;
    return `<tr>
      <td><span class="${badgeClass(m.provider)}">${m.provider}</span></td>
      <td>${m.model}</td>
      <td class="num">${fmt(m.input_tokens)}</td>
      <td class="num">${fmt(m.output_tokens)}</td>
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
    {v:'',cls:''},{v:'Total',cls:''},
    {v:fmt(tIn),cls:'num'},{v:fmt(tOut),cls:'num'},{v:fmt(tTotal),cls:'num'},
    {v:fmt(tTool),cls:'num'},{v:fmt(tHuman),cls:'num'},{v:fmt(tReqs),cls:'num'},{v:fmt(tAvg),cls:'num'},
    {v:tRatio+'%',cls:'num'},{v:'',cls:'num'},{v:'',cls:'num'},
    {v:tCost>0?'$'+tCost.toFixed(2):'—',cls:'num'},
  ]);

  const grandTotal = r.totals.input_tokens + r.totals.output_tokens;
  const byTokens = [...models].sort((a,b) => (b.input_tokens+b.output_tokens) - (a.input_tokens+a.output_tokens));
  const byReqs = [...models].sort((a,b) => b.requests - a.requests);

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Total Models</div><div class="card-value accent">${models.length}</div></div>
      <div class="card"><div class="card-label">Providers</div><div class="card-value blue">${new Set(models.map(m=>m.provider)).size}</div></div>
      <div class="card"><div class="card-label">Most Used Model</div><div class="card-value" style="font-size:1rem">${byTokens[0]?.model || '—'}</div><div class="card-sub">${byTokens[0] ? pct(byTokens[0].input_tokens+byTokens[0].output_tokens, grandTotal)+' of tokens' : ''}</div></div>
      <div class="card"><div class="card-label">Most Requests</div><div class="card-value" style="font-size:1rem">${byReqs[0]?.model||'—'}</div><div class="card-sub">${fmt(byReqs[0]?.requests)} requests</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Token Distribution by Model</h3><div class="chart-wrap"><canvas id="ch-model-tokens"></canvas></div></div>
      <div class="chart-box"><h3>Input vs Output by Model</h3><div class="chart-wrap"><canvas id="ch-model-io"></canvas></div></div>
    </div>
    <div class="table-box"><h3>Model Details</h3>
      <table><thead><tr><th>Provider</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Total</th><th class="num">Tool Tokens</th><th class="num">Human Input</th><th class="num">Requests</th><th class="num">Avg/Req</th><th class="num">Out/In</th><th class="num">$/1M In</th><th class="num">$/1M Out</th><th class="num">Est. Cost</th></tr></thead>
      <tbody>${tableRows}</tbody></table>
    </div>`;

  const top = byTokens.slice(0, 8);
  charts.modelTokens = new Chart($('#ch-model-tokens'), {
    type: 'doughnut', data: { labels: top.map(m => m.model), datasets: [{ data: top.map(m => m.input_tokens + m.output_tokens), backgroundColor: COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
  charts.modelIO = new Chart($('#ch-model-io'), {
    type: 'bar', data: {
      labels: top.map(m => m.model),
      datasets: [
        { label: 'Input', data: top.map(m => m.input_tokens), backgroundColor: '#6c5ce7' },
        { label: 'Output', data: top.map(m => m.output_tokens), backgroundColor: '#00b894' },
      ]
    }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { position: 'top' } } }
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

  const byHour = {}, byDay = {}, byDayProvider = {};
  usage.forEach(u => {
    const h = u.hour || u.started_at;
    if (!h) return;
    const hourKey = h.slice(0, 13) + ':00:00Z';
    const dayKey = h.slice(0, 10);
    const hourNum = new Date(h).getUTCHours();

    if (!byHour[hourKey]) byHour[hourKey] = { input: 0, output: 0, requests: 0 };
    byHour[hourKey].input += u.input_tokens;
    byHour[hourKey].output += u.output_tokens;
    byHour[hourKey].requests += u.requests;

    if (!byDay[dayKey]) byDay[dayKey] = { input: 0, output: 0, requests: 0, hours: new Set() };
    byDay[dayKey].input += u.input_tokens;
    byDay[dayKey].output += u.output_tokens;
    byDay[dayKey].requests += u.requests;
    byDay[dayKey].hours.add(hourNum);

    const pk = dayKey + '|' + (u.provider || 'unknown');
    if (!byDayProvider[pk]) byDayProvider[pk] = { day: dayKey, provider: u.provider || 'unknown', input: 0, output: 0, requests: 0 };
    byDayProvider[pk].input += u.input_tokens;
    byDayProvider[pk].output += u.output_tokens;
    byDayProvider[pk].requests += u.requests;
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
  const peakDay = days.reduce((best, d) => byDay[d].input > (byDay[best]?.input || 0) ? d : best, days[0]);
  const avgDaily = days.length ? Math.round(days.reduce((s,d) => s + byDay[d].requests, 0) / days.length) : 0;
  const activeHoursAvg = days.length ? (days.reduce((s,d) => s + byDay[d].hours.size, 0) / days.length).toFixed(1) : 0;

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
  const tReqs = days.reduce((s,d) => s+byDay[d].requests, 0);
  const tHours = days.reduce((s,d) => s+byDay[d].hours.size, 0);

  let dayRows = days.map(d => {
    const dd = byDay[d];
    return `<tr><td>${new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</td><td class="num">${fmt(dd.input)}</td><td class="num">${fmt(dd.output)}</td><td class="num">${fmt(dd.requests)}</td><td class="num">${dd.hours.size}h</td></tr>`;
  }).join('');

  dayRows += totalsRow([
    {v:'Total',cls:''},{v:fmt(tIn),cls:'num'},{v:fmt(tOut),cls:'num'},
    {v:fmt(tReqs),cls:'num'},{v:tHours+'h',cls:'num'},
  ]);

  $('#app').innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Active Days</div><div class="card-value accent">${days.length}</div></div>
      <div class="card"><div class="card-label">Avg Requests/Day</div><div class="card-value blue">${fmt(avgDaily)}</div></div>
      <div class="card"><div class="card-label">Avg Active Hours/Day</div><div class="card-value green">${activeHoursAvg}</div></div>
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
      <table><thead><tr><th>Day</th><th class="num">Input Tokens</th><th class="num">Output Tokens</th><th class="num">Requests</th><th class="num">Active Hours</th></tr></thead>
      <tbody>${dayRows}</tbody></table>
    </div>`;

  charts.daily = new Chart($('#ch-daily'), {
    type: 'bar', data: {
      labels: days.map(d => new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric'})),
      datasets: [
        { label: 'Input', data: days.map(d => byDay[d].input), backgroundColor: '#6c5ce7', stack: 's' },
        { label: 'Output', data: days.map(d => byDay[d].output), backgroundColor: '#00b894', stack: 's' },
      ]
    }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => fmtM(v) } } }, plugins: { legend: { position: 'top' } } }
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
  const totalTokens = sorted.reduce((s,x) => s + x.input_tokens + x.output_tokens, 0);
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
    const total = s.input_tokens + s.output_tokens;
    const cost = estimateCost(s.input_tokens, s.output_tokens, s.model);
    if (cost) totalCost += cost;
    const hasDetail = (s.agents && Object.keys(s.agents).length > 0) || (s.tool_timeline && s.tool_timeline.length > 0) || warnsBySession[s.session_id];
    const toolCalls = s.tool_calls || 0;
    const agentCount = s.agents ? Object.keys(s.agents).length : 0;
    const fileCount = s.files ? s.files.length : null;
    const fc = s.file_changes;
    const changesCell = fc ? `<span style="color:#00b894">+${fmt(fc.additions)}</span> <span style="color:#d63031">-${fmt(fc.deletions)}</span>` : '\u2014';
    const sessWarnCount = warnsBySession[s.session_id] || 0;
    const colCount = fileCount !== null ? 15 : 14;
    return `<tr class="${hasDetail ? 'session-detail' : ''}" ${hasDetail ? `onclick="toggleSessionDetail(${idx})"` : ''}>
      <td>${s.session_title || s.session_id?.slice(0,8) || '\u2014'}</td>
      <td><span class="${badgeClass(s.provider)}">${s.provider}</span></td>
      <td>${s.model}</td>
      <td class="num">${fmt(total)}</td>
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
    {v:fmt(totalTokens),cls:'num'},{v:fmt(totalReqs),cls:'num'},
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
      <div class="card"><div class="card-label">Projects</div><div class="card-value green">${dirs.size}</div></div>
      <div class="card"><div class="card-label">Est. Total Cost</div><div class="card-value yellow">${totalCost > 0 ? '$'+totalCost.toFixed(2) : 'N/A'}</div></div>
      ${warnCard}
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Sessions by Provider</h3><div class="chart-wrap"><canvas id="ch-sess-prov"></canvas></div></div>
      <div class="chart-box"><h3>Tokens by Model</h3><div class="chart-wrap"><canvas id="ch-sess-model"></canvas></div></div>
    </div>
    <div class="table-box"><h3>All Sessions <span style="font-size:0.75rem;color:var(--text2);font-weight:normal">(click rows with agent/tool data to expand)</span></h3>
      <table><thead><tr><th>Title</th><th>Provider</th><th>Model</th><th class="num">Tokens</th><th class="num">Requests</th><th class="num">Agents</th><th class="num">Tool Calls</th><th class="num">Tool Tokens</th><th class="num">Est. Cost</th><th class="num">Duration</th><th class="num">Changes</th><th class="num">⚠</th><th>Project</th><th>Started</th>${hasFileData ? '<th class="num"><a href="#/files" style="color:var(--accent2)">Files ↗</a></th>' : ''}</tr></thead>
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
  sorted.forEach(s => { const k = s.model; modelAgg[k] = (modelAgg[k]||0) + s.input_tokens + s.output_tokens; });
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
