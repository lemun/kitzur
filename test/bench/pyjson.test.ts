import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pyDumps, pyLen, pyFloat, pyFloatRepr, pySliceHead, cmpCodePoints } from '../../bench/lib/pyjson.js';
import { fmtInt, pyFixed, pyStrip, pySplitlines, pyCount } from '../../bench/lib/stats.js';
import { benchFixture, Checker } from './fixtures.js';

interface StrCase {
  input_codepoints: number[];
  ensure_ascii_true: string;
  ensure_ascii_false: string;
  py_len_input: number;
  py_len_dump_false: number;
  utf8_bytes_dump_false: number | null;
}
interface ValCase {
  dumps_default: string;
  dumps_ensure_ascii_false: string;
  dumps_indent2: string;
  dumps_compact: string;
}
const V = benchFixture<{ strings: StrCase[]; values: ValCase[]; scenario: Record<string, string> }>('pyjson.json.gz');

/** Build a JS string from code points; a lone surrogate code point becomes a lone UTF-16 unit. */
const fromCps = (cps: number[]): string => cps.map((c) => (c >= 0xd800 && c <= 0xdfff ? String.fromCharCode(c) : String.fromCodePoint(c))).join('');

test('pyDumps matches CPython json.dumps on the string vectors (both ensure_ascii modes)', () => {
  const c = new Checker();
  for (const [i, s] of V.strings.entries()) {
    const str = fromCps(s.input_codepoints);
    c.eq(pyDumps(str), s.ensure_ascii_true, `str ${i} ascii`);
    c.eq(pyDumps(str, { ensureAscii: false }), s.ensure_ascii_false, `str ${i} utf`);
    c.eq(pyLen(str), s.py_len_input, `str ${i} pyLen`);
    c.eq(pyLen(pyDumps(str, { ensureAscii: false })), s.py_len_dump_false, `str ${i} pyLen dump`);
    if (s.utf8_bytes_dump_false !== null)
      c.eq(Buffer.byteLength(pyDumps(str, { ensureAscii: false }), 'utf8'), s.utf8_bytes_dump_false, `str ${i} utf8`);
  }
  assert.equal(c.fails.length, 0, c.summary());
  assert.ok(V.strings.length >= 14);
});

test('pyDumps matches CPython json.dumps on value vectors (separators, indent, key order)', () => {
  // JS mirrors of the Python VALUES list (index-aligned). Index 3 holds floats JS cannot express as
  // Python does (1.0, -0.0, 1e+16, 1e+22, 2**53+1, 10**20); it is covered with PyFloat/BigInt below.
  const values: unknown[] = [
    { k: 'v', n: 1, f: 1.5, t: true, nil: null, arr: [1, 2, []], obj: {} },
    new Map<string, number>([['b', 1], ['a', 2], ['10', 3], ['2', 4]]),
    [0.1, 1e-5, 123456789.123, 0.25, 3.0e-7],
    [pyFloat(1), pyFloat(-0), pyFloat(1e16), pyFloat(1e22), 2n ** 53n + 1n, 10n ** 20n],
    { todos: [{ content: 'Migrate cart page objects', status: 'in_progress' }] },
    { command: 'ls -R tests/e2e | head -300' },
    { pattern: "locator\\('\\.", path: '/repo/src/pages' },
    [],
    {},
    { nested: { deeper: [{ x: [null, false] }] } },
  ];
  const c = new Checker();
  for (const [i, v] of values.entries()) {
    const w = V.values[i]!;
    c.eq(pyDumps(v), w.dumps_default, `val ${i} default`);
    c.eq(pyDumps(v, { ensureAscii: false }), w.dumps_ensure_ascii_false, `val ${i} utf`);
    c.eq(pyDumps(v, { indent: 2 }), w.dumps_indent2, `val ${i} indent2`);
    c.eq(pyDumps(v, { separators: [',', ':'] }), w.dumps_compact, `val ${i} compact`);
  }
  assert.equal(c.fails.length, 0, c.summary());
  // the integer-like key pitfall of plain objects is real
  assert.notEqual(pyDumps({ b: 1, a: 2, 10: 3, 2: 4 }), V.values[1]!.dumps_default);
});

test('pyDumps scenario vectors, sort_keys, floats', () => {
  const sc = V.scenario;
  assert.ok(Object.keys(sc).length >= 4);
  assert.equal(pyDumps({ b: 1, a: { d: 2, c: 3 } }, { sortKeys: true }), '{"a": {"c": 3, "d": 2}, "b": 1}');
  // code-point order: U+10000 sorts after U+FFFF (UTF-16 order would put it first)
  assert.ok(cmpCodePoints('\u{10000}', '￿') > 0);
  assert.equal(pyDumps(new Map([['\u{10000}', 1], ['￿', 2]]), { sortKeys: true, ensureAscii: false }), '{"￿": 2, "\u{10000}": 1}');
  for (const [x, want] of [[1e-5, '1e-05'], [0.0001, '0.0001'], [1.5, '1.5'], [1e16, '1e+16'], [123456789012345.6, '123456789012345.6'], [2.5e-7, '2.5e-07'], [1.0, '1.0'], [-0, '-0.0']] as const)
    assert.equal(pyFloatRepr(x), want);
  assert.equal(pyDumps({ ts: pyFloat(1790584708.6186826), secs: pyFloat(1) }), '{"ts": 1790584708.6186826, "secs": 1.0}');
  assert.equal(pyDumps(10 ** 21), '1000000000000000000000');
  assert.equal(pySliceHead('a\u{1F600}b', 2), 'a\u{1F600}');
});

test('Python formatting helpers', () => {
  assert.equal(fmtInt(1734118), '1,734,118');
  assert.equal(fmtInt(-1234), '-1,234');
  assert.equal(fmtInt(0), '0');
  // ties to even on exact binary ties; JS toFixed disagrees on these
  assert.equal(pyFixed(1125 / 1000, 2), '1.12');
  assert.equal(pyFixed(1625 / 1000, 2), '1.62');
  assert.equal(pyFixed(1375 / 1000, 2), '1.38');
  assert.equal(pyFixed(1875 / 1000, 2), '1.88');
  assert.equal(pyFixed(1.03, 2), '1.03');
  assert.equal(pyFixed(-0.125, 2), '-0.12');
  assert.equal(pyStrip('\x1c\x85 a ﻿'), 'a ﻿');
  assert.deepEqual(pySplitlines('a\r\nb\rc\n\nd\x0be\n'), ['a', 'b', 'c', '', 'd', 'e']);
  assert.deepEqual(pySplitlines(''), []);
  assert.equal(pyCount('result: x result: x', 'result: x'), 2);
});
