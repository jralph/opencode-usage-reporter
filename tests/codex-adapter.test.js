const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

function writeJSONL(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('codex adapter reads current rollout metadata, token_count usage, and tool calls', () => {
  const home = fs.mkdtempSync(path.join('/tmp', 'codex-adapter-'));
  const sessionFile = path.join(
    home,
    '.codex/sessions/2026/04/21/rollout-2026-04-21T14-43-19-session-1.jsonl'
  );

  writeJSONL(sessionFile, [
    {
      type: 'session_meta',
      timestamp: '2026-04-21T13:43:19.738Z',
      payload: {
        id: 'session-1',
        timestamp: '2026-04-21T13:43:19.738Z',
        cwd: '/work/project',
        source: 'cli',
        model_provider: 'openai',
      },
    },
    {
      type: 'turn_context',
      timestamp: '2026-04-21T13:43:33.862Z',
      payload: {
        model: 'gpt-5.4',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-04-21T13:43:33.862Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'inspect the repo' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-04-21T13:43:45.261Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect it.' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-04-21T13:43:45.269Z',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_1',
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-04-21T13:43:45.323Z',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'package.json\n',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-04-21T13:43:45.329Z',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_2',
        input: '*** Begin Patch\n*** End Patch\n',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-04-21T13:43:45.330Z',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_2',
        output: '{"output":"Success\\n"}',
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-04-21T13:43:45.305Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 7,
            reasoning_output_tokens: 3,
          },
        },
      },
    },
  ]);

  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldWslUsersRoot = process.env.WSL_USERS_ROOT;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  delete process.env.CODEX_HOME;
  process.env.WSL_USERS_ROOT = path.join(home, 'empty-users-root');
  delete require.cache[require.resolve('../adapters/codex')];
  const codex = require('../adapters/codex');

  try {
    const records = codex.collect({ cutoff: Date.parse('2026-04-01T00:00:00Z'), useRealSessionName: true });
    const user = records.find(r => r.role === 'user');
    const assistant = records.find(r => r.role === 'assistant');

    assert.equal(records.length, 2);
    assert.equal(user.inputTokens, 0);
    assert.ok(user.humanInputTokens > 0);
    assert.equal(assistant.tool, 'codex-cli');
    assert.equal(assistant.provider, 'openai');
    assert.equal(assistant.model, 'gpt-5.4');
    assert.equal(assistant.inputTokens, 60);
    assert.equal(assistant.cacheReadTokens, 40);
    assert.equal(assistant.outputTokens, 10);
    assert.equal(assistant.estimated, false);
    assert.equal(assistant.tools.length, 2);
    assert.equal(assistant.tools[0].tool, 'exec_command');
    assert.equal(assistant.tools[1].tool, 'apply_patch');
    assert.equal(assistant.toolEvents.length, 2);
  } finally {
    process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldWslUsersRoot === undefined) delete process.env.WSL_USERS_ROOT;
    else process.env.WSL_USERS_ROOT = oldWslUsersRoot;
    require('../lib/tokenize').releaseTokenizer();
  }
});
