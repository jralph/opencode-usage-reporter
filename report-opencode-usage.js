#!/usr/bin/env node

// Orchestrator — reads usage data from each available adapter, merges the
// records, and generates hourly or per-session reports.
//
// Adapters live in `./adapters/*.js` and each export:
//   { name, isAvailable(), collect({ cutoff, useRealSessionName }) => records[] }
// Records carry a `tool` field identifying the source CLI.

const fs = require('fs');
const { releaseTokenizer } = require('./lib/tokenize');

const ADAPTERS = [
  require('./adapters/opencode'),
  require('./adapters/kiro'),
  require('./adapters/kiro-ide'),
  require('./adapters/claude-code'),
  require('./adapters/codex'),
  require('./adapters/cursor'),
  require('./adapters/copilot-cli'),
  require('./adapters/copilot-vscode'),
];
const ADAPTER_NAMES = ADAPTERS.map(a => a.name);

// --- CLI parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    days: 7, report: 'hours', output: null, summaryOnly: false,
    useRealSessionName: false, tools: null, format: 'per-tool',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1], 10) || 7;
    if (args[i] === '--report' && args[i + 1]) opts.report = args[i + 1];
    if (args[i] === '--format' && args[i + 1]) opts.format = args[i + 1];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[i + 1];
    if (args[i] === '--summary-only') opts.summaryOnly = true;
    if (args[i] === '--use-real-session-name') opts.useRealSessionName = true;
    if (args[i] === '--tool' && args[i + 1]) {
      const list = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      opts.tools = (opts.tools || []).concat(list);
    }
    if (args[i] === '--list-tools') opts.listTools = true;
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: coding-usage [options]

Options:
  --days <n>              Number of days to report on (default: 7)
  --report <hours|sessions>  Report type (default: hours)
  --format <per-tool|combined|legacy>  Output schema (default: per-tool)
                           per-tool: rows split per CLI everywhere (cli_tool on
                                     every row). Lossless multi-CLI fidelity.
                                     Dashboard renders each CLI grouping
                                     separately and can filter by source.
                           combined: dashboard-native keying (rows merged across
                                     CLIs by provider/model/tool) plus additive
                                     multi-tool fields (cli_tool_totals,
                                     sources.tools, cli_tool on sessions/warnings).
                           legacy:   pre-multi-tool shape, byte-for-byte back-compat.
                                     No cli_tool fields, no cli_tool_totals, no
                                     sources.tools.
  --tool <name[,name...]>  Restrict to specific CLI tools. Repeatable and comma-separated.
                           Available: ${ADAPTER_NAMES.join(', ')}, all
                           Default: all detected tools
  --list-tools            List detected tools and exit
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
  if (!['combined', 'per-tool', 'legacy'].includes(opts.format)) {
    console.error(`Invalid format: "${opts.format}". Use "combined", "per-tool", or "legacy".`);
    process.exit(1);
  }
  if (opts.tools) {
    // Expand `all`, validate the rest.
    const expanded = new Set();
    for (const t of opts.tools) {
      if (t === 'all') { for (const n of ADAPTER_NAMES) expanded.add(n); continue; }
      if (!ADAPTER_NAMES.includes(t)) {
        console.error(`Unknown tool: "${t}". Available: ${ADAPTER_NAMES.join(', ')}, all`);
        process.exit(1);
      }
      expanded.add(t);
    }
    opts.tools = [...expanded];
  }
  return opts;
}

// --- Record collection ---

