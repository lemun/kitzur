import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCounter } from '../../src/tokenize/counter.js';
import { TemplateError } from '../../src/tokenize/template.js';
import type { ChatMessage } from '../../src/types.js';

// estimate mode needs no tokenizer file, so none of these skip. Properties, not magic numbers.
const IMG = 1568;
const counter = createCounter({ mode: 'estimate', template: 'qwen3', imageTokens: IMG });
const HI: ChatMessage = { role: 'user', content: 'hi' }; // qwen3 needs a user query first
const cost = (m: ChatMessage): number => counter.measure({ messages: [HI, m] }).perMessage[1]!;
const call = (args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: args } }] }) as unknown as ChatMessage;
const argsOf = (n: number) => JSON.stringify({ data: 'v'.repeat(n - 12) });

test('estimate: tool_calls arguments are counted and grow about linearly', () => {
  const small = cost(call(argsOf(400)));
  const big = cost(call(argsOf(40_000)));
  const none = cost({ role: 'assistant', content: null } as unknown as ChatMessage);
  assert.ok(big > small && big > none, `big ${big} small ${small} none ${none}`);
  const ratio = (big - none) / (small - none);
  assert.ok(ratio > 100 / 3 && ratio < 100 * 3, `growth ${ratio.toFixed(1)} for 100x the length`);
  for (const args of [{ a: 1 }, 'not json {', undefined]) assert.ok(cost(call(args)) > 0, String(args));
});

test('estimate: content null costs the same as content ""', () => {
  for (const role of ['user', 'assistant']) {
    assert.equal(cost({ role, content: null } as unknown as ChatMessage), cost({ role, content: '' }), role);
  }
});

test('estimate: n image parts cost n*imageTokens (+ small framing), independent of URL length', () => {
  for (const n of [1, 2, 5]) {
    for (const url of ['x', 'data:image/png;base64,' + 'A'.repeat(500_000)]) {
      const c = cost({ role: 'user', content: Array.from({ length: n }, () => ({ type: 'image_url', image_url: { url } })) });
      assert.ok(c >= n * IMG && c <= n * IMG + 50, `n ${n} url ${url.length}: ${c}`);
    }
  }
});

test('estimate: one huge message is finite, plausible, fast, and sums to the total', () => {
  const texts = {
    prose: 'The quick brown fox jumps over the lazy dog. '.repeat(70_000),
    code: 'const x = 1;\n'.repeat(240_000),
    json: JSON.stringify(Array.from({ length: 100_000 }, (_, i) => ({ id: i, ok: true }))),
  };
  for (const [kind, text] of Object.entries(texts)) {
    const t0 = performance.now();
    const m = counter.measure({ messages: [{ role: 'user', content: text }] });
    const ms = performance.now() - t0;
    assert.ok(Number.isInteger(m.total) && m.total >= text.length / 8 && m.total < text.length, `${kind}: ${m.total} for ${text.length} chars`);
    assert.ok(ms < 2000, `${kind}: ${ms.toFixed(0)} ms`);
    assert.equal(m.perMessage.reduce((a, b) => a + b, 0) + m.overhead, m.total, kind);
  }
});

test('estimate: appending text never lowers a message estimate', () => {
  const chunks = ['Some prose about the plan. ', 'function f(a) {\n  return a + 1;\n}\n', '{"k": [1, 2, 3], "s": "v"}\n'];
  let text = '';
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    text += chunks[i % 3]!.repeat(i + 1);
    const c = cost({ role: 'user', content: text });
    assert.ok(c >= prev, `prefix ${i}: ${c} < ${prev}`);
    prev = c;
  }
});

test('estimate: unsupported part types and numeric content throw TemplateError', () => {
  const audio = { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] } as unknown as ChatMessage;
  const num = { role: 'user', content: 42 } as unknown as ChatMessage;
  for (const m of [audio, num]) assert.throws(() => cost(m), TemplateError);
});
