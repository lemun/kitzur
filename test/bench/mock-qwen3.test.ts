import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qwen3Corpus } from '../../bench/mock/qwen3-corpus.js';
import { renderQwen3, Qwen3TemplateError, VllmValidationError } from '../../bench/mock/qwen3-render.js';
import { parsePyJson } from '../../bench/lib/jsonparse.js';
import { pyDumps, pyLen } from '../../bench/lib/pyjson.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';
import { benchFixture, Checker } from './fixtures.js';

interface GoldenCase {
  name: string;
  body_sha256: string;
  render_sha256?: string;
  render_len?: number;
  render?: string | null;
  tokens?: number;
  error: { type: 'template' | 'validation' | 'other'; message: string } | null;
}
const G = benchFixture<{ template_sha256: string; jinja2: string; cases: GoldenCase[] }>('qwen3-render.json.gz');
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const tokPath = testTokenizerPath();

test('qwen3 corpus is the one the jinja2 goldens were made from (>= 30 requests, all feature groups)', () => {
  const corpus = qwen3Corpus();
  assert.equal(G.template_sha256, 'e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259');
  assert.equal(corpus.length, G.cases.length);
  corpus.forEach((c, i) => {
    assert.equal(c.name, G.cases[i]!.name);
    assert.equal(sha(c.body), G.cases[i]!.body_sha256, `${c.name}: corpus body changed; regenerate the goldens`);
  });
  assert.ok(G.cases.filter((c) => c.error === null).length >= 30);
  for (const needle of ['reasoning', 'parallel calls + grouped results', 'preserve_thinking true', 'grouped results then user', 'enable_thinking false', 'developer'])
    assert.ok(corpus.some((c) => c.name.includes(needle)), needle);
});

test('qwen3 render: byte-identical to jinja2 + vLLM preprocessing on every golden request', () => {
  const ck = new Checker();
  for (const [i, c] of qwen3Corpus().entries()) {
    const g = G.cases[i]!;
    let text: string | null = null;
    let err: Error | null = null;
    try {
      text = renderQwen3(c.body);
    } catch (e) {
      err = e as Error;
    }
    if (g.error) {
      ck.eq(err ? err.name : 'no error', g.error.type === 'template' ? 'TemplateError' : g.error.type === 'validation' ? 'VLLMValidationError' : err?.name, `${c.name}: error type`);
      if (g.error.type !== 'other') ck.eq(err?.message ?? text, g.error.message, `${c.name}: error message`);
      continue;
    }
    if (err) {
      ck.eq(`threw ${err.message}`, 'rendered', c.name);
      continue;
    }
    ck.eq(pyLen(text!), g.render_len, `${c.name}: length (code points)`);
    if (g.render) ck.eq(text, g.render, `${c.name}: text`);
    ck.eq(sha(text!), g.render_sha256, `${c.name}: sha256`);
  }
  assert.equal(ck.fails.length, 0, ck.summary());
});

test('qwen3 render: token counts equal HF tokenizers on the rendered text', { skip: tokPath ? false : 'no dev tokenizer.json' }, () => {
  const counter = new PromptCounter(loadTokenizer(tokPath!));
  const ck = new Checker();
  for (const [i, c] of qwen3Corpus().entries()) {
    const g = G.cases[i]!;
    if (g.error) continue;
    ck.eq(counter.countSegments(counter.segments(renderQwen3(c.body))), g.tokens, c.name);
  }
  assert.equal(ck.fails.length, 0, ck.summary());
  // the reference session: real Qwen3.6 vs the sim render (reference implementation: 317,179 vs 316,604 at 46 steps)
  assert.equal(G.cases.find((c) => c.name.startsWith('reference history, 46'))!.tokens, 317_189);
});

test('Python json.loads semantics: key order, big ints, floats, duplicates, surrogates', () => {
  const v = parsePyJson('{"b": 1, "10": [1.0, 1e-05, 1E16, -0, 12345678901234567890], "2": "\\ud800x", "b": 2, "n": NaN}');
  assert.equal(pyDumps(v, { ensureAscii: false }), '{"b": 2, "10": [1.0, 1e-05, 1e+16, 0, 12345678901234567890], "2": "\ud800x", "n": NaN}');
  assert.throws(() => parsePyJson('{"a": 1,}'), /Expecting property name/);
  assert.throws(() => parsePyJson('"a\u0001"'), /Invalid control character/);
  assert.throws(() => renderQwen3('{"messages": []}'), Qwen3TemplateError);
  assert.throws(() => renderQwen3('{"messages": "x"}'), VllmValidationError);
});
