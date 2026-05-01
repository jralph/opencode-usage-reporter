// Shared tokenizer — single @anthropic-ai/tokenizer instance reused across adapters.
//
// Adapters push work items (`{ id, texts: string[] }`) and later read token
// counts back from the returned Map. We use Claude's tokenizer as a
// reasonable approximation even for non-Anthropic providers; the reporter has
// always done this for OpenCode estimates.

let _tokenizer = null;

function getSharedTokenizer() {
  if (_tokenizer) return _tokenizer;
  const { getTokenizer } = require('@anthropic-ai/tokenizer');
  _tokenizer = getTokenizer();
  return _tokenizer;
}

function releaseTokenizer() {
  if (_tokenizer) {
    try { _tokenizer.free(); } catch {}
    _tokenizer = null;
  }
}

function progressBar(current, total, label) {
  const width = 30;
  const pct = total === 0 ? 1 : current / total;
  const filled = Math.round(width * pct);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stderr.write(`\r  [${bar}] ${Math.round(pct * 100)}% ${label}`);
  if (current >= total) process.stderr.write('\n');
}

// Count tokens in a single string. Fast path; intended for streaming use
// when an adapter is already processing one record at a time and doesn't
// want to hold all texts in memory at once.
function countTokens(text) {
  if (!text) return 0;
  const t = getSharedTokenizer();
  return t.encode(text.normalize('NFKC'), 'all').length;
}

function tokenizeAll(workItems) {
  if (workItems.length === 0) return new Map();

  const tokenizer = getSharedTokenizer();
  const map = new Map();
  const total = workItems.length;

  for (let i = 0; i < total; i++) {
    const item = workItems[i];
    let tokens = 0;
    for (const text of item.texts) {
      if (text) tokens += tokenizer.encode(text.normalize('NFKC'), 'all').length;
    }
    map.set(item.id, tokens);
    // Drop reference to texts so memory can be reclaimed before the caller's
    // workItems array goes out of scope — important when adapters build
    // 100k+ item arrays with large payloads.
    item.texts = null;
    if (i % 100 === 0 || i === total - 1) {
      progressBar(i + 1, total, `${i + 1}/${total} items`);
    }
  }

  return map;
}

module.exports = { tokenizeAll, countTokens, getSharedTokenizer, releaseTokenizer, progressBar };
