# AGENTS.md

## Project overview

Node.js CLI (`opencode-usage`) that reads local OpenCode session/message data and generates JSON token usage reports broken down by provider, model, and tool. Single file: `report-opencode-usage.js`. Installable via npm.

Also includes an interactive HTML dashboard (`public/`) for exploring reports visually — no build step, runs entirely in the browser.

## Dev environment

- Node.js 18+
- `sqlite3` CLI required for reading OpenCode's SQLite database
- One dependency: `@anthropic-ai/tokenizer` for Claude-accurate token estimation
- No build step

## Code style

- CommonJS (`require`/`module.exports`)
- Keep `report-opencode-usage.js` as a single self-contained script
- Use early returns for error handling
- Functions should be small and focused
- Minimize dependencies — only add if there's a strong reason

## Testing

There is no test suite. To verify changes manually:

```bash
# Should show help text
node report-opencode-usage.js --help

# Should exit 1 with clear error if no OpenCode storage exists
node report-opencode-usage.js --days 7

# On a machine with OpenCode data, verify JSON output is valid
node report-opencode-usage.js --days 7 --summary-only | jq .
node report-opencode-usage.js --days 7 --report sessions --summary-only | jq .
```

## Architecture

The script reads OpenCode's local data from two sources (auto-detected):

**SQLite database** (newer OpenCode versions):
- `~/.local/share/opencode/opencode.db` — tables: `session`, `message`, `part`
- Messages and parts store a `data` JSON column with the payload
- Queried via `sqlite3` CLI with custom delimiters for performance (avoids slow `-json` flag)
- Parts are indexed by message ID (`dbPartsByMessage`) and by part ID (`dbPartsById`) for flame graph expansion

**JSON files** (older OpenCode versions):
- `~/.local/share/opencode/storage/session/{projectId}/{sessionId}.json`
- `~/.local/share/opencode/storage/message/{sessionId}/{messageId}.json`
- `~/.local/share/opencode/storage/part/{messageId}/{partId}.json`
- File-based parts are also registered into `dbPartsById` as they are read

**Token estimation**: Messages missing token counts (user messages, some errors) have their part text tokenized using `@anthropic-ai/tokenizer`. Tool call inputs/outputs from parts are also tokenized to populate `tool_input_tokens` and `tool_output_tokens`.

**Flow**: load DB data (filtered by cutoff) → load sessions → gather messages → gather parts and build tokenization work items → tokenize all at once (single tokenizer instance, reused) → aggregate into hourly/session buckets → run waste detection → output JSON.

**Waste detection**: After session aggregation, each session is checked for: excessive iteration (>40 requests), wasted compute (>5 requests, zero tool calls), low token efficiency (>50:1 token-to-tool-output ratio), output-heavy sessions, and long-running sessions (>30 min). Issues are emitted as `warnings` in the report.

**Flame graphs** (`tool_timeline`): Session reports include a `tool_timeline` array for each session. For native OpenCode `task` parts (which store `state.metadata.summary` with child part IDs), `buildFlameEvents()` recursively expands the tree and assigns `depth` values. OH My Opencode tasks use a different format with no `summary`, so they appear as single flat bars labelled with their `subagent_type` (e.g. `[explore] description`). The dashboard renders this as an SVG flame chart using depth for row placement.

**Privacy**: By default, `session_title` is the first 8 characters of the session ID and no file paths are recorded. Pass `--use-real-session-name` to include actual session titles, per-session `files` arrays (read/edit/write paths with token costs), and a global `file_stats` summary — this also enables the Files dashboard page.

## Dashboard (`public/`)

- `public/index.html` — single-page app shell and nav
- `public/app.js` — all rendering logic (vanilla JS, no framework)
- `public/styles.css` — dark theme styles

Pages: Dashboard, Models, Tools, Timeline, Sessions, Warnings, Files (only shown when `file_stats` is present).

The dashboard supports loading and merging multiple report JSON files. Session rows with agent/tool data can be expanded inline to show agent flow bar charts and SVG flame graphs.

## Boundaries

- **Always**: keep reporter a single file, output valid JSON, support both SQLite and JSON file sources, anonymise session titles by default
- **Never**: add network calls, write to OpenCode's storage directory, require API keys, include session titles in output unless `--use-real-session-name` is passed
- **Ask first**: adding new report types, changing the output schema (other tools may depend on it)
