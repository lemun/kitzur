import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLegacyPrompt, isLegacyCompletionsPath, parseLegacyPrompt } from '../../src/dialect/openai-completions.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
const counter = { countText: (text: string): number => text.length };

test('legacy completions path: any prefix, trailing slash, POST only, not chat or embeddings', () => {
  assert.ok(isLegacyCompletionsPath('POST', '/v1/completions'));
  assert.ok(isLegacyCompletionsPath('POST', '/v1/completions/'));
  assert.ok(isLegacyCompletionsPath('POST', '/api/openai/v1/completions'));
  assert.ok(!isLegacyCompletionsPath('GET', '/v1/completions'));
  assert.ok(!isLegacyCompletionsPath('POST', '/v1/chat/completions'));
  assert.ok(!isLegacyCompletionsPath('POST', '/v1/chat/completions/'));
  assert.ok(!isLegacyCompletionsPath('POST', '/v1/embeddings'));
});

test('a string prompt gives one prompt, an array of strings one per element', () => {
  assert.deepEqual(parseLegacyPrompt(buf('{"model":"m","prompt":"hello"}')), { ok: true, prompts: ['hello'] });
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":["a","bc"]}')), { ok: true, prompts: ['a', 'bc'] });
});

test('an empty array or a missing prompt is no_prompt', () => {
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":[]}')), { ok: false, reason: 'no_prompt' });
  assert.deepEqual(parseLegacyPrompt(buf('{"model":"m"}')), { ok: false, reason: 'no_prompt' });
});

test('token ids (flat or nested) are token_ids; other shapes are unsupported', () => {
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":[1,2,3]}')), { ok: false, reason: 'token_ids' });
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":[[1,2],[3]]}')), { ok: false, reason: 'token_ids' });
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":["a",1]}')), { ok: false, reason: 'unsupported' });
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":{"text":"a"}}')), { ok: false, reason: 'unsupported' });
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":null}')), { ok: false, reason: 'unsupported' });
});

test('non-object JSON is not_object; truncated JSON and non-UTF-8 bytes are not_json', () => {
  for (const t of ['[]', '"x"', 'null']) assert.deepEqual(parseLegacyPrompt(buf(t)), { ok: false, reason: 'not_object' }, t);
  assert.deepEqual(parseLegacyPrompt(buf('{"prompt":"ab')), { ok: false, reason: 'not_json' });
  const bad = Buffer.concat([buf('{"prompt":"'), Buffer.from([0xff, 0xfe]), buf('"}')]);
  assert.deepEqual(parseLegacyPrompt(bad), { ok: false, reason: 'not_json' });
});

test('fill-in-the-middle sentinels are returned byte for byte', () => {
  const fim = '<fim_prefix>a<fim_suffix>b<fim_middle>';
  const r = parseLegacyPrompt(buf(JSON.stringify({ prompt: fim })));
  assert.ok(r.ok);
  assert.equal(r.prompts[0], fim);
  assert.deepEqual(countLegacyPrompt(counter, r.prompts), { total: fim.length, max: fim.length });
});

test('a 1 MB prompt parses and the input buffer is not mutated', () => {
  const big = 'x'.repeat(1 << 20);
  const raw = buf(JSON.stringify({ prompt: big, max_tokens: 5 }));
  const copy = Buffer.from(raw);
  const r = parseLegacyPrompt(raw);
  assert.ok(r.ok);
  assert.equal(r.prompts[0]!.length, 1 << 20);
  assert.ok(raw.equals(copy));
});

test('countLegacyPrompt sums and maxes the counts', () => {
  assert.deepEqual(countLegacyPrompt(counter, ['ab', 'cde']), { total: 5, max: 3 });
  assert.deepEqual(countLegacyPrompt(counter, []), { total: 0, max: 0 });
});
