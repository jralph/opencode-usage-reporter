# AGENTS.md

## Project overview

Zero-dependency Node.js CLI that reads local OpenCode session/message data from `~/.local/share/opencode/storage/` and generates JSON token usage reports broken down by provider and model. Single file: `report-opencode-usage.js`.

## Dev environment

- Node.js 18+
- No dependencies — stdlib only (`fs`, `path`)
- No build step, no package.json

## Code style

- CommonJS (`require`/`module.exports`)
- No external dependencies — do not add any
- Keep it as a single self-contained script
- Use early returns for error handling
- Functions should be small and focused

## Testing

There is no test suite. To verify changes manually:

```bash
# Should show help text
node report-opencode-usage.js --help

# Should exit 1 with clear error if no OpenCode storage exists
node report-opencode-usage.js --days 7

# On a machine with OpenCode data, verify JSON output is valid
node report-opencode-usage.js --days 7 | jq .
node report-opencode-usage.js --days 7 --report sessions | jq .
```

## Architecture

The script reads OpenCode's local storage directly:

- `~/.local/share/opencode/storage/session/{projectId}/{sessionId}.json` — session metadata (id, title, directory, timestamps)
- `~/.local/share/opencode/storage/message/{sessionId}/{messageId}.json` — message data with `model.providerID`, `model.modelID`, `tokens.input`, `tokens.output`, `time.created`

Flow: scan all sessions → read messages → filter by date range → aggregate into hourly buckets or session groups → output JSON.

## Boundaries

- **Always**: keep zero dependencies, keep it a single file, output valid JSON
- **Never**: add network calls, write to OpenCode's storage directory, require API keys
- **Ask first**: adding new report types, changing the output schema (other tools may depend on it)
