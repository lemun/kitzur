// /status reports the opt-in transient retry as running totals under `transient_retries`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, fakeUpstream, jsonRes, okCompletion, request, startProxy, type FixtureOptions } from './harness.js';

const busy = { error: { message: 'Service temporarily unavailable', type: 'server_error' } };
const retryOn = (retry: Record<string, unknown> = {}): FixtureOptions['config'] =>
  ({ upstream: { retry: { enabled: true, baseDelayMs: 1, maxDelayMs: 20, maxTotalDelayMs: 200, jitter: false, ...retry } } });
const totals = async (port: number): Promise<Record<string, unknown>> =>
  (await request(port, { method: 'GET', path: '/status' })).json().transient_retries;
const zeros = { retries: 0, by_status: {}, delay_ms: 0, exhausted: 0 };

test('retry disabled: transient_retries is all zeros and a 429 changes nothing', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 429, busy));
  const f = await startProxy(t, up, passthroughEngine());
  try {
    const before = await totals(f.port);
    assert.deepEqual(before, zeros);
    assert.deepEqual(Object.keys(before), ['retries', 'by_status', 'delay_ms', 'exhausted']);
    assert.equal((await request(f.port, { body: chatBody() })).status, 429);
    assert.deepEqual(await totals(f.port), zeros);
  } finally { await f.close(); await up.close(); }
});

test('429 then 200: one retry by status with the logged delay, nothing exhausted', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 429, busy) : jsonRes(res, 200, okCompletion())));
  const logs: string[] = [];
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn({ baseDelayMs: 3 }), log: (_l, m) => logs.push(m) });
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 200);
    assert.ok(logs.includes('upstream 429, transient retry attempt=2 delay_ms=3'), logs.join('\n'));
    assert.deepEqual(await totals(f.port), { retries: 1, by_status: { '429': 1 }, delay_ms: 3, exhausted: 0 });
  } finally { await f.close(); await up.close(); }
});

test('three 503s with maxAttempts 3: two retries, one exhausted, the last 503 relayed', async (t) => {
  const up = await fakeUpstream((h, res) => jsonRes(res, 503, { ...busy, n: h.n }));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn({ maxAttempts: 3 }) });
  try {
    const r = await request(f.port, { body: chatBody() });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json(), { ...busy, n: 3 });
    assert.deepEqual(await totals(f.port), { retries: 2, by_status: { '503': 2 }, delay_ms: 3, exhausted: 1 });
  } finally { await f.close(); await up.close(); }
});

test('a 400 is not a give-up; a Retry-After above maxDelayMs is, with no retry', async (t) => {
  let st = 400;
  const up = await fakeUpstream((_h, res) => jsonRes(res, st, busy, st === 503 ? { 'retry-after': '30' } : {}));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn() });
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 400);
    assert.deepEqual(await totals(f.port), zeros);
    st = 503;
    assert.equal((await request(f.port, { body: chatBody('again') })).status, 503);
    assert.deepEqual(await totals(f.port), { ...zeros, exhausted: 1 });
  } finally { await f.close(); await up.close(); }
});
