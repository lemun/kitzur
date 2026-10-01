import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { ROOT, testTokenizerPath } from '../helpers.js';

// 1,047 cases with ids produced by Python tokenizers 0.23.2 (see scripts/tokenizer/make-fixture.mjs).
const tokPath = testTokenizerPath();

test('tokenizer agrees with Python tokenizers on the committed fixture', { skip: tokPath ? false : 'no dev tokenizer.json' }, () => {
  const tok = loadTokenizer(tokPath!);
  const lines = gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'tokenizer-fixture.jsonl.gz'))).toString('utf8').trimEnd().split('\n');
  let bad = 0;
  for (const line of lines) {
    const { cat, text, ids } = JSON.parse(line) as { cat: string; text: string; ids: number[] };
    const got = tok.encode(text);
    if (got.length !== ids.length || got.some((x, i) => x !== ids[i])) {
      bad++;
      if (bad < 5) console.error('mismatch', cat, JSON.stringify(text.slice(0, 80)));
    }
    assert.equal(tok.count(text), ids.length);
  }
  assert.equal(bad, 0, `${bad}/${lines.length} mismatches`);
  assert.ok(lines.length >= 1000);
});
