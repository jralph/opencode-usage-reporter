# AGENTS.md

## Project overview

Node.js CLI (`opencode-usage` / `coding-usage`) that reads local session/message data from multiple AI coding CLIs and generates a combined JSON token usage report broken down by CLI tool, provider, model, and tool call. Installable via npm.

Also includes an interactive HTML dashboard (`public/`) for exploring reports visually — no build step, runs entirely in the browser.

## Dev environment

- Node.js 18+
- `sqlite3` CLI required for reading OpenCode's and Cursor's SQLite databases
- One dependency: `@anthropic-ai/tokenizer` for Claude-accurate token estimation
- No build step

## Code style

- CommonJS (`require`/`module.exports`)
- `report-opencode-usage.js` is the orchestrator — parses args, dispatches to adapters, aggregates results, emits JSON. Keep it focused on orchestration and aggregation only.
- Per-CLI logic lives in `adapters/<name>.js`. Each adapter is self-contained.
- Shared helpers: `lib/tokenize.js` (single tokenizer instance, `tokenizeAll`) and `lib/util.js` (`safeStringify`, `readJSON`, `readJSONL`, `listDir`, `makeRecord`).
- Use early returns for error handling. Functions should be small and focused.
- Minimize dependencies — only add if there's a strong reason.

## Testing

There is no test suite. To verify changes manually:

```bash
# Should show help text
node report-opencode-usage.js --help

# Should list which CLI tools are detected on this machine
node report-opencode-usage.js --list-tools

# Should exit 1 with clear error if no supported CLI has local data
node report-opencode-usage.js --days 7

# On a machine with data, verify JSON output is valid
node report-opencode-usage.js --days 7 --summary-only | jq .
node report-opencode-usage.js --days 7 --report sessions --summary-only | jq .

# Restrict to specific CLI tools
node report-opencode-usage.js --tool opencode --days 7 --summary-only | jq .
node report-opencode-usage.js --tool kiro,kiro-ide --days 30 --summary-only | jq .
```

## Architecture

### Orchestrator (`report-opencode-usage.js`)

Parses CLI args, selects adapters (all detected by default, or a subset via `--tool`), calls each adapter's `collect()`, merges the returned records, and runs the shared aggregation pipeline.

### Adapter interface

Each file in `adapters/` exports:

```js
module.exports = {
  name: 'opencode' | 'kiro' | 'kiro-ide' | 'claude-code' | 'codex' | 'cursor',
  isAvailable(): boolean,                          // cheap existence check
  collect({ cutoff, useRealSessionName }): records // see record shape below
};
```

`cutoff` is a unix-ms timestamp. Adapters must not return records older than `cutoff`.

### Record shape (internal, produced by adapters)

```js
{
  tool,              // CLI source, e.g. 'opencode' — populated via makeRecord()
  sessionId,
  sessionTitle,
  directory,
  created,           // unix ms
  completed,         // unix ms
  role,              // 'user' | 'assistant'
  agent,
  provider,          // e.g. 'anthropic', 'aws-bedrock', 'openai'
  model,
  inputTokens,           // fresh (uncached) input tokens — 100% cost
  outputTokens,          // generated output incl. tool_use blocks — 100% cost
  cacheReadTokens,       // prompt-cache reads — ~10% cost (Anthropic) / 50% (OpenAI)
  cacheCreationTokens,   // prompt-cache writes (5m TTL) — ~125% cost (Anthropic)
  humanInputTokens,      // subset of inputTokens: what the user actually typed
  estimated,         // true if tokens came from local tokenizer
  tools: [{ tool, inputTokens, outputTokens }],
  toolEvents: [{ tool, tokens, start, end, args, error, depth, title? }],
}
```

Cache buckets are tracked separately rather than folded into `inputTokens` so
downstream cost math can weight each at its provider-specific rate.
"Total billable tokens" = `inputTokens + outputTokens + cacheReadTokens +
cacheCreationTokens`. Adapters without provider cache metadata leave
`cacheReadTokens` / `cacheCreationTokens` at 0.

### Kiro token semantics (important)

Kiro and Kiro IDE don't persist real token counts, so all Kiro records are
estimated locally. We model **LLM billing cost**, not conversation size:

- **Kiro CLI** — each `AssistantMessage` event = one LLM API call. Its
  `inputTokens` is the running cumulative context (user prompts + prior
  assistant text + prior tool-call args + prior tool results) at the moment
  of the call, capped at `MAX_CONTEXT_TOKENS` (200k, the Claude 3.x window).
  User `Prompt` records carry `humanInputTokens` only (so we don't
  double-count the billable input that's already attributed to the next
  assistant call).