function collectFromAdapters(cutoff, useRealSessionName, selectedTools) {
  const active = [];
  const skipped = [];
  for (const adapter of ADAPTERS) {
    const selected = !selectedTools || selectedTools.includes(adapter.name);
    if (!selected) { skipped.push(`${adapter.name} (filtered)`); continue; }
    let available = false;
    try { available = adapter.isAvailable(); } catch { available = false; }
    if (!available) { skipped.push(`${adapter.name} (not installed)`); continue; }
    active.push(adapter);
  }
  console.error(`Active: ${active.map(a => a.name).join(', ') || 'none'}`);
  if (skipped.length) console.error(`Skipped: ${skipped.join(', ')}`);

  const records = [];
  const perTool = {};
  for (const adapter of active) {
    let part = [];
    try {
      part = adapter.collect({ cutoff, useRealSessionName }) || [];
    } catch (err) {
      console.error(`[${adapter.name}] adapter failed: ${err.message}`);
    }
    for (const r of part) {
      records.push(r);
      perTool[r.tool || adapter.name] = (perTool[r.tool || adapter.name] || 0) + 1;
    }
  }
  return { records, perTool, active: active.map(a => a.name) };
}

// --- Report generation (reused aggregation) ---

function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function recordBillableTokens(r) {
  return (r.inputTokens || 0)
    + (r.outputTokens || 0)
    + (r.cacheReadTokens || 0)
    + (r.cacheCreationTokens || 0);
}

function isRequestRecord(r) {
  return recordBillableTokens(r) > 0 || (Array.isArray(r.tools) && r.tools.length > 0);
}

// Aggregation keying depends on --format:
//   per-tool → keep cli_tool in the key and output
//   combined → drop cli_tool from the key (rows merge across CLIs) but keep
//              additive cli_tool_totals + sources at top level
//   legacy   → drop cli_tool entirely from rows; top-level cli_tool_totals and
//              sources are omitted by the report builders

function aggregateTools(records, format) {
  const map = new Map();
  for (const r of records) {
    for (const t of r.tools) {
      const key = format === 'per-tool' ? `${r.tool}|${t.tool}` : t.tool;
      if (!map.has(key)) {
        const base = { tool: t.tool, calls: 0, input_tokens: 0, output_tokens: 0 };
        if (format === 'per-tool') base.cli_tool = r.tool;
        map.set(key, base);
      }
      const b = map.get(key);
      b.calls++;
      b.input_tokens += t.inputTokens;
      b.output_tokens += t.outputTokens;
    }
  }
  return [...map.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
}

function buildModelTotals(records, format) {
  const map = new Map();
  for (const r of records) {
    const key = format === 'per-tool' ? `${r.tool}|${r.provider}|${r.model}` : `${r.provider}|${r.model}`;
    if (!map.has(key)) {
      const base = {
        provider: r.provider, model: r.model,
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        estimated_tokens: 0, tool_input_tokens: 0,
        human_input_tokens: 0, requests: 0,
      };
      if (format === 'per-tool') base.cli_tool = r.tool;
      map.set(key, base);
    }
    const b = map.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    b.cache_read_tokens += r.cacheReadTokens || 0;
    b.cache_creation_tokens += r.cacheCreationTokens || 0;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) b.tool_input_tokens += t.inputTokens;
    if (isRequestRecord(r)) b.requests++;
  }
  return [...map.values()].sort((a, b) =>
    (b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_creation_tokens)
    - (a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_creation_tokens));
}

function buildCliToolTotals(records) {
  // Always keyed by cli_tool — produces the top-level cli_tool_totals array
  // in per-tool and combined formats. Not emitted in legacy.
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.tool)) map.set(r.tool, {
      cli_tool: r.tool,
      input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      estimated_tokens: 0,
      tool_input_tokens: 0, tool_output_tokens: 0,
      human_input_tokens: 0, requests: 0, sessions: new Set(), tool_calls: 0,
      earliest_ms: Infinity, latest_ms: -Infinity,
    });
    const b = map.get(r.tool);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    b.cache_read_tokens += r.cacheReadTokens || 0;
    b.cache_creation_tokens += r.cacheCreationTokens || 0;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) {
      b.tool_input_tokens += t.inputTokens;
      b.tool_output_tokens += t.outputTokens;
      b.tool_calls++;
    }
    if (isRequestRecord(r)) b.requests++;
    b.sessions.add(r.sessionId);
    if (typeof r.created === 'number' && r.created > 0) {
      if (r.created < b.earliest_ms) b.earliest_ms = r.created;
      if (r.created > b.latest_ms) b.latest_ms = r.created;
    }
  }
  return [...map.values()].map(b => {
    const earliest = Number.isFinite(b.earliest_ms) ? new Date(b.earliest_ms).toISOString() : null;
    const latest = Number.isFinite(b.latest_ms) ? new Date(b.latest_ms).toISOString() : null;
    const { earliest_ms, latest_ms, ...rest } = b;
    return { ...rest, sessions: b.sessions.size, earliest_record: earliest, latest_record: latest };
  })
    .sort((a, b) =>
      (b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_creation_tokens)
      - (a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_creation_tokens));
}

