# OpenCode Usage Reporter

A Node.js CLI that reads your local [OpenCode](https://github.com/opencode-ai/opencode) session data and generates token usage reports broken down by provider, model, and tool. Includes an interactive HTML dashboard for exploring reports visually.

Useful for understanding how many tokens you're consuming and comparing costs between GitHub Copilot subscriptions vs direct API usage.

## Requirements

- Node.js 18+
- `sqlite3` CLI (for reading newer OpenCode databases)
- OpenCode installed with data in `~/.local/share/opencode/`

## Generating a Report

No install required — run directly with npx:

```bash
# Hourly breakdown for the last 7 days
npx jralph/opencode-usage-reporter --days 7

# Summary only (totals + per-model + per-tool, no hourly rows)
npx jralph/opencode-usage-reporter --days 7 --summary-only

# Save to file
npx jralph/opencode-usage-reporter --days 7 --output report.json

# Session-level breakdown for the last 30 days
npx jralph/opencode-usage-reporter --days 30 --report sessions --output report.json
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--days <n>` | `7` | Number of days to include |
| `--report <type>` | `hours` | Report type: `hours` or `sessions` |
| `--output <file>` | stdout | Write JSON to file instead of stdout |
| `--summary-only` | | Only output totals, model breakdowns, and tool stats (no per-hour/session rows) |
| `--help` | | Show help |

### Global Install

If you prefer, you can install globally:

```bash
npm install -g jralph/opencode-usage-reporter
opencode-usage --days 7
```

## Dashboard

Drop a report JSON into `reports/` and open `public/index.html` in a browser to explore it visually. The dashboard supports loading multiple report files and merging them.

Pages:
- **Dashboard** — summary cards, token usage over time, provider/model breakdowns
- **Models** — per-model token and cost table
- **Tools** — per-tool usage breakdown
- **Timeline** — daily token trends, requests by provider, daily tool usage
- **Sessions** — per-session table with agent flow charts and tool flame graphs (sessions report only)
- **Warnings** — waste detection alerts (excessive iteration, wasted compute, low efficiency)

### Privacy

Session titles are **not** included in reports. The `session_title` field contains only the first 8 characters of the session ID.

## Output Format

Both report types include a `warnings` array with waste detection alerts detected across sessions.

### Hourly Report (`--report hours`)

Aggregates token usage into hourly buckets per provider/model combination, with per-tool breakdowns:

```json
{
  "report_type": "hourly",
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
      ]
    }
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

## How It Works

OpenCode stores session and message data locally in `~/.local/share/opencode/`. Newer versions use a SQLite database (`opencode.db`), older versions use JSON files in `storage/`. This tool auto-detects and reads from both sources.

Each message records the provider, model, token counts, and timestamps. For messages missing token counts (e.g. user messages), the tool estimates them using Anthropic's Claude tokenizer. Tool call inputs/outputs are also tokenized to give accurate `tool_input_tokens` counts.

After aggregation, sessions are analysed for waste patterns and any issues are emitted as `warnings` in the report.

## License

MIT
