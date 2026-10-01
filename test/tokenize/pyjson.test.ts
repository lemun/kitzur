import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parsePyJson, pyDumps, pyFloatRepr, pyLen, pyStr, PyFloat, PyJsonDecodeError } from '../../src/tokenize/pyjson.js';
import { ROOT } from '../helpers.js';

// pyjson-vectors.json: CPython 3.14 json.dumps vectors from the sim-port reference study.
// pyjson-extra.json.gz: scripts/tokenizer/gen_pyjson_extra.py (float repr, loads round trips, errors).
const load = (f: string): any => {
  const b = readFileSync(join(ROOT, 'test', 'fixtures', f));
  return JSON.parse((f.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8'));
};
const V = load('pyjson-vectors.json');
const X = load('pyjson-extra.json.gz');

test('pyStr / pyLen match CPython on the string vectors (both ensure_ascii modes)', () => {
  assert.equal(V.strings.length, 14);
  for (const s of V.strings) {
    const input = String.fromCodePoint(...(s.input_codepoints as number[]));
    assert.equal(pyStr(input, true), s.ensure_ascii_true, JSON.stringify(input));
    assert.equal(pyStr(input, false), s.ensure_ascii_false, JSON.stringify(input));
    assert.equal(pyDumps(input), s.ensure_ascii_true);
    assert.equal(pyLen(input), s.py_len_input);
    assert.equal(pyLen(pyStr(input, false)), s.py_len_dump_false);
    if (s.utf8_bytes_dump_false !== null) assert.equal(Buffer.byteLength(pyStr(input, false)), s.utf8_bytes_dump_false);
  }
});

test('pyDumps matches CPython on the value vectors (default, ensure_ascii=False, indent=2, compact)', () => {
  // the vectors give Python reprs; these are the same values in the PyValue model
  const values: unknown[] = [
    new Map<string, unknown>([['k', 'v'], ['n', 1], ['f', 1.5], ['t', true], ['nil', null], ['arr', [1, 2, []]], ['obj', {}]]),
    new Map<string, unknown>([['b', 1], ['a', 2], ['10', 3], ['2', 4]]),
    [0.1, 1e-5, 123456789.123, 0.25, 3e-7],
    [new PyFloat(1), new PyFloat(-0), new PyFloat(1e16), new PyFloat(1e22), 9007199254740993n, 100000000000000000000n],
    { todos: [{ content: 'Migrate cart page objects', status: 'in_progress' }] },
    { command: 'ls -R tests/e2e | head -300' },
    { pattern: "locator\\('\\.", path: '/repo/src/pages' },
    [],
    {},
    { nested: { deeper: [{ x: [null, false] }] } },
  ];
  assert.equal(values.length, V.values.length);
  V.values.forEach((row: any, i: number) => {
    const v = values[i];
    assert.equal(pyDumps(v), row.dumps_default, row.input_py_repr);
    assert.equal(pyDumps(v, { ensureAscii: false }), row.dumps_ensure_ascii_false, row.input_py_repr);
    assert.equal(pyDumps(v, { indent: 2 }), row.dumps_indent2, row.input_py_repr);
    assert.equal(pyDumps(v, { separators: [',', ':'] }), row.dumps_compact, row.input_py_repr);
  });
});

test('pyDumps reproduces the scenario dumps (assistant tool_calls, todo output, sim tool call, grep args)', () => {
  const todos = [
    { content: 'Migrate cart page objects', status: 'in_progress' },
    { content: 'Migrate payment page objects', status: 'pending' },
    { content: 'TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', status: 'pending' },
    { content: 'Run full checkout suite on staging-3', status: 'pending' },
  ];
  const calls = [{ id: 'call_0003_0', type: 'function', function: { name: 'todowrite', arguments: pyDumps({ todos }) } }];
  assert.equal(pyDumps(calls), V.scenario.assistant_message_3_tool_calls_dumps);
  assert.equal(pyDumps(todos, { indent: 2 }), V.scenario.todo_output_step3);
  const args = pyDumps({ element: 'review continue button', ref: 'e568' });
  assert.equal(pyDumps({ name: 'browser_click', arguments: args }, { ensureAscii: false }), V.scenario.render_toolcall_step16);
  assert.equal(pyDumps({ pattern: "locator\\('\\.", path: '/repo/src/pages' }), V.scenario.grep_args_step12_dumps);
});

test('pyFloatRepr equals Python repr() and json.dumps on special, boundary and random doubles', () => {
  assert.ok(X.floats.length > 1000);
  const dv = new DataView(new ArrayBuffer(8));
  for (const [hex, repr, dumped] of X.floats as [string, string, string][]) {
    dv.setBigUint64(0, BigInt('0x' + hex));
    const x = dv.getFloat64(0);
    if (Number.isFinite(x)) assert.equal(pyFloatRepr(x), repr, hex);
    assert.equal(pyDumps(new PyFloat(x)), dumped, hex);
    if (!Number.isInteger(x)) assert.equal(pyDumps(x), dumped, hex); // non-integral numbers are floats
  }
});

test('parsePyJson + pyDumps round-trip like json.dumps(json.loads(s)) (lossless ints/floats, dict semantics)', () => {
  for (const [src, want] of X.loads as [string, string][]) {
    assert.equal(pyDumps(parsePyJson(src), { ensureAscii: false }), want, src);
  }
  for (const [src, isError] of X.errors as [string, boolean][]) {
    if (isError) assert.throws(() => parsePyJson(src), PyJsonDecodeError, JSON.stringify(src));
    else assert.doesNotThrow(() => parsePyJson(src));
  }
  // integer-like keys keep wire order (a plain JS object would hoist "2" and "10")
  const m = parsePyJson('{"b": 1, "a": 2, "10": 3, "2": 4}');
  assert.ok(m instanceof Map);
  assert.deepEqual([...(m as Map<string, unknown>).keys()], ['b', 'a', '10', '2']);
});

test('pyDumps: undefined object values are skipped, sortKeys, Map keys of other types', () => {
  assert.equal(pyDumps({ a: 1, b: undefined, c: [undefined] }), '{"a": 1, "c": [null]}');
  assert.equal(pyDumps({ b: 1, a: 2 }, { sortKeys: true }), '{"a": 2, "b": 1}');
  assert.equal(pyDumps(new Map<unknown, unknown>([[1, 'x'], [true, 'y'], [null, 'z'], [1.5, 'w']])), '{"1": "x", "true": "y", "null": "z", "1.5": "w"}');
});
