const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

function withEnv(env, fn) {
  const old = {};
  for (const key of Object.keys(env)) {
    old[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

function freshAdapter(name) {
  delete require.cache[require.resolve(`../adapters/${name}`)];
  return require(`../adapters/${name}`);
}

test('kiro adapter falls back to WSL Windows profile prompt history', () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'kiro-wsl-'));
  const linuxHome = path.join(root, 'linux-home');
  const userProfile = path.join(root, 'Users/tester');
  fs.mkdirSync(path.join(userProfile, '.kiro'), { recursive: true });
  fs.writeFileSync(
    path.join(userProfile, '.kiro/.cli_bash_history'),
    '#V2\nfirst prompt\\nwith detail\nsecond prompt\n'
  );

  withEnv({ HOME: linuxHome, USERPROFILE: userProfile }, () => {
    const kiro = freshAdapter('kiro');
    assert.equal(kiro.isAvailable(), true);

    const records = kiro.collect({ cutoff: 0, useRealSessionName: true });
    assert.equal(records.length, 2);
    assert.equal(records[0].tool, 'kiro');
    assert.equal(records[0].role, 'user');
    assert.equal(records[0].provider, 'aws-bedrock');
    assert.equal(records[0].model, 'kiro-default');
    assert.equal(records[0].estimated, true);
    assert.equal(records[0].inputTokens, 0);
    assert.ok(records[0].humanInputTokens > 0);
  });
});

test('kiro adapter scans WSL users root when USERPROFILE is absent', () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'kiro-wsl-root-'));
  const linuxHome = path.join(root, 'linux-home');
  const usersRoot = path.join(root, 'Users');
  const userProfile = path.join(usersRoot, 'tester');
  fs.mkdirSync(path.join(userProfile, '.kiro'), { recursive: true });
  fs.writeFileSync(path.join(userProfile, '.kiro/.cli_bash_history'), '#V2\nfrom windows profile\n');

  withEnv({ HOME: linuxHome, USERPROFILE: undefined, WSL_USERS_ROOT: usersRoot }, () => {
    const kiro = freshAdapter('kiro');
    assert.equal(kiro.isAvailable(), true);
  });
});

test('copilot cli adapter checks WSL Windows profile storage', () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'copilot-wsl-'));
  const linuxHome = path.join(root, 'linux-home');
  const userProfile = path.join(root, 'Users/tester');
  const sessionDir = path.join(userProfile, '.copilot/session-state/session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(userProfile, '.copilot/config.json'), JSON.stringify({ model: 'gpt-4.1' }));
  fs.writeFileSync(
    path.join(sessionDir, 'events.jsonl'),
    [
      {
        type: 'user.message',
        id: 'u1',
        timestamp: '2026-04-21T13:43:33.862Z',
        data: { content: 'inspect the repo' },
      },
      {
        type: 'assistant.usage',
        id: 'a1',
        timestamp: '2026-04-21T13:43:45.305Z',
        data: {
          model: 'claude-sonnet-4.5',
          usage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 10, cacheWriteTokens: 2 },
        },
      },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
  );

  withEnv({ HOME: linuxHome, USERPROFILE: userProfile }, () => {
    const copilot = freshAdapter('copilot-cli');
    assert.equal(copilot.isAvailable(), true);

    const records = copilot.collect({ cutoff: 0, useRealSessionName: true });
    const user = records.find(r => r.role === 'user');
    const assistant = records.find(r => r.role === 'assistant');
    assert.ok(user);
    assert.equal(user.inputTokens, 0);
    assert.ok(user.humanInputTokens > 0);
    assert.ok(assistant);
    assert.equal(assistant.tool, 'copilot-cli');
    assert.equal(assistant.provider, 'github-copilot');
    assert.equal(assistant.model, 'claude-sonnet-4.5');
    assert.equal(assistant.inputTokens, 123);
    assert.equal(assistant.outputTokens, 45);
    assert.equal(assistant.cacheReadTokens, 10);
    assert.equal(assistant.cacheCreationTokens, 2);
  });
});

test('copilot cli adapter scans WSL users root when USERPROFILE is absent', () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'copilot-wsl-root-'));
  const linuxHome = path.join(root, 'linux-home');
  const usersRoot = path.join(root, 'Users');
  const userProfile = path.join(usersRoot, 'tester');
  const sessionDir = path.join(userProfile, '.copilot/session-state/session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), '');

  withEnv({ HOME: linuxHome, USERPROFILE: undefined, WSL_USERS_ROOT: usersRoot }, () => {
    const copilot = freshAdapter('copilot-cli');
    assert.equal(copilot.isAvailable(), true);
  });
});

test('codex adapter checks CODEX_HOME and Windows profile storage', () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'codex-wsl-'));
  const linuxHome = path.join(root, 'linux-home');
  const userProfile = path.join(root, 'Users/tester');
  const codexHome = path.join(userProfile, '.codex');
  const sessionFile = path.join(
    codexHome,
    'sessions/2026/04/21/rollout-2026-04-21T14-43-19-session-1.jsonl'
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [
      {
        type: 'session_meta',
        timestamp: '2026-04-21T13:43:19.738Z',
        payload: { id: 'session-1', cwd: '/work/project', source: 'cli', originator: 'Codex Desktop', model_provider: 'openai' },
      },
      {
        type: 'turn_context',
        timestamp: '2026-04-21T13:43:33.862Z',
        payload: { model: 'gpt-5.4' },
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
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
  );

  withEnv({ HOME: linuxHome, USERPROFILE: userProfile, CODEX_HOME: codexHome }, () => {
    const codex = freshAdapter('codex');
    assert.equal(codex.isAvailable(), true);

    const records = codex.collect({ cutoff: 0, useRealSessionName: true });
    const assistant = records.find(r => r.role === 'assistant');
    assert.ok(assistant);
    assert.equal(assistant.tool, 'codex-app');
    assert.equal(assistant.model, 'gpt-5.4');
    assert.equal(assistant.inputTokens, 60);
    assert.equal(assistant.cacheReadTokens, 40);
    assert.equal(assistant.outputTokens, 10);
  });
});

test('codex adapter scans WSL users root when USERPROFILE and CODEX_HOME are absent', () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'codex-wsl-root-'));
  const linuxHome = path.join(root, 'linux-home');
  const usersRoot = path.join(root, 'Users');
  const userProfile = path.join(usersRoot, 'tester');
  const sessionFile = path.join(
    userProfile,
    '.codex/sessions/2026/04/21/rollout-2026-04-21T14-43-19-session-1.jsonl'
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [
      {
        type: 'session_meta',
        timestamp: '2026-04-21T13:43:19.738Z',
        payload: { id: 'session-1', originator: 'Codex Desktop', model_provider: 'openai' },
      },
      {
        type: 'response_item',
        timestamp: '2026-04-21T13:43:33.862Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-04-21T13:43:45.305Z',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
        },
      },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
  );

  withEnv({ HOME: linuxHome, USERPROFILE: undefined, CODEX_HOME: undefined, WSL_USERS_ROOT: usersRoot }, () => {
    const codex = freshAdapter('codex');
    assert.equal(codex.isAvailable(), true);

    const records = codex.collect({ cutoff: 0, useRealSessionName: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'codex-app');
  });
});
