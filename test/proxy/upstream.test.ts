import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { Upstream, UpstreamError, forwardRequestHeaders, forwardResponseHeaders, readBody } from '../../src/proxy/upstream.js';
import { fakeUpstream, jsonRes, sleep, testConfig } from './harness.js';

const upCfg = (origin: string, over: Partial<ReturnType<typeof testConfig>['upstream']> = {}) => ({ ...testConfig().upstream, origin, ...over });

test('request headers: hop-by-hop and Connection-named dropped, identity encoding, extras added, unknown kept', () => {
  const raw = [
    'Host', 'proxy:1', 'Connection', 'keep-alive, X-Hop', 'X-Hop', 'secret-hop', 'Keep-Alive', 'timeout=5', 'Transfer-Encoding', 'chunked',
    'Content-Length', '10', 'Expect', '100-continue', 'Accept-Encoding', 'gzip, br', 'TE', 'trailers', 'Upgrade', 'h2c', 'Proxy-Connection', 'x',
    'Authorization', 'Bearer t', 'x-sim-step', '7', 'X-Session-Id', 'ses_1', 'X-Custom.Dot', 'v', 'Accept', 'a', 'Accept', 'b', 'Trailer', 'x',
  ];
  const h = forwardRequestHeaders(raw, { 'X-Gateway-Key': 'k', authorization: 'Bearer override' });
  assert.deepEqual(h, {
    authorization: 'Bearer override', 'x-sim-step': '7', 'x-session-id': 'ses_1', 'x-custom.dot': 'v', accept: ['a', 'b'],
    'x-gateway-key': 'k', 'accept-encoding': 'identity',
  });
});

test('response headers: hop-by-hop and Connection-named dropped; content-length dropped on request', () => {
  const raw = ['Content-Type', 'text/event-stream', 'Connection', 'close, X-Internal', 'X-Internal', '1', 'Transfer-Encoding', 'chunked', 'Content-Length', '5', 'X-Up', 'yes'];
  assert.deepEqual(forwardResponseHeaders(raw), ['Content-Type', 'text/event-stream', 'Content-Length', '5', 'X-Up', 'yes']);
  assert.deepEqual(forwardResponseHeaders(raw, { dropContentLength: true }), ['Content-Type', 'text/event-stream', 'X-Up', 'yes']);
});

test('content-length framing, never chunked; the origin path prefix is kept; keep-alive reuse', async () => {
  const up = await fakeUpstream((hit, res) => jsonRes(res, 200, { ok: hit.n }));
  const u = new Upstream(upCfg(up.origin + '/base/'));
  try {
    const body = Buffer.from('{"x":"héllo"}');
    for (let i = 0; i < 3; i++) {
      const r = await u.request({ method: 'POST', path: '/v1/chat/completions?a=1', headers: forwardRequestHeaders(['X-A', '1']), body });
      assert.equal(r.status, 200);
      assert.equal(r.reused, i > 0);
      await readBody(r.body);
    }
    const h = up.hits[0]!;
    assert.equal(h.url, '/base/v1/chat/completions?a=1');
    assert.equal(h.headers['content-length'], String(body.length));
    assert.equal(h.headers['transfer-encoding'], undefined);
    assert.equal(h.headers['accept-encoding'], 'identity');
    assert.equal(h.headers['x-a'], '1');
    assert.ok(h.body.equals(body));
    assert.equal(up.connections, 1, 'one keep-alive connection for three requests');
    assert.equal(u.stats.reusedSockets, 2);
  } finally {
    u.close();
    await up.close();
  }
});

test('idle pooled sockets close after keepAliveIdleMs', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, {}));
  const u = new Upstream(upCfg(up.origin, { keepAliveIdleMs: 150 }));
  try {
    const r = await u.request({ method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) });
    await readBody(r.body);
    await sleep(30);
    assert.equal(up.sockets.size, 1, 'kept alive');
    await sleep(400);
    assert.equal(up.sockets.size, 0, 'closed by the client after the idle timeout');
  } finally {
    u.close();
    await up.close();
  }
});

