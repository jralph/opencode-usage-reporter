# Coding CLI Usage Reporter

A Node.js CLI that reads your local session data from multiple AI coding CLIs and generates a combined token usage report broken down by CLI tool, provider, model, and tool call. Includes an interactive HTML dashboard for exploring reports visually.

Useful for understanding how many tokens you're consuming across all your coding agents and comparing costs between providers.

## Supported tools

| Tool | Data location | Token counts |
|------|---------------|--------------|
| **OpenCode** | `~/.local/share/opencode/` (SQLite + JSON) | Real (API-reported) |
| **Kiro CLI** | `~/.kiro/sessions/cli/` (JSON + JSONL) | Estimated locally |
| **Kiro IDE** | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` | Estimated locally |
| **Claude Code** *(also covers Claude Desktop in Claude Code mode)* | `~/.claude/projects/{path}/{id}.jsonl` | Real, with estimation fallback for placeholder values |
| **Codex** *(also covers OpenAI Codex desktop app)* | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Real (`turn_completed.usage`) |
| **Cursor** | `~/Library/Application Support/Cursor/.../state.vscdb` | Real (per-bubble `tokenCount`) |
| **GitHub Copilot CLI** | `~/.copilot/session-state/…/events.jsonl` (new) or `~/.copilot/history-session-state/*.json` (legacy) | Real in new format, estimated in legacy |
| **VS Code Copilot Chat** | `~/Library/Application Support/Code{,\u00a0-\u00a0Insiders,VSCodium}/User/workspaceStorage/{hash}/chatSessions/` | Sometimes real, estimation fallback |

**Not yet supported:** JetBrains Copilot (Nitrite binary DB, requires JVM to read), Claude Desktop regular chat (IndexedDB LevelDB blobs), `gh copilot` extension (stateless, no local data).

Adapters auto-detect. Tools without local data are silently skipped.

The output shape is formally described in [`schema.json`](./schema.json) (JSON Schema draft 2020-12).

## Requirements

- Node.js 18+
- `sqlite3` CLI (for OpenCode and Cursor)

## Generating a Report

No install required — run directly with npx:

```bash
# Combined report across all detected tools, last 7 days
npx jralph/opencode-usage-reporter --days 7

# Restrict to specific tools (comma-separated or repeatable)
npx jralph/opencode-usage-reporter --tool opencode --days 30
npx jralph/opencode-usage-reporter --tool kiro,kiro-ide --days 30

# List detected tools
npx jralph/opencode-usage-reporter --list-tools

# Session-level breakdown to file
npx jralph/opencode-usage-reporter --days 30 --report sessions --output report.json
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--days <n>` | `7` | Number of days to include |
| `--report <type>` | `hours` | Report type: `hours` or `sessions` |
| `--format <name>` | `per-tool` | Output schema: `per-tool`, `combined`, or `legacy`. See *Output formats* below. |
| `--tool <name[,name...]>` | all detected | Restrict to specific CLI tools. Values: `opencode`, `kiro`, `kiro-ide`, `claude-code`, `codex`, `cursor`, `copilot-cli`, `copilot-vscode`, `all` |
| `--list-tools` | | Print detection status for each supported CLI and exit |
| `--output <file>` | stdout | Write JSON to file instead of stdout |
| `--summary-only` | | Only output totals, model breakdowns, and tool stats (no per-hour/session rows) |
| `--use-real-session-name` | | Include actual session titles instead of anonymised IDs |
| `--help` | | Show help |

### Output formats

Three output shapes are supported. All three produce the same `totals`, `model_totals`, `tool_totals`, `warnings`, `sessions`, and `usage` sections — what changes is whether rows are split or merged across CLIs, and whether the new multi-tool top-level fields are emitted.

| Format | Row keying | `cli_tool` on rows | `cli_tool_totals` / `sources.tools` | Existing dashboard |
|---|---|---|---|---|
| **`per-tool`** (default) | `(cli_tool, provider, model)` / `(cli_tool, tool)` | yes, everywhere | yes | renders, but shows per-CLI rows without collapsing |
| **`combined`** | `(provider, model)` / `(tool)` | only on `sessions[]` / `usage[]` / `warnings[]` | yes | native — rows merge across CLIs |
| **`legacy`** | `(provider, model)` / `(tool)` | never | no | byte-for-byte pre-multi-tool shape |

The full JSON Schema (draft 2020-12) is in [`schema.json`](./schema.json).

### Global Install

```bash
npm install -g jralph/opencode-usage-reporter
coding-usage --days 7
# or: opencode-usage --days 7
```

## Dashboard

Two ways to explore reports visually:

**Static (no install):** drop report JSON files into `reports/` and open `public/index.html` in a browser.

**Server (recommended):** `report-analytics` serves the dashboard + report data over HTTP. Accepts either a directory of reports or a single report file:

```bash
# Directory of reports (merged in the UI)
npx jralph/opencode-usage-reporter report-analytics --reports ./reports

# Single report file
npx jralph/opencode-usage-reporter report-analytics --report ./report.json

# Custom port
npx jralph/opencode-usage-reporter report-analytics --report ./report.json --port 4000
```

Note: the existing dashboard renders the `legacy` and `combined` format shapes out of the box. The default `per-tool` format is valid JSON and shows data in the dashboard but doesn't yet render per-CLI groupings — fine for direct JSON consumption, a future UI pass will surface the `cli_tool` splits.

Pages:
- **Dashboard** — summary cards, token usage over time, provider/model breakdowns
- **Models** — per-model token and cost table
- **Tools** — per-tool usage breakdown
- **Timeline** — daily token trends, requests by provider, daily tool usage
- **Sessions** — per-session table with agent flow charts and tool flame graphs (sessions report only)
- **Warnings** — waste detection alerts (excessive iteration, wasted compute, low efficiency)
- **Files** — hot files by token cost, directory and extension breakdowns (only visible with `--use-real-session-name`)

### Privacy

By default, session titles and file paths are **not** included in reports. The `session_title` field contains only the first 8 characters of the session ID, and no file-level detail is collected.

Pass `--use-real-session-name` to opt into including actual session titles, per-session file access stats (`files`), and a global `file_stats` summary. This enables the Files page in the dashboard.

## Output Format

Both report types include a `warnings` array with waste detection alerts detected across sessions.

### Hourly Report (`--report hours`)

Aggregates token usage into hourly buckets per provider/model combination, with per-tool breakdowns:

```json
{
  "report_type": "hourly",
  "sources": { "tools": { "opencode": 1842, "kiro": 1781, "kiro-ide": 78 } },
  "cli_tool_totals": [
    { "cli_tool": "opencode", "input_tokens": 201576698, "output_tokens": 914609, "tool_input_tokens": 5132699, "tool_output_tokens": 21034122, "human_input_tokens": 59045, "requests": 1842, "sessions": 47, "tool_calls": 2472 },
    { "cli_tool": "kiro",     "input_tokens": 35092,     "output_tokens": 85575,  "tool_input_tokens": 187349,  "tool_output_tokens": 3431989,  "human_input_tokens": 35092, "requests": 1781, "sessions": 6,  "tool_calls": 1529 }
  ],
  "period": {
    "start": "2026-03-10T16:00:00.000Z",
    "end": "2026-03-17T16:00:00.000Z",
    "days": 7
  },
  "generated_at": "2026-03-17T16:20:00.000Z",
  "totals": {
    "input_tokens": 201576698,
    "output_tokens": 914609,
    "estimated_tokens": 86214,
    "tool_input_tokens": 5132699,
    "requests": 2903
  },
  "model_totals": [
    {
      "provider": "github-copilot",
      "model": "claude-sonnet-4.6",
      "input_tokens": 15916071,
      "output_tokens": 307305,
      "estimated_tokens": 6748,
      "tool_input_tokens": 1471645,
      "requests": 528
    }
  ],
  "tool_totals": [
    { "tool": "read", "calls": 969, "input_tokens": 3554131, "output_tokens": 0 },
    { "tool": "bash", "calls": 922, "input_tokens": 642947, "output_tokens": 0 }
  ],
  "warnings": [
    {
      "type": "excessive_iteration",
      "severity": "severe",
      "session_id": "abc12345",
      "detail": "67 requests in session abc12345. Possible thrashing or micromanagement."
    }
  ],
  "usage": [
    {
      "hour": "2026-03-15T10:00:00Z",
      "provider": "github-copilot",
      "model": "claude-sonnet-4.6",
      "input_tokens": 12320,
      "output_tokens": 5030,
      "estimated_tokens": 0,
      "tool_input_tokens": 3200,
      "requests": 8,
      "tools": {
        "read": { "calls": 3, "input_tokens": 2100 },
        "bash": { "calls": 2, "input_tokens": 1100 }
      }
    }
  ]
}
```

### Session Report (`--report sessions`)

Breaks down usage per session/provider/model with enriched per-session metadata:

```json
{
  "report_type": "sessions",
  "period": { "start": "...", "end": "...", "days": 30 },
  "totals": { "...": "same as hourly" },
  "model_totals": [ "..." ],
  "tool_totals": [ "..." ],
  "warnings": [ "..." ],
  "sessions": [
    {
      "session_id": "abc123de",
      "session_title": "abc123de",
      "directory": "/home/user/project",
      "started_at": "2026-03-15T09:00:00.000Z",
      "ended_at": "2026-03-15T09:45:00.000Z",
      "provider": "github-copilot",
      "model": "claude-sonnet-4.6",
      "input_tokens": 45000,
      "output_tokens": 3200,
      "estimated_tokens": 0,
      "tool_input_tokens": 12000,
      "tool_output_tokens": 8000,
      "tool_calls": 24,
      "requests": 15,
      "agents": {
        "orchestrator": { "requests": 5, "input_tokens": 20000, "output_tokens": 1500 }
      },
      "tool_timeline": [
        { "tool": "task", "start": 1741000000000, "end": 1741000060000, "depth": 0, "title": "[explore] Map UI components" },
        { "tool": "read", "start": 1741000005000, "end": 1741000006000, "depth": 1, "tokens": 420 }
      ],
      "files": [
        { "path": "/home/user/project/src/auth.js", "calls": 5, "input_tokens": 18000, "tools": { "read": 4, "edit": 1 } }
      ]
    }
  ],
  "file_stats": [
    { "path": "/home/user/project/src/auth.js", "calls": 15, "input_tokens": 45000, "sessions": 3, "directory": "/home/user/project", "tools": { "read": 10, "edit": 4, "write": 1 } }
  ]
}
```

The `tool_timeline` array powers the flame graph in the dashboard. Events include a `depth` field for nesting — native OpenCode `task` parts recursively expand their `metadata.summary` children; OH My Opencode tasks appear as single bars labelled with their `subagent_type`.

## Fields

| Field | Description |
|-------|-------------|
| `provider` | The provider configured in OpenCode (e.g. `github-copilot`, `anthropic`, `openai`) |
| `model` | The model ID as configured in OpenCode |
| `input_tokens` | Tokens sent to the model (prompts, context, tool results) |
| `output_tokens` | Tokens generated by the model (responses, tool calls) |
| `estimated_tokens` | Subset of input/output tokens estimated via tokenizer (not API-reported) |
| `tool_input_tokens` | Tokens from tool call inputs — estimated via Claude's tokenizer |
| `tool_output_tokens` | Tokens from tool call outputs — estimated via Claude's tokenizer |
| `tool_calls` | Total number of tool invocations in the session |
| `requests` | Number of individual API requests made |
| `agents` | Per-agent token/request breakdown (when agent names are available) |
| `tool_timeline` | Ordered list of tool events with timing and depth for flame graph rendering |
| `warnings` | Waste detection alerts: `excessive_iteration`, `wasted_compute`, `low_token_efficiency`, `output_heavy`, `long_running` |
| `files` | *(sessions report, `--use-real-session-name` only)* Per-file access stats for this session — path, calls, input_tokens, tools breakdown |
| `file_stats` | *(`--use-real-session-name` only)* Global file access summary across all sessions — same shape as `files` plus a `sessions` count |

## How It Works

Each supported CLI stores session data locally in its own format — SQLite for OpenCode and Cursor, JSONL/JSON for the others. A per-tool adapter in `adapters/` parses that tool's data and produces records in a shared internal shape. The orchestrator concatenates records from every detected (or explicitly-selected) adapter and runs the shared aggregation pipeline.

Where a tool doesn't persist real token counts (Kiro CLI, Kiro IDE) or writes placeholder values (some Claude Code assistant turns), text is tokenized locally using Anthropic's Claude tokenizer and flagged with `estimated: true`. This is a reasonable approximation across providers — Claude's BPE tokenizer correlates closely with OpenAI's `cl100k_base`.

After aggregation, sessions are analysed for waste patterns (inefficient reads, duplicate reads, unbounded bash, read-then-small-edit, superseded writes, excessive iteration, …) and any issues are emitted as `warnings` in the report. Tool dominance is scoped per-CLI so a hot tool in one CLI doesn't skew warnings for another.

## License

MIT
