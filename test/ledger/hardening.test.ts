// Regressions from the final adversarial pass (lead fixes): linear quoted-span stripping, the Hebrew weak cue,
// and non-finite numbers in request bodies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { cues, stripQuoted, supersedeRules } from '../../src/engine/ledger/supersede.js';
import { hasUnsafeInteger } from '../../src/dialect/openai-chat.js';

const QUOTED =
  '(?<![\\p{L}\\p{N}])(?:"[^"\\n]*"|\u201c[^\u201d\\n]*\u201d|\u201e[^\u201c\u201d\\n]*[\u201c\u201d]|\u00ab[^\u00bb\\n]*\u00bb|`[^`\\n]*`|\'[^\'\\n]*\'|\u2018[^\u2019\\n]*\u2019)(?![\\p{L}\\p{N}])';

test('stripQuoted equals the quoted-span regex on random strings', () => {
  const alpha = ['a', ' ', '\n', '"', '\u201c', '\u201d', '\u201e', '\u00ab', '\u00bb', '`', "'", '\u2018', '\u2019', '1', 'ש', '😀'];
  let s = 7;
  const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 20_000; t++) {
    let x = '';
    for (let n = 1 + Math.floor(r() * 24); n > 0; n--) x += alpha[Math.floor(r() * alpha.length)];
    assert.equal(stripQuoted(x), x.replace(new RegExp(QUOTED, 'gu'), ' '), JSON.stringify(x));
  }
});

test('stripQuoted is linear on unclosed quote runs (the regex took 4.6 s on 20k)', () => {
  const t0 = performance.now();
  stripQuoted('\u201c'.repeat(200_000));
  stripQuoted(('"a ' + '\u2018'.repeat(50)).repeat(4000));
  assert.ok(performance.now() - t0 < 1500);
});

test('Hebrew "actually" status reports do not cue; Hebrew directives still do', () => {
  const rules = supersedeRules(DEFAULT_CONFIG.ledger);
  assert.equal(cues('בעצם הבדיקות עברו', rules), false);
  assert.equal(cues('בעצם תשתמש ב-staging-4', rules), true);
  assert.equal(cues('במקום staging-3 תעבור ל-staging-4', rules), true);
});

test('non-finite numbers are flagged like unsafe integers (never silently re-serialized as null)', () => {
  assert.equal(hasUnsafeInteger(JSON.parse('{"a":[1,{"maximum":1e400}]}')), true);
  assert.equal(hasUnsafeInteger(JSON.parse('{"a":-1e999}')), true);
  assert.equal(hasUnsafeInteger(JSON.parse('{"a":1.5,"b":[9007199254740991]}')), false);
});