test('a reused socket reset before any response byte is retried once on a fresh connection', async () => {
  const served = new WeakMap<Socket, number>();
  let killReused = false;
  const up = await fakeUpstream((hit, res) => {
    const n = (served.get(hit.socket) ?? 0) + 1;
    served.set(hit.socket, n);
    if (killReused && n > 1) {
      hit.socket.destroy(); // the server closed the idle keep-alive connection just as the request arrived
      return;
    }
    jsonRes(res, 200, { n: hit.n });
  });
  const u = new Upstream(upCfg(up.origin));
  try {
    const r1 = await u.request({ method: 'POST', path: '/x', headers: {}, body: Buffer.from('a') });
    await readBody(r1.body);
    killReused = true;
    const r2 = await u.request({ method: 'POST', path: '/x', headers: {}, body: Buffer.from('b') });
    const b = await readBody(r2.body);
    assert.equal(r2.status, 200);
    assert.equal(r2.retried, true);
    assert.equal(u.stats.transportRetries, 1);
    assert.equal(JSON.parse(b.body.toString()).n, 3, 'hit 2 was the reset one, hit 3 the retry');
    assert.ok(up.hits[2]!.body.equals(Buffer.from('b')), 'the same bytes are repeated');
  } finally {
    u.close();
    await up.close();
  }
});

test('a reset on a fresh socket is not retried', async () => {
  const up = await fakeUpstream((hit) => void hit.socket.destroy());
  const u = new Upstream(upCfg(up.origin));
  try {
    await assert.rejects(u.request({ method: 'POST', path: '/x', headers: {}, body: Buffer.from('a') }), (e: unknown) => e instanceof UpstreamError && e.code === 'reset');
    assert.equal(up.hits.length, 1);
    assert.equal(u.stats.transportRetries, 0);
  } finally {
    u.close();
    await up.close();
  }
});

test('timeouts: headers (timeoutMs) and between chunks (idleTimeoutMs); abort', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.url === '/hang') return; // never answers
    if (hit.url === '/idle') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      return; // then silence
    }
    jsonRes(res, 200, {});
  });
  const u = new Upstream(upCfg(up.origin, { timeoutMs: 120, idleTimeoutMs: 120 }));
  try {
    const t0 = performance.now();
    await assert.rejects(u.request({ method: 'POST', path: '/hang', headers: {}, body: Buffer.alloc(0) }), (e: unknown) => e instanceof UpstreamError && e.code === 'timeout');
    assert.ok(performance.now() - t0 < 1000);
    const r = await u.request({ method: 'POST', path: '/idle', headers: {}, body: Buffer.alloc(0) });
    const err = await new Promise<unknown>((resolve) => {
      r.body.on('data', () => undefined);
      r.body.on('error', resolve);
    });
    assert.ok(err instanceof UpstreamError && err.code === 'idle');
    const ac = new AbortController();
    const p = u.request({ method: 'POST', path: '/hang', headers: {}, body: Buffer.alloc(0), signal: ac.signal });
    await sleep(20);
    const ta = performance.now();
    ac.abort();
    await assert.rejects(p, (e: unknown) => e instanceof UpstreamError && e.code === 'aborted');
    await sleep(30);
    const hung = up.hits.filter((h) => h.url === '/hang');
    assert.ok(hung[1]!.closedAt !== undefined && hung[1]!.closedAt - ta < 50, 'the upstream sees the abort');
  } finally {
    u.close();
    await up.close();
  }
});

test('probe: ok on any non-5xx answer, error on connection failure', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { data: [] }));
  const u = new Upstream(upCfg(up.origin));
  assert.deepEqual(await u.probe(), { ok: true, status: 200 });
  assert.equal(up.hits[0]!.url, '/v1/models');
  u.close();
  await up.close();
  const dead = new Upstream(upCfg(`http://127.0.0.1:${up.port}`));
  const p = await dead.probe();
  assert.equal(p.ok, false);
  assert.match(p.error ?? '', /ECONNREFUSED/);
  dead.close();
  assert.throws(() => new Upstream(upCfg('ftp://x')), /scheme/);
});

test('keepAliveIdleMs closes idle pooled sockets only: an active stream may be silent longer', async () => {
  const up = await fakeUpstream(async (_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    await sleep(350);
    res.end('data: 2\n\n');
  });
  const u = new Upstream(upCfg(up.origin, { keepAliveIdleMs: 100, idleTimeoutMs: 2000 }));
  try {
    const r = await u.request({ method: 'POST', path: '/s', headers: {}, body: Buffer.alloc(0) });
    const b = await readBody(r.body);
    assert.equal(b.complete, true);
    assert.equal(b.body.toString(), 'data: 1\n\ndata: 2\n\n');
  } finally {
    u.close();
    await up.close();
  }
});
