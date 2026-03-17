'use strict';
/* ── State ── */
let reports = [];
let allReportData = [];
let currentReport = null;
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

Chart.defaults.color = '#8b8fa8';
Chart.defaults.borderColor = '#2e3348';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
Chart.defaults.font.size = 11;

/* ── Merge reports ── */
function mergeReports(reportDataList) {
  const totals = { input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 };
  const modelMap = {};
  const toolMap = {};
  const allUsage = [];
  const allSessions = [];
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
      if (!modelMap[key]) modelMap[key] = { provider: m.provider, model: m.model, input_tokens: 0, output_tokens: 0, estimated_tokens: 0, tool_input_tokens: 0, requests: 0 };
      ['input_tokens','output_tokens','estimated_tokens','tool_input_tokens','requests'].forEach(k => modelMap[key][k] += m[k] || 0);
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
  const pages = { dashboard: renderDashboard, models: renderModels, tools: renderTools, timeline: renderTimeline };
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
  const r = currentReport;
  const t = r.totals;
  const totalTokens = t.input_tokens + t.output_tokens;
  const avgPerReq = t.requests ? Math.round(totalTokens / t.requests) : 0;
  const toolPct = t.input_tokens ? ((t.tool_input_tokens / t.input_tokens) * 100).toFixed(1) : 0;

  let totalCost = 0;
  (r.model_totals || []).forEach(m => {
    const c = estimateCost(m.input_tokens, m.output_tokens, m.model);
    if (c) totalCost += c;
  });

  const app = $('#app');
  app.innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">Total Tokens</div><div class="card-value accent">${fmtM(totalTokens)}</div><div class="card-sub">${fmt(t.input_tokens)} in / ${fmt(t.output_tokens)} out</div></div>
      <div class="card"><div class="card-label">Requests</div><div class="card-value blue">${fmt(t.requests)}</div><div class="card-sub">~${fmt(avgPerReq)} tokens/req</div></div>
      <div class="card"><div class="card-label">Tool Tokens</div><div class="card-value green">${fmtM(t.tool_input_tokens)}</div><div class="card-sub">${toolPct}% of input</div></div>
      <div class="card"><div class="card-label">Est. API Cost</div><div class="card-value yellow">${totalCost > 0 ? '$'+totalCost.toFixed(2) : 'N/A'}</div><div class="card-sub">Based on known model rates</div></div>
      <div class="card"><div class="card-label">Models Used</div><div class="card-value">${(r.model_totals||[]).length}</div><div class="card-sub">${new Set((r.model_totals||[]).map(m=>m.provider)).size} providers</div></div>
      <div class="card"><div class="card-label">Period</div><div class="card-value" style="font-size:1.1rem">${r.period.days}d</div><div class="card-sub">${new Date(r.period.start).toLocaleDateString()} – ${new Date(r.period.end).toLocaleDateString()}</div></div>
    </div>
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
  const r = currentReport;
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
      <td class="num">${fmt(m.requests)}</td>
      <td class="num">${fmt(avgPerReq)}</td>
      <td class="num">${ioRatio}%</td>
      <td class="num">${rate ? '$'+rate.prompt.toFixed(2) : '—'}</td>
      <td class="num">${rate ? '$'+rate.completion.toFixed(2) : '—'}</td>
      <td class="num">${cost != null ? '$'+cost.toFixed(2) : '—'}</td>
    </tr>`;
  }).join('');

  tableRows += totalsRow([
    {v:'',cls:''},{v:'Total',cls:''},
    {v:fmt(tIn),cls:'num'},{v:fmt(tOut),cls:'num'},{v:fmt(tTotal),cls:'num'},
    {v:fmt(tTool),cls:'num'},{v:fmt(tReqs),cls:'num'},{v:fmt(tAvg),cls:'num'},
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
      <table><thead><tr><th>Provider</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Total</th><th class="num">Tool Tokens</th><th class="num">Requests</th><th class="num">Avg/Req</th><th class="num">Out/In</th><th class="num">$/1M In</th><th class="num">$/1M Out</th><th class="num">Est. Cost</th></tr></thead>
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
  const r = currentReport;
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
  const r = currentReport;
  const usage = r.usage || r.sessions || [];

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
}

/* ── Init ── */
loadReports();
