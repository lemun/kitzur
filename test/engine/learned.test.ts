import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Budget, ChatMessage } from '../../src/types.js';
import { computeBudget } from '../../src/engine/budget.js';
import { correctionPct, defaultLearnedEntry, fixedBytesOf, learnedKey, learnedValid, planningInputs, templateKwargs } from '../../src/engine/learned.js';
import { guardCheck, type GuardInput } from '../../src/engine/guard.js';
import { digestOf } from '../../src/engine/canonical.js';
import { estimateCounter, testConfig } from './stubs.js';

const counter = estimateCounter();

test('learned entries are keyed per origin|model and invalidated by window or counter ()', () => {
  const cfg = testConfig({ upstream: { origin: 'http://gw:8000' } });
  assert.equal(learnedKey(cfg, { model: 'qwen', messages: [] }), 'http://gw:8000|qwen');
  const e = defaultLearnedEntry(cfg, counter.id);
  assert.ok(learnedValid(e, cfg, counter.id));
  assert.ok(!learnedValid({ ...e, configuredWindow: 64_000 }, cfg, counter.id));
  assert.ok(!learnedValid(e, cfg, 'other-counter'));
  assert.equal(correctionPct({ ...e, correction: 1.03 }), 103);
  assert.equal(correctionPct({ ...e, correction: 1.0300000001 }), 104);
  assert.equal(correctionPct({ ...e, correction: 0.9 }), 100, 'correction >= 1');
});

test('templateKwargs: request booleans over config defaults; only the two known keys', () => {
  const cfg = testConfig({ tokenizer: { template: { name: 'qwen3', enableThinking: false, preserveThinking: null } } });
  assert.deepEqual(templateKwargs(cfg, { messages: [] }), { enable_thinking: false });
  assert.deepEqual(templateKwargs(cfg, { messages: [], chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, x: 1 } }), {
    enable_thinking: true, preserve_thinking: true,
  });
  assert.deepEqual(templateKwargs(testConfig(), { messages: [], chat_template_kwargs: { enable_thinking: 'yes' } }), {});
});

test('P (): kwargs, tools, tighten and correction change it; T_req does not (ADR-7)', () => {
  const cfg = testConfig();
  const E = defaultLearnedEntry(cfg, counter.id);
  const P = (req: Record<string, unknown>, e = E, tighten = 0) =>
    planningInputs({
      cfg, counter, tokenizerSha256: null, req: { messages: [], ...req }, E: e, tighten, window: 100_000, tPlan: 32_000, byteLimit: null, noClamp: false,
    });
  const base = P({ max_tokens: 16_000 });
  assert.deepEqual(P({ max_tokens: 32_000 }), base);
  assert.notDeepEqual(P({ chat_template_kwargs: { preserve_thinking: true } }), base);
  assert.notDeepEqual(P({ tools: [{ type: 'function', function: { name: 'x' } }] }), base);
  assert.notDeepEqual(P({}, E, 256), base);
  assert.notDeepEqual(P({}, { ...E, correction: 1.02 }), base);
  assert.equal(base.counterMode, 'estimate');
  assert.equal(base.tokenizerSha256, null);
  assert.equal(fixedBytesOf(undefined), 512);
  assert.equal(fixedBytesOf([{ a: 1 }]), 512 + '[{"a":1}]'.length);
});

test('guard: each check fails on its own', () => {
  const cfg = testConfig();
  const budget: Budget = computeBudget(cfg, defaultLearnedEntry(cfg, 'c'), 0, 32_000);
  const inp: ChatMessage[] = [
    { role: 'system', content: 'S' }, { role: 'user', content: 'g' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result' }, { role: 'user', content: 'next' },
  ];
  const ok: GuardInput = {
    input: inp, output: [inp[0]!, inp[1]!, { role: 'user', content: 'SUMMARY' }, inp[4]!],
    inDigests: inp.map(digestOf), outDigests: [], hEnd: 2, exempt: new Set(), countIn: 1000, countOut: 500,
    bytesIn: 1000, bytesOut: 600, budget, maxTokens: 32_000, overBudgetAllowed: false,
  };
  ok.outDigests = ok.output.map(digestOf);
  assert.equal(guardCheck(ok), null);
  assert.equal(guardCheck({ ...ok, output: [] }), 'invalid:empty');
  assert.equal(guardCheck({ ...ok, output: [inp[0]!, { content: 'x' } as unknown as ChatMessage] }), 'invalid:message_1');
  const orphan = [inp[0]!, inp[1]!, inp[3]!];
  assert.equal(guardCheck({ ...ok, output: orphan, outDigests: orphan.map(digestOf) }), 'pairing:orphan');
  assert.equal(guardCheck({ ...ok, countOut: budget.budget + 1, countIn: 1e6 }), 'over_budget');
  assert.equal(guardCheck({ ...ok, countOut: budget.budget + 1, countIn: 1e6, overBudgetAllowed: true, maxTokens: 1000 }), null);
  assert.equal(guardCheck({ ...ok, countOut: 67_000, countIn: 1e6, maxTokens: 32_001 }), 'server_fit');
  assert.equal(guardCheck({ ...ok, countOut: 1001 }), 'larger_tokens');
  assert.equal(guardCheck({ ...ok, bytesOut: 1001 }), 'larger_bytes');
  const more = [...inp, { role: 'user', content: 'x' }];
  assert.equal(guardCheck({ ...ok, output: more, outDigests: more.map(digestOf) }), 'more_messages');
  const head = [inp[0]!, { role: 'user', content: 'changed' }, inp[4]!];
  assert.equal(guardCheck({ ...ok, output: head, outDigests: head.map(digestOf) }), 'head');
  assert.equal(guardCheck({ ...ok, output: head, outDigests: head.map(digestOf), exempt: new Set([1]) }), null);
});
