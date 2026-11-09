// upstream.retry.paths: a listed non-chat path is retried on a 429/502/503/504 with the chat path's
// rules (attempts, Retry-After, the abortable wait); every path not listed is relayed after one hit.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/validate.js';
import { passthroughEngine } from './fake-engine.js';
import { fakeUpstream, jsonRes, request, startProxy, type FixtureOptions } from './harness.js';

const busy = { error: { message: 'Service temporarily unavailable', type: 'server_error' } };
const embedding = { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }] };
const input = { model: 'm1', input: 'some text' };
const retryOn = (paths: string[], retry: Record<string, unknown> = {}): FixtureOptions['config'] =>
  ({ upstream: { retry: { enabled: true, baseDelayMs: 1, maxDelayMs: 20, maxTotalDelayMs: 200, jitter: false, paths, ...retry } } });

test('a listed path answered 503 then 200: the client gets 200 and the identical body was sent twice', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 503, busy) : jsonRes(res, 200, embedding)));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(['/v1/embeddings']) });
  try {
    const r = await request(f.port, { path: '/v1/embeddings', body: input });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), embedding);
    assert.equal(up.hits.length, 2);
    assert.equal(up.hits[1]!.method, 'POST');
    assert.deepEqual(up.hits[1]!.body, up.hits[0]!.body);
  } finally { await f.close(); await up.close(); }
});

test('no paths listed: a 503 on /v1/embeddings is relayed with one hit', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 503, busy) : jsonRes(res, 200, embedding)));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn([]) });
  try {
    assert.equal((await request(f.port, { path: '/v1/embeddings', body: input })).status, 503);
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});

test('a path with a query string matches by its pathname and is forwarded with the query', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 502, busy) : jsonRes(res, 200, embedding)));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(['/v1/embeddings']) });
  try {
    assert.equal((await request(f.port, { path: '/v1/embeddings?api-version=2', body: input })).status, 200);
    assert.equal(up.hits.length, 2);
    assert.equal(up.hits[1]!.url, '/v1/embeddings?api-version=2');
  } finally { await f.close(); await up.close(); }
});

test('a listed path that always answers 429: the last 429 is relayed unchanged after maxAttempts', async (t) => {
  const up = await fakeUpstream((h, res) => jsonRes(res, 429, { ...busy, n: h.n }));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(['/v1/embeddings'], { maxAttempts: 3 }) });
  try {
    const r = await request(f.port, { path: '/v1/embeddings', body: input });
    assert.equal(r.status, 429);
    assert.deepEqual(r.json(), { ...busy, n: 3 });
    assert.equal(up.hits.length, 3);
  } finally { await f.close(); await up.close(); }
});

test('a Retry-After above maxDelayMs is relayed at once with its header', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 503, busy, { 'retry-after': '30' }));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(['/v1/embeddings']) });
  try {
    const r = await request(f.port, { path: '/v1/embeddings', body: input });
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '30');
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});

test('the client leaves during the wait: no further upstream request', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 503, busy));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(['/v1/embeddings'], { baseDelayMs: 200, maxDelayMs: 200 }) });
  try {
    const payload = JSON.stringify(input);
    const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/embeddings', agent: false, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } });
    req.on('error', () => undefined);
    req.end(payload);
    while (up.hits.length === 0) await sleep(5);
    await sleep(20);
    req.destroy();
    await sleep(300);
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});

test('retry.enabled false: a listed path is not retried', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 503, busy) : jsonRes(res, 200, embedding)));
  const f = await startProxy(t, up, passthroughEngine(), { config: retryOn(['/v1/embeddings'], { enabled: false }) });
  try {
    assert.equal((await request(f.port, { path: '/v1/embeddings', body: input })).status, 503);
    assert.equal(up.hits.length, 1);
  } finally { await f.close(); await up.close(); }
});

test('shadow mode: a listed path is still retried', async (t) => {
  const up = await fakeUpstream((h, res) => (h.n === 1 ? jsonRes(res, 503, busy) : jsonRes(res, 200, embedding)));
  const f = await startProxy(t, up, passthroughEngine(), { config: { ...retryOn(['/v1/embeddings']), shadow: true } });
  try {
    assert.equal((await request(f.port, { path: '/v1/embeddings', body: input })).status, 200);
    assert.equal(up.hits.length, 2);
  } finally { await f.close(); await up.close(); }
});

test('config: a path without a leading /, with a query or more than 20 entries is rejected', () => {
  const errorsWith = (paths: string[]): string[] => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.upstream.retry.paths = paths;
    return validateConfig(c).errors;
  };
  assert.deepEqual(errorsWith(['/v1/embeddings', '/v1/rerank']), []);
  for (const paths of [['v1/x'], ['/v1/x?y=1'], Array.from({ length: 21 }, (_, i) => `/v1/p${i}`)]) {
    const errors = errorsWith(paths);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0]!, /^upstream\.retry\.paths: /);
  }
  assert.match(errorsWith(['v1/x'])[0]!, /"v1\/x"/);
  assert.match(errorsWith(['/v1/x?y=1'])[0]!, /"\/v1\/x\?y=1"/);
});
