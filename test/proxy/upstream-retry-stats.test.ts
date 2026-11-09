// A request that waited out transient upstream retries says so in its stats line (transient_retries,
// transient_retry_delay_ms); a request without one has neither key, and `kitzur report` ignores them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { report } from '../../src/diagnostics/report.js';
import { buildStatsRecord } from '../../src/proxy/stats.js';
import { passthroughEngine, result } from './fake-engine.js';
import { chatBody, fakeUpstream, jsonRes, okCompletion, request, startProxy, waitRecords, type FixtureOptions } from './harness.js';

const busy = { error: { message: 'Service temporarily unavailable', type: 'server_error' } };
const retryOn = (retry: Record<string, unknown> = {}): FixtureOptions['config'] =>
  ({ upstream: { retry: { enabled: true, baseDelayMs: 1, maxDelayMs: 20, maxTotalDelayMs: 200, jitter: false, ...retry } } });
const delays = (logs: string[]): number[] => logs.flatMap((m) => /transient retry attempt=\d+ delay_ms=(\d+)/.exec(m)?.[1] ?? []).map(Number);

test('429 then 200: one record with transient_retries 1 and the waited delay', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 429, busy) : jsonRes(res, 200, okCompletion())));
  const logs: string[] = [];
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(), log: (_l, m) => logs.push(m) });
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 200);
    const recs = await waitRecords(f, 1);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.client_status, 200);
    assert.equal(recs[0]!.transient_retries, 1);
    assert.deepEqual(delays(logs), [1]);
    assert.equal(recs[0]!.transient_retry_delay_ms, 1);
  } finally { await f.close(); await up.close(); }
});

test('three 503s with maxAttempts 3: transient_retries 2 and client_status 503', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 503, busy));
  const logs: string[] = [];
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn({ maxAttempts: 3 }), log: (_l, m) => logs.push(m) });
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 503);
    const recs = await waitRecords(f, 1);
    assert.equal(recs[0]!.client_status, 503);
    assert.equal(recs[0]!.transient_retries, 2);
    const waited = delays(logs);
    assert.equal(waited.length, 2);
    assert.equal(recs[0]!.transient_retry_delay_ms, waited[0]! + waited[1]!);
  } finally { await f.close(); await up.close(); }
});

test('retry disabled, and a clean 200 with retry on: neither key in the record', async (t) => {
  const off = await fakeUpstream((_h, res) => jsonRes(res, 429, busy));
  const f1 = await startProxy(t, off, passthroughEngine());
  try {
    assert.equal((await request(f1.port, { body: chatBody() })).status, 429);
    const [rec] = await waitRecords(f1, 1);
    assert.equal(rec!.client_status, 429);
    assert.ok(!('transient_retries' in rec!) && !('transient_retry_delay_ms' in rec!));
  } finally { await f1.close(); await off.close(); }
  const ok = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const f2 = await startProxy(t, ok, passthroughEngine(), { config: retryOn() });
  try {
    assert.equal((await request(f2.port, { body: chatBody() })).status, 200);
    const [rec] = await waitRecords(f2, 1);
    assert.ok(!('transient_retries' in rec!) && !('transient_retry_delay_ms' in rec!));
  } finally { await f2.close(); await ok.close(); }
});

const built = (extra: { transientRetries?: number; transientDelayMs?: number }) => {
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
  const engine = result(req, req, false);
  return buildStatsRecord({
    seq: 1, ts: new Date('2026-01-01T00:00:00.000Z'), path: '/v1/chat/completions', first: engine, last: engine,
    action: 'passthrough', attempts: [], clientStatus: 200, tokensIn: 1, correction: 1, engineMs: 0, totalMs: 1,
    compacted: false, shadow: false, forwarded: 'engine', usage: null, usageMismatch: false, rewriteRejected: false, ...extra,
  });
};

test('buildStatsRecord with transientRetries 0 writes neither key', () => {
  const rec = built({ transientRetries: 0, transientDelayMs: 0 });
  assert.ok(!('transient_retries' in rec) && !('transient_retry_delay_ms' in rec));
  assert.deepEqual(rec, built({}));
});

test('report over a record with the new keys succeeds and its totals are unchanged', () => {
  const plain = JSON.stringify(built({})) + '\n';
  const retried = JSON.stringify(built({ transientRetries: 2, transientDelayMs: 30 })) + '\n';
  assert.match(retried, /"transient_retries":2,"transient_retry_delay_ms":30/);
  assert.deepEqual(report(retried), { ...report(plain), transientRetries: { requests: 1, retries: 2, delayMs: 30 } });
  assert.equal(report(retried).requests, 1);
});
