// The opt-in transient retry (upstream.retry): a 429/502/503/504 before any response byte is sent again
// unchanged after a capped backoff; nothing is learned, and off by default.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, chunk, fakeUpstream, jsonRes, okCompletion, request, sseRes, startProxy, type FixtureOptions } from './harness.js';

const busy = { error: { message: 'Service temporarily unavailable', type: 'server_error' } };
const retryOn = (retry: Record<string, unknown> = {}): FixtureOptions['config'] =>
  ({ upstream: { retry: { enabled: true, baseDelayMs: 1, maxDelayMs: 20, maxTotalDelayMs: 200, jitter: false, ...retry } } });

test('retry disabled (the default): a 429 is relayed with one upstream hit', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 429, busy));
  const f = await startProxy(t, up, passthroughEngine());
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 429);
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});

test('429 then 200: the client gets 200, the same body was sent twice, nothing is learned', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 429, busy) : jsonRes(res, 200, okCompletion())));
  const logs: string[] = [];
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(), log: (_l, m) => logs.push(m) });
  try {
    const r = await request(f.port, { body: chatBody() });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    assert.deepEqual(up.hits[1]!.body, up.hits[0]!.body);
    assert.deepEqual(f.state.entries(), {});
    assert.ok(logs.includes('upstream 429, transient retry attempt=2 delay_ms=1'), logs.join('\n'));
  } finally { await f.close(); await up.close(); }
});

test('three 503s with maxAttempts 3: the last 503 is relayed unchanged', async (t) => {
  const up = await fakeUpstream((h, res) => jsonRes(res, 503, { ...busy, n: h.n }));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn({ maxAttempts: 3 }) });
  try {
    const r = await request(f.port, { body: chatBody() });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json(), { ...busy, n: 3 });
    assert.equal(up.hits.length, 3);
  } finally { await f.close(); await up.close(); }
});

test('Retry-After: 0 retries at once; one above maxDelayMs is relayed at once with its header', async (t) => {
  let retryAfter = '0';
  const up = await fakeUpstream((h, res) => (h.n === 1 || retryAfter === '30' ? jsonRes(res, 503, busy, { 'retry-after': retryAfter }) : jsonRes(res, 200, okCompletion())));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn({ baseDelayMs: 20 }) });
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 200);
    assert.equal(up.hits.length, 2);
    assert.ok(up.hits[1]!.at - up.hits[0]!.at < 15, 'no backoff wait after Retry-After: 0');
    retryAfter = '30';
    const r = await request(f.port, { body: chatBody('again') });
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '30');
    assert.equal(up.hits.length, 3);
  } finally { await f.close(); await up.close(); }
});

test('the client leaves during the wait: no second upstream hit, and the proxy stays healthy', async (t) => {
  let ok = false;
  const up = await fakeUpstream((_h, res) => (ok ? jsonRes(res, 200, okCompletion()) : jsonRes(res, 503, busy)));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn({ baseDelayMs: 200, maxDelayMs: 200 }) });
  try {
    const payload = JSON.stringify(chatBody());
    const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/chat/completions', agent: false, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } });
    req.on('error', () => undefined);
    req.end(payload);
    while (up.hits.length === 0) await sleep(5);
    await sleep(20);
    req.destroy();
    await sleep(300);
    assert.equal(up.hits.length, 1);
    ok = true;
    assert.equal((await request(f.port, { body: chatBody('later') })).status, 200);
  } finally { await f.close(); await up.close(); }
});

test('a stream that fails after its first bytes is not retried', async (t) => {
  const errEv = `data: ${JSON.stringify({ error: { message: 'overloaded', type: 'server_error', code: 503 } })}\n\n`;
  const up = await fakeUpstream((_h, res) => sseRes(res, [chunk('partial'), errEv]));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn() });
  try {
    const r = await request(f.port, { body: chatBody('hello', { stream: true }) });
    assert.equal(r.status, 200);
    assert.match(r.text(), /partial/);
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});

test('a non-chat POST that gets a 503 is passed through with one hit', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 503, busy));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn() });
  try {
    assert.equal((await request(f.port, { path: '/v1/embeddings', body: { model: 'm1', input: 'x' } })).status, 503);
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});