- **Kiro IDE** — parses both formats:
  - Current hex32 `chat-agent` execution files. Full `input.data.messages`
    tokenized as the billable input, assistant `say` text + tool-call args
    as output. Capped at 200k.
  - Historical `.chat` files (workspace top level, Sep 2025 – Feb 2026,
    ~20k files). Each represents one LLM call with its full conversation
    context; deduped by `executionId` against hex32 to avoid
    double-counting in the overlap period.
  - Tool-call args are counted in `outputTokens` (Anthropic bills them as
    output), with the per-tool breakdown still available via `tools[]`.

### Adapters

- **opencode** — reads `~/.local/share/opencode/opencode.db` (SQLite) and/or `~/.local/share/opencode/storage/{session,message,part}/` (JSON). Queried via `sqlite3` CLI with custom delimiters for performance (avoids slow `-json` flag for large result sets). Supports flame-graph expansion via `part.state.metadata.summary` child references.
- **kiro** — reads `~/.kiro/sessions/cli/{uuid}.json` + `{uuid}.jsonl`. JSONL kinds: `Prompt`, `AssistantMessage`, `ToolResults`. Kiro does not persist real token counts — all records are tokenized locally and marked `estimated: true`.
- **kiro-ide** — reads `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/{workspace-hash}/{exec-group}/{execution-hash}` JSON execution files. Each `chat-agent` execution produces up to two records (user message from `input.data.messages`, assistant from `actions[]` of type `say` + tool calls). No token counts — tokenized locally.
- **claude-code** — reads `~/.claude/projects/{sanitized-path}/{session-id}.jsonl`. Uses `message.usage.input_tokens` / `output_tokens` when reliable. Known gotcha: Claude Code often writes placeholder `output_tokens` (1–2). Records with placeholder output get locally-tokenized text and are marked `estimated`. **Also covers Claude Desktop in Claude Code mode** — the desktop app shares `~/.claude/projects/*.jsonl` with the CLI, so no separate adapter is needed.
- **codex** — reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Uses real `turn_completed.usage` for assistant messages; user messages are tokenized locally. **Also covers the OpenAI Codex desktop app** — the desktop writes to the same `~/.codex/sessions/` tree (just with `source: "appServer"` or `"vscode"` in `session_meta`).
- **cursor** — reads SQLite from `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` + workspace DBs. Lists composers from workspace DBs, bubble messages from global DB. Uses `bubble.tokenCount.inputTokens/outputTokens` when present.
- **copilot-cli** — GitHub Copilot CLI. Handles both storage formats:
  - Legacy (pre-v0.0.342): `~/.copilot/history-session-state/session_{uuid}_{ts}.json` with `{chatMessages, timeline}`. No token counts — tokenized locally, marked `estimated`.
  - New (v0.0.342+): `~/.copilot/session-state/{sessionId}/events.jsonl` with `assistant.usage` events carrying real `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
  - `provider` is always `github-copilot`, matching how OpenCode reports Copilot-routed usage. Model comes from the event stream or `~/.copilot/config.json`.
- **copilot-vscode** — VS Code Copilot Chat. Reads `~/Library/Application Support/Code{,\u00a0-\u00a0Insiders,VSCodium}/User/workspaceStorage/{hash}/chatSessions/{uuid}.jsonl` (v1.109+ mutation-log) and `.json` (legacy full-snapshot), plus `globalStorage/emptyWindowChatSessions/`. `result.metadata.usage.{prompt_tokens,completion_tokens}` used when present; otherwise tokenized and marked `estimated`. Model derived from `modelId` (e.g. `copilot/claude-sonnet-4` → `claude-sonnet-4`); `provider` is `github-copilot`.

### Surfaces not currently supported

- **JetBrains Copilot plugin** — chat history lives in `~/.config/github-copilot/iu/chat-sessions/*/copilot-chat-nitrite.db` (plus `chat-agent-sessions/`, `chat-edit-sessions/`). Nitrite is a Java-native embedded document store (MVStore + Kryo-serialized objects). Not parseable from Node.js without a JVM bridge. An export path exists via community tools (e.g. `copilot-jetbrains-exporter`) but is out of scope.
- **Claude Desktop chat (non-Claude-Code mode)** — regular Anthropic chat conversations are stored in `~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/` as opaque LevelDB blobs. Not currently parsed. Note that Claude Code invocations *from* the desktop app ARE captured via the `claude-code` adapter because they share `~/.claude/projects/`.
- **Claude Cowork** — a mode within Claude Desktop. Session metadata in `~/Library/Application Support/Claude/local-agent-mode-sessions/` is pointers/titles only, no messages or tokens.
- **`gh copilot` extension** — stateless, no local data.

### Token estimation

All adapters share a single `@anthropic-ai/tokenizer` instance via `lib/tokenize.js`. Each adapter builds a list of `{ id, texts[] }` work items during parsing and calls `tokenizeAll(workItems)` once before building records. The orchestrator calls `releaseTokenizer()` after all adapters finish.

### Flow

1. `parseArgs()` — determine `--days`, `--tool`, `--report`, etc.
2. `collectFromAdapters(cutoff, useRealSessionName, selectedTools)` — each adapter reads its data, tokenizes as needed, and returns records.
3. Records are concatenated (no deduplication across adapters — session IDs are UUIDs and tools are tagged).
4. Aggregation: `buildSessionDetails` → `buildModelTotals` / `aggregateTools` / `buildToolTotals` → `detectWarnings`.
5. Hourly or session report emitted as JSON.

### Output schema: three formats

`--format <per-tool|combined|legacy>` selects the output shape (default: `per-tool`).

- **per-tool** — rows split per CLI. `model_totals` keyed by `(cli_tool, provider, model)`; `tool_totals` keyed by `(cli_tool, tool)`. Every row carries `cli_tool`. `sources.tools` and `cli_tool_totals` emitted. Lossless.
- **combined** — dashboard-native keying. `model_totals` keyed by `(provider, model)`; `tool_totals` keyed by `tool`. Rows merged across CLIs. `cli_tool` removed from those rows but retained on `sessions[]` / `usage[]` / `warnings[]`. `sources.tools` and `cli_tool_totals` still emitted.
- **legacy** — byte-for-byte pre-multi-tool shape. No `cli_tool` fields anywhere, no `sources`, no `cli_tool_totals`. Strict back-compat.

Internal tool-dominance / expensive-tool detection is always scoped per-CLI regardless of emitted format — computed directly from records, not from `tool_totals`. This means legacy output still benefits from correct per-CLI dominance thresholds.

The full schema is formalised in `schema.json` at the repo root (JSON Schema draft 2020-12). Three `oneOf` branches mirror the three formats. When adding fields or an adapter, update `schema.json` in the same PR.

### Dashboard (`public/`) — server

`report-analytics.js` serves the dashboard + report JSON over HTTP. `--reports <path>` accepts either a directory of `.json` files or a single `.json` file; `--report <file>` is an alias for the single-file case. Route map:

- `GET /api/reports` — list of loaded reports (filename + period + totals summary)
- `GET /api/reports/<filename>` — full report JSON
- `GET /api/pricing` — cached OpenRouter per-model pricing
- Everything else → static from `public/`

### Waste detection

After session aggregation, each session is checked for: excessive iteration (>40 requests), wasted compute (>5 requests, zero tool calls), low token efficiency (>50:1 token-to-tool-output ratio), output-heavy sessions, long-running sessions (>30 min), inefficient/duplicate reads, unbounded bash, read-then-small-edit, superseded writes, errored tool inputs. Tool dominance is scoped per-CLI so a dominant OpenCode tool doesn't inflate a Kiro warning.

### Flame graphs (`tool_timeline`)

Session reports include a `tool_timeline` array per session. OpenCode `task` parts recursively expand their `metadata.summary` children into nested events (with `depth`); other tools emit flat bars at depth 0. The dashboard renders this as an SVG flame chart.

### Privacy

By default, `session_title` is the first 8 characters of the session ID and no file paths are recorded. Pass `--use-real-session-name` to include actual session titles, per-session `files` arrays, and a global `file_stats` summary.

## Dashboard (`public/`)

- `public/index.html` — single-page app shell and nav
- `public/app.js` — all rendering logic (vanilla JS, no framework)
- `public/styles.css` — dark theme styles

Pages: Dashboard, Models, Tools, Timeline, Sessions, Warnings, Files (only shown when `file_stats` is present). The dashboard is schema-compatible with single-tool and multi-tool reports — existing aggregations (`model_totals`, `tool_totals`) still render. The new `cli_tool` field is ignored by older dashboard logic but available for future filtering.

## Boundaries

- **Always**: output valid JSON, anonymise session titles by default, keep adapters self-contained and side-effect free (no writes to any CLI's storage directory)
- **Never**: add network calls, write to any CLI tool's storage directory, require API keys, include session titles in output unless `--use-real-session-name` is passed
- **Ask first**: adding new report types, changing existing output fields (additive fields are fine), adding a new adapter for a CLI not covered above
