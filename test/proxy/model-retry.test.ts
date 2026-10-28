import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRequest } from '../../src/types.js';
import { shrinkingEngine } from './fake-engine.js';
import { DONE, bodyTokens, charCounter, chunk, fakeUpstream, request, sseRes, startProxy, testConfig } from './harness.js';

const SSE_OVERFLOW = (prompt: number, window: number): string =>
  `data: ${JSON.stringify({ error: { object: 'error', message: `The input (${prompt} tokens) is longer than the model's context length (${window} tokens).`, type: 'BadRequestError', param: null, code: 400 } })}\n\n`;

test('a retried request counts one retry for its model; a request without a retry leaves its model at 0', async () => {
  const budget = { window: 4000, defaultMaxTokens: 500, planMaxTokens: 500 };
  const cfg = testConfig({ budget });
  const counter = charCounter();
  const up = await fakeUpstream(async (hit, res) => {
    const p = bodyTokens(hit.json);
    if (p > 2000) await sseRes(res, [SSE_OVERFLOW(p, 2500), DONE]);
    else await sseRes(res, [chunk('ok'), chunk('', 'stop'), DONE]);
  });
  const f = await startProxy(up, shrinkingEngine(cfg, counter), { counter, config: { budget } });
  try {
    const history: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'goal' }];
    for (let i = 0; i < 8; i++) history.push({ role: 'assistant', content: 'a'.repeat(1000) }, { role: 'user', content: 'u'.repeat(1000) });
    const r1 = await request(f.port, { body: { model: 'm1', messages: history, max_tokens: 500, stream: true } });
    assert.equal(r1.status, 200);
    const r2 = await request(f.port, { body: { model: 'm2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 500, stream: true } });
    assert.equal(r2.status, 200);
    assert.equal(up.hits.length, 3, 'm1 retried once, m2 not at all');
    const s = f.proxy.snapshot();
    assert.equal((s['counters'] as Record<string, number>)['retries'], 1);
    const models = s['model_counters'] as Record<string, { retries: number }>;
    assert.equal(models['m1']?.retries, 1);
    assert.equal(models['m2']?.retries ?? 0, 0);
  } finally {
    await f.close();
    await up.close();
  }
});