function buildSessionDetails(records, useRealSessionName, format) {
  const buckets = new Map();

  for (const r of records) {
    const key = `${r.tool}|${r.sessionId}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      const base = {
        session_id: r.sessionId,
        session_title: r.sessionTitle,
        directory: r.directory,
        started_at: r.created,
        ended_at: r.completed || r.created,
        provider: r.provider,
        model: r.model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_tokens: 0,
        tool_input_tokens: 0,
        tool_output_tokens: 0,
        tool_calls: 0,
        human_input_tokens: 0,
        requests: 0,
        agents: {},
        tool_timeline: [],
      };
      // cli_tool is retained in per-tool and combined modes (sessions are
      // uniquely keyed by session_id either way, so it's additive). Dropped
      // only for strict legacy back-compat.
      if (format !== 'legacy') base.cli_tool = r.tool;
      buckets.set(key, base);
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    b.cache_read_tokens += r.cacheReadTokens || 0;
    b.cache_creation_tokens += r.cacheCreationTokens || 0;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) {
      b.tool_input_tokens += t.inputTokens;
      b.tool_output_tokens += t.outputTokens;
      b.tool_calls++;
    }
    if (isRequestRecord(r)) b.requests++;
    if (r.created < b.started_at) b.started_at = r.created;
    const end = r.completed || r.created;
    if (end > b.ended_at) b.ended_at = end;

    if (r.agent) {
      if (!b.agents[r.agent]) b.agents[r.agent] = { requests: 0, input_tokens: 0, output_tokens: 0, model: r.model };
      if (isRequestRecord(r)) b.agents[r.agent].requests++;
      b.agents[r.agent].input_tokens += r.inputTokens;
      b.agents[r.agent].output_tokens += r.outputTokens;
      if (r.model) b.agents[r.agent].model = r.model;
    }

    for (const te of r.toolEvents) {
      if (te.start && te.end) {
        b.tool_timeline.push({ tool: te.tool, start: te.start, end: te.end, tokens: te.tokens, depth: te.depth || 0, title: te.title });
      }
    }

    for (const te of r.toolEvents) {
      if (!te.args?.filePath || !['read', 'edit', 'write'].includes(te.tool)) continue;
      if (!b.fileChanges) b.fileChanges = { reads: 0, edits: 0, writes: 0, full_reads: 0, full_read_tokens: 0, unique_files: new Set(), additions: 0, deletions: 0 };
      b.fileChanges[te.tool === 'read' ? 'reads' : te.tool === 'edit' ? 'edits' : 'writes']++;
      b.fileChanges.unique_files.add(te.args.filePath);
      if (te.tool === 'read' && !te.args.offset && !te.args.limit && !te.args.startLine && !te.args.endLine && !te.args.start_line && !te.args.end_line) {
        b.fileChanges.full_reads++;
        b.fileChanges.full_read_tokens += te.tokens || 0;
      }
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

function buildFileStats(sessions, useRealSessionName) {
  if (!useRealSessionName) return undefined;
  const map = new Map();
  for (const s of sessions) {
    if (!s.files) continue;
    for (const f of s.files) {
      if (!map.has(f.path)) {
        map.set(f.path, { path: f.path, calls: 0, input_tokens: 0, sessions: 0, directory: s.directory || null, tools: {} });
      }
      const entry = map.get(f.path);
      entry.calls += f.calls;
      entry.input_tokens += f.input_tokens;
      entry.sessions++;
      for (const [tool, count] of Object.entries(f.tools)) {
        entry.tools[tool] = (entry.tools[tool] || 0) + count;
      }
    }
  }
  if (map.size === 0) return undefined;
  return [...map.values()].sort((a, b) => b.input_tokens - a.input_tokens);
}

// --- Warnings / waste detection ---

function detectWarnings(records, sessionDetails, format, period, cliTotals) {
  const warnings = [];
  // `cli_tool` is emitted on warnings in per-tool and combined formats.
  // Legacy mode drops it entirely.
  const addCli = format !== 'legacy';
  const pushWarn = (w) => {
    if (!addCli) delete w.cli_tool;
    warnings.push(w);
  };

  // Data-availability warnings. Some CLIs rotate/truncate their local history
  // (notably Kiro, Cursor). If a tool's earliest record is significantly
  // newer than the requested period.start, surface that so the dashboard can
  // flag the coverage gap. Ordering matters — emit these first so the UI
  // can show them as a banner.
  if (period && period.start && Array.isArray(cliTotals)) {
    const periodStartMs = Date.parse(period.start);
    if (Number.isFinite(periodStartMs)) {
      // A gap larger than 2 days counts as meaningful missing coverage; less
      // is just "you haven't used that CLI for a bit."
      const GAP_MS = 2 * 24 * 60 * 60 * 1000;
      for (const c of cliTotals) {
        if (!c.earliest_record) continue;
        const earliestMs = Date.parse(c.earliest_record);
        if (!Number.isFinite(earliestMs)) continue;
        const gap = earliestMs - periodStartMs;
        if (gap > GAP_MS) {
          const days = Math.round(gap / (24 * 60 * 60 * 1000));
          pushWarn({
            type: 'data_availability',
            severity: 'info',
            cli_tool: c.cli_tool,
            detail: `No ${c.cli_tool} records for the first ${days} day${days === 1 ? '' : 's'} of the requested period. This tool may have been unused before that date, or its local history may have been rotated/purged — totals for earlier dates are missing.`,
            earliest_record: c.earliest_record,
            latest_record: c.latest_record,
            period_start: period.start,
          });
        }
      }
    }
  }

  for (const s of sessionDetails) {
    const cliTool = s.cli_tool;  // present on every record pre-strip
    if (s.requests > 40) {
      pushWarn({ type: 'excessive_iteration', severity: 'severe', cli_tool: cliTool, session_id: s.session_id,
        detail: `${s.requests} requests in session ${s.session_id}. Possible thrashing or micromanagement.` });
    }
    if (s.requests > 5 && s.tool_calls === 0) {
      pushWarn({ type: 'wasted_compute', severity: 'severe', cli_tool: cliTool, session_id: s.session_id,
        detail: `${s.requests} requests with zero tool calls in session ${s.session_id}. Tokens burned with no tool usage.` });
    }
    const totalTok = s.input_tokens + s.output_tokens;
    const toolOutTok = s.tool_output_tokens || 0;
    if (toolOutTok > 0 && totalTok / toolOutTok > 50) {
      pushWarn({ type: 'low_token_efficiency', severity: 'warn', cli_tool: cliTool, session_id: s.session_id,
        detail: `${Math.round(totalTok / toolOutTok)}:1 token ratio in session ${s.session_id}. High context overhead for output produced.` });
    }
    if (s.output_tokens > s.input_tokens && s.output_tokens > 5000) {
      pushWarn({ type: 'output_heavy', severity: 'info', cli_tool: cliTool, session_id: s.session_id,
        detail: `${s.output_tokens} output vs ${s.input_tokens} input in session ${s.session_id}. Unusually verbose generation.` });
    }
    if (s.started_at && s.ended_at) {
      const dur = new Date(s.ended_at) - new Date(s.started_at);
      if (dur > 30 * 60 * 1000) {
        const mins = Math.round(dur / 60000);
        pushWarn({ type: 'long_running', severity: 'info', cli_tool: cliTool, session_id: s.session_id,
          detail: `${mins}m duration for session ${s.session_id}. May indicate stuck or slow processing.` });
      }
    }
    if (s.file_changes) {
      const fc = s.file_changes;
      if (fc.full_reads > 10) {
        pushWarn({ type: 'excessive_full_reads', severity: 'warn', cli_tool: cliTool, session_id: s.session_id,
          detail: `${fc.full_reads} full-file reads (${fc.full_read_tokens} tokens) in session ${s.session_id}. Use partial reads to reduce context.` });
      } else if (fc.full_read_tokens > 50000) {
        pushWarn({ type: 'expensive_full_reads', severity: 'warn', cli_tool: cliTool, session_id: s.session_id,
          detail: `${fc.full_read_tokens} tokens from ${fc.full_reads} full-file reads in session ${s.session_id}. Large files being read entirely.` });
      }
    }
  }

  const boundedPipe = /\|\s*(head|tail|wc|grep|awk|sed|cut|sort|uniq|less|more)\b/;
  const bySession = new Map();
  for (const r of records) {
    const key = `${r.tool}|${r.sessionId}`;
    if (!bySession.has(key)) bySession.set(key, { cli_tool: r.tool, sessionId: r.sessionId, events: [] });
    bySession.get(key).events.push(...r.toolEvents);
  }
  // Sort events chronologically so sequential-pair detectors (read_then_small_edit,
  // superseded_writes, duplicate_reads) see them in time order regardless of which
  // adapter emitted them or in what order the orchestrator concatenated records.
  for (const [, bucket] of bySession) {
    bucket.events.sort((a, b) => (a.start || 0) - (b.start || 0));
  }
  for (const [, { cli_tool, sessionId: sid, events }] of bySession) {
    const fullReads = events.filter(te => te.tool === 'read' && te.args && !te.args.offset && !te.args.limit && !te.args.startLine && !te.args.endLine && !te.args.start_line && !te.args.end_line);
    if (fullReads.length > 5) {
      const totalTok = fullReads.reduce((s, te) => s + (te.tokens || 0), 0);
      pushWarn({ type: 'inefficient_reads', severity: 'warn', cli_tool, session_id: sid,
        detail: `${fullReads.length} full-file reads without offset/limit (${totalTok} tokens) in session ${sid}. Use partial reads to reduce context.` });
    }
    const unbounded = events.filter(te => te.tool === 'bash' && (te.args?.command || te.args?.cmd) && !boundedPipe.test(te.args?.command || te.args?.cmd || '') && (te.tokens || 0) > 2000);
    if (unbounded.length > 0) {
      pushWarn({ type: 'unbounded_bash', severity: 'warn', cli_tool, session_id: sid,
        detail: `${unbounded.length} bash commands with >2k output tokens and no pipe to head/tail/grep in session ${sid}. Pipe output to limit context waste.` });
    }
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
      pushWarn({ type: 'read_then_small_edit', severity: 'warn', cli_tool, session_id: sid,
        detail: `${rse} full-file reads followed by small edits in session ${sid}. Partial reads would reduce token waste.` });
    }

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
      pushWarn({ type: 'duplicate_reads', severity: 'warn', cli_tool, session_id: sid,
        detail: `${dupReadCount} duplicate file reads (${dupReadTokens} tokens) in session ${sid}. Same file read multiple times with same params.` });
    }

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
      pushWarn({ type: 'superseded_writes', severity: 'info', cli_tool, session_id: sid,
        detail: `${supersededCount} writes superseded by later reads (~${supersededTokens} tokens) in session ${sid}. Write content became stale context.` });
    }

    const errored = events.filter(te => te.error && (te.tokens || 0) > 500);
    if (errored.length > 0) {
      const erroredTokens = errored.reduce((s, te) => s + (te.tokens || 0), 0);
      pushWarn({ type: 'errored_tool_inputs', severity: 'warn', cli_tool, session_id: sid,
        detail: `${errored.length} errored tool calls (${erroredTokens} tokens) in session ${sid}. Failed tool inputs wasted context.` });
    }
  }

  // Tool dominance / expensive-tool detection — always computed from records
  // (independent of emitted tool_totals shape) so that legacy/combined outputs
  // still benefit from per-CLI scoping internally.
  const cliToolUsage = new Map();   // cli_tool -> { total, tools: Map<name, {calls, tokens}> }
  for (const r of records) {
    if (!cliToolUsage.has(r.tool)) cliToolUsage.set(r.tool, { total: 0, tools: new Map() });
    const bucket = cliToolUsage.get(r.tool);
    for (const t of r.tools) {
      const tok = (t.inputTokens || 0) + (t.outputTokens || 0);
      bucket.total += tok;
      if (!bucket.tools.has(t.tool)) bucket.tools.set(t.tool, { calls: 0, tokens: 0 });
      const tb = bucket.tools.get(t.tool);
      tb.calls++;
      tb.tokens += tok;
    }
  }
  for (const [cliTool, { total, tools }] of cliToolUsage) {
    for (const [toolName, { calls, tokens }] of tools) {
      if (total > 10000 && tokens / total > 0.6) {
        pushWarn({ type: 'tool_dominance', severity: 'info', cli_tool: cliTool,
          detail: `"${toolName}" accounts for ${Math.round(tokens / total * 100)}% of ${cliTool} tool tokens (${tokens}). May indicate over-reliance.` });
      }
      if (tokens > 100000) {
        pushWarn({ type: 'expensive_tool', severity: 'warn', cli_tool: cliTool,
          detail: `"${toolName}" (${cliTool}) consumed ${tokens} tokens across ${calls} calls. Consider optimizing usage.` });
      }
    }
  }

  return warnings;
}

function buildHourlyReport(records, period, sources, useRealSessionName, format) {
  const buckets = new Map();

  for (const r of records) {
    const hour = floorToHour(r.created);
    const key = format === 'per-tool'
      ? `${hour}|${r.tool}|${r.provider}|${r.model}`
      : `${hour}|${r.provider}|${r.model}`;
    if (!buckets.has(key)) {
      const base = {
        hour, provider: r.provider, model: r.model,
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0,
        requests: 0, tools: new Map(),
      };
      if (format === 'per-tool') base.cli_tool = r.tool;
      buckets.set(key, base);
    }
    const b = buckets.get(key);
    b.input_tokens += r.inputTokens;
    b.output_tokens += r.outputTokens;
    b.cache_read_tokens += r.cacheReadTokens || 0;
    b.cache_creation_tokens += r.cacheCreationTokens || 0;
    if (r.estimated) b.estimated_tokens += r.inputTokens + r.outputTokens;
    b.human_input_tokens += r.humanInputTokens;
    for (const t of r.tools) {
      b.tool_input_tokens += t.inputTokens;
      if (!b.tools.has(t.tool)) b.tools.set(t.tool, { calls: 0, input_tokens: 0 });
      const tb = b.tools.get(t.tool);
      tb.calls++;
      tb.input_tokens += t.inputTokens;
    }
    if (isRequestRecord(r)) b.requests++;
  }

  const usage = [...buckets.values()]
    .map(b => ({ ...b, tools: Object.fromEntries(b.tools) }))
    .sort((a, b) => a.hour.localeCompare(b.hour) || (a.cli_tool || '').localeCompare(b.cli_tool || '') || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const totals = usage.reduce((t, u) => {
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
    t.cache_read_tokens += u.cache_read_tokens;
    t.cache_creation_tokens += u.cache_creation_tokens;
    t.estimated_tokens += u.estimated_tokens;
    t.tool_input_tokens += u.tool_input_tokens;
    t.human_input_tokens += u.human_input_tokens;
    t.requests += u.requests;
    return t;
  }, {
    input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0,
  });

  const model_totals = buildModelTotals(records, format);
  const tool_totals = aggregateTools(records, format);
  const sessions = buildSessionDetails(records, useRealSessionName, format);
  const cli_tool_totals = buildCliToolTotals(records);
  const warnings = detectWarnings(records, sessions, format, period, cli_tool_totals);
  const file_stats = buildFileStats(sessions, useRealSessionName);

  const report = { report_type: 'hourly', period, generated_at: new Date().toISOString(), totals };
  if (format !== 'legacy') {
    report.sources = sources;
    report.cli_tool_totals = cli_tool_totals;
  }
  report.model_totals = model_totals;
  report.tool_totals = tool_totals;
  report.warnings = warnings;
  report.file_stats = file_stats;
  report.sessions = sessions;
  report.usage = usage;
  return report;
}

function buildSessionsReport(records, period, sources, useRealSessionName, format) {
  const sessions = buildSessionDetails(records, useRealSessionName, format);

  const totals = sessions.reduce((t, s) => {
    t.input_tokens += s.input_tokens;
    t.output_tokens += s.output_tokens;
    t.cache_read_tokens += s.cache_read_tokens || 0;
    t.cache_creation_tokens += s.cache_creation_tokens || 0;
    t.estimated_tokens += s.estimated_tokens;
    t.tool_input_tokens += s.tool_input_tokens;
    t.human_input_tokens += s.human_input_tokens;
    t.requests += s.requests;
    return t;
  }, {
    input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    estimated_tokens: 0, tool_input_tokens: 0, human_input_tokens: 0, requests: 0,
  });

  const model_totals = buildModelTotals(records, format);
  const tool_totals = aggregateTools(records, format);
  const cli_tool_totals = buildCliToolTotals(records);
  const warnings = detectWarnings(records, sessions, format, period, cli_tool_totals);
  const file_stats = buildFileStats(sessions, useRealSessionName);

  const report = { report_type: 'sessions', period, generated_at: new Date().toISOString(), totals };
  if (format !== 'legacy') {
    report.sources = sources;
    report.cli_tool_totals = cli_tool_totals;
  }
  report.model_totals = model_totals;
  report.tool_totals = tool_totals;
  report.warnings = warnings;
  report.file_stats = file_stats;
  report.sessions = sessions;
  return report;
}

// --- Main ---

function main() {
  const opts = parseArgs();

  if (opts.listTools) {
    for (const a of ADAPTERS) {
      let avail = false;
      try { avail = a.isAvailable(); } catch {}
      console.log(`${a.name.padEnd(15)} ${avail ? 'detected' : 'not found'}`);
    }
    process.exit(0);
  }

  const now = Date.now();
  const cutoff = now - opts.days * 86400000;
  const period = {
    start: new Date(cutoff).toISOString(),
    end: new Date(now).toISOString(),
    days: opts.days,
  };

  const { records, perTool, active } = collectFromAdapters(cutoff, opts.useRealSessionName, opts.tools);
  releaseTokenizer();

  if (active.length === 0) {
    console.error('No supported CLI tool data found. Pass --list-tools to see detection status.');
    process.exit(1);
  }

  const sources = { tools: perTool };
  let report = opts.report === 'sessions'
    ? buildSessionsReport(records, period, sources, opts.useRealSessionName, opts.format)
    : buildHourlyReport(records, period, sources, opts.useRealSessionName, opts.format);

  if (opts.summaryOnly) {
    const slim = {
      report_type: report.report_type,
      period: report.period,
      generated_at: report.generated_at,
      totals: report.totals,
      model_totals: report.model_totals,
      tool_totals: report.tool_totals,
      warnings: report.warnings,
    };
    if (opts.format !== 'legacy') {
      slim.sources = report.sources;
      slim.cli_tool_totals = report.cli_tool_totals;
    }
    report = slim;
  }

  const json = JSON.stringify(report, null, 2);

  if (opts.output) {
    fs.writeFileSync(opts.output, json);
    console.error(`Report written to ${opts.output} (${report.totals.requests} requests, ${report.totals.input_tokens} in / ${report.totals.output_tokens} out / ${report.totals.cache_read_tokens} cache-read / ${report.totals.cache_creation_tokens} cache-write tokens)`);
  } else {
    console.log(json);
  }
}

main();
