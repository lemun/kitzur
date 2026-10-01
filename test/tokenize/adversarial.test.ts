// Regression tests from the adversarial review of src/tokenize: quadratic regexes on content, part types that
// name Object.prototype members, runtime-dependent Unicode data in the estimator, and Python's sort_keys order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCounter } from '../../src/tokenize/counter.js';
import { createProfile, renderPrompt, TemplateError, trimTrailingNewlines } from '../../src/tokenize/template.js';
import { isLetterCp, isMarkCp, jsonProseStrings, textStats } from '../../src/tokenize/estimate.js';
import { ONIG_L, ONIG_M } from '../../src/tokenize/unicode-tables.js';
import { pyDumps } from '../../src/tokenize/pyjson.js';
import type { ChatRequest } from '../../src/types.js';

class Rng {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s * 1103515245 + 12345) % 2147483648;
    return this.s / 2147483648;
  }
}

const regexMatches = (s: string): Array<[number, number]> => {
  const re = /"(?:[^"\\\n]|\\.){40,}"/g;
  const out: Array<[number, number]> = [];
  for (let m = re.exec(s); m !== null; m = re.exec(s)) out.push([m.index, m.index + m[0].length]);
  return out;
};

test('jsonProseStrings finds exactly the matches of /"(?:[^"\\\\\\n]|\\\\.){40,}"/g (random differential)', () => {
  const r = new Rng(42);
  const special = ['"', '\\', '\n', '\r', ' ', ' '];
  const plain = ['a', 'b', 'c', ' ', 'é'];
  let withMatches = 0;
  for (let t = 0; t < 20_000; t++) {
    const len = Math.floor(r.next() * 320);
    const density = r.next() * 0.3;
    let s = '';
    for (let i = 0; i < len; i++) {
      s += r.next() < density ? special[Math.floor(r.next() * special.length)] : plain[Math.floor(r.next() * plain.length)];
    }
    const exp = regexMatches(s);
    if (exp.length) withMatches++;
    assert.deepEqual(jsonProseStrings(s), exp, JSON.stringify(s));
  }
  assert.ok(withMatches > 1000, `${withMatches} inputs with matches`);
});

test('jsonProseStrings is linear on escaped quotes (the regex took 11 s on 40k of them)', () => {
  const s = '{"a":"b":"c":"' + '\\"'.repeat(400_000) + '}';
  const t0 = performance.now();
  assert.deepEqual(jsonProseStrings(s), []);
  const e = createCounter({ mode: 'estimate', template: 'sim' });
  e.countRequest({ messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'x', content: s }] });
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

test('qwen3: a long newline run before </think> renders in linear time (/\\n+$/ took 5 s on 40k)', () => {
  for (const s of ['', '\n', 'a\n\n', '\n\na', 'a\nb\n']) assert.equal(trimTrailingNewlines(s), s.replace(/\n+$/, ''));
  const q = createCounter({ mode: 'estimate', template: 'qwen3' });
  const req: ChatRequest = {
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a' + '\n'.repeat(400_000) + 'x</think>answer' }, { role: 'user', content: 'ok' }],
  };
  const t0 = performance.now();
  q.countRequest(req);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

test('qwen3: content part types named after Object.prototype members are unknown types (a vLLM 400), not skipped text', () => {
  const p = createProfile('qwen3');
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const req: ChatRequest = { messages: [{ role: 'user', content: [{ type, text: 'x' } as never] }] };
    assert.throws(() => renderPrompt(p, req), TemplateError, type);
  }
  assert.match(renderPrompt(p, { messages: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' } as never] }] }), /hello/);
});

test('the estimator classifies letters and marks from the pinned Unicode tables, not the runtime', () => {
  const inR = (r: readonly number[], c: number): boolean => {
    for (let i = 0; i < r.length; i += 2) if (c >= r[i]! && c <= r[i + 1]!) return true;
    return false;
  };
  for (let c = 0; c <= 0x10ffff; c += 97) {
    assert.equal(isLetterCp(c), inR(ONIG_L, c), c.toString(16));
    assert.equal(isMarkCp(c), inR(ONIG_M, c), c.toString(16));
  }
  // U+10D4A (Garay, Unicode 16) is a letter on every Node version; U+A7CE (Unicode 17) is not, even where the
  // runtime's /\p{L}/u says it is (Node 22.23+ ships Unicode 17, Node 20 Unicode 15.1)
  assert.equal(textStats('\u{10D4A}').nonLatinLetters, 1);
  assert.equal(textStats('꟎').letters, 0);
});

test('pyDumps sort_keys orders keys by code point, as Python does', () => {
  const m = new Map<string, number>([['\u{1F600}', 1], ['￿', 2], ['a', 3]]);
  assert.equal(pyDumps(m, { sortKeys: true, ensureAscii: false }), '{"a": 3, "￿": 2, "\u{1F600}": 1}');
});
