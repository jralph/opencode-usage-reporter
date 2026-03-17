# AGENTS.md

## Project overview

Node.js CLI (`opencode-usage`) that reads local OpenCode session/message data and generates JSON token usage reports broken down by provider, model, and tool. Single file: `report-opencode-usage.js`. Installable via npm.

## Dev environment

- Node.js 18+
- `sqlite3` CLI required for reading OpenCode's SQLite database
- One dependency: `@anthropic-ai/tokenizer` for Claude-accurate token estimation
- No build step

## Code style

- CommonJS (`require`/`module.exports`)
- Keep it as a single self-contained script
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

**JSON files** (older OpenCode versions):
- `~/.local/share/opencode/storage/session/{projectId}/{sessionId}.json`
- `~/.local/share/opencode/storage/message/{sessionId}/{messageId}.json`
- `~/.local/share/opencode/storage/part/{messageId}/{partId}.json`

**Token estimation**: Messages missing token counts (user messages, some errors) have their part text tokenized using `@anthropic-ai/tokenizer`. Tool call inputs/outputs from parts are also tokenized to populate `tool_input_tokens`.

**Flow**: load DB data (filtered by cutoff) → load sessions → gather messages → gather parts and build tokenization work items → tokenize all at once (single tokenizer instance, reused) → aggregate into hourly/session buckets → output JSON.

## Boundaries

- **Always**: keep it a single file, output valid JSON, support both SQLite and JSON file sources
- **Never**: add network calls, write to OpenCode's storage directory, require API keys
- **Ask first**: adding new report types, changing the output schema (other tools may depend on it)
