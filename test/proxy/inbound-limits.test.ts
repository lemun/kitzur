// Inbound limits on the client side of the proxy: listen.maxRequestBytes (413 request_too_large) and
// listen.maxConcurrentRequests (503 server_busy), over real loopback sockets.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../../src/proxy/server.js';
import { StateStore } from '../../src/proxy/state.js';
import { StatsWriter } from '../../src/proxy/stats.js';
import { FakeEngine, result } from './fake-engine.js';
import { charCounter, fakeUpstream, jsonRes, request, startProxy, testConfig, type FakeUpstream, type ProxyFixture } from './harness.js';

const passthrough = (): FakeEngine => new FakeEngine((req) => result(req, req, false));

async function withProxy(t: TestContext, limits: { maxRequestBytes?: number; maxConcurrentRequests?: number }, fn: (f: ProxyFixture, up: FakeUpstream) => Promise<void>): Promise<void> {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { ok: true }));
  const f = await startProxy(t, up, passthrough(), { config: { listen: limits } });
  try {
    await fn(f, up);
  } finally {
    await f.close();
    await up.close();
  }
}

interface RawConn {
  socket: net.Socket;
  /** everything the proxy wrote, resolved when the proxy closes the connection */
  closed: Promise<string>;
  received(): string;
}

function connect(port: number, head: string): Promise<RawConn> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';
    const closed = new Promise<string>((r) => socket.once('close', () => r(out)));
    socket.on('data', (d) => (out += d.toString('latin1')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.on('error', () => undefined);
      socket.write(head);
      resolve({ socket, closed, received: () => out });
    });
  });
}

const head = (extra: string): string => `POST /v1/upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n${extra}\r\n`;

function errorJson(raw: string): { status: number; headers: string; json: any } {
  const at = raw.indexOf('\r\n\r\n');
  assert.ok(at > 0, `no complete response in ${JSON.stringify(raw)}`);
  return { status: Number(raw.slice(9, 12)), headers: raw.slice(0, at), json: JSON.parse(raw.slice(at + 4)) };
}

function assertOpenAiError(json: any, code: string, configKey: string): void {
  assert.equal(typeof json.error, 'object');
  assert.equal(json.error.code, code);
  assert.equal(typeof json.error.type, 'string');
  assert.equal(typeof json.error.message, 'string');
  assert.ok(json.error.message.includes(configKey), `message names ${configKey}: ${json.error.message}`);
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('a declared Content-Length above listen.maxRequestBytes gets 413 before any body byte is sent', { timeout: 5000 }, async (t) => {
  await withProxy(t, { maxRequestBytes: 16 }, async (f, up) => {
    const c = await connect(f.port, head('Content-Length: 17\r\n'));
    const r = errorJson(await c.closed);
    assert.equal(r.status, 413);
    assert.match(r.headers, /content-type: application\/json/i);
    assertOpenAiError(r.json, 'request_too_large', 'listen.maxRequestBytes');
    assert.equal(up.hits.length, 0);
  });
});

test('a chunked upload crossing listen.maxRequestBytes gets 413 and its connection is closed', { timeout: 5000 }, async (t) => {
  await withProxy(t, { maxRequestBytes: 16 }, async (f, up) => {
    const c = await connect(f.port, head('Transfer-Encoding: chunked\r\n'));
    c.socket.write('10\r\n' + 'x'.repeat(16) + '\r\n');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.received(), '', 'exactly the limit is still being read');
    c.socket.write('1\r\nx\r\n');
    const r = errorJson(await c.closed);
    assert.equal(r.status, 413);
    assert.match(r.headers, /connection: close/i);
    assertOpenAiError(r.json, 'request_too_large', 'listen.maxRequestBytes');
    assert.equal(up.hits.length, 0);
    assert.equal(f.proxy.active(), 0);
  });
});

test('a body of exactly listen.maxRequestBytes is accepted, declared or chunked', { timeout: 5000 }, async (t) => {
  await withProxy(t, { maxRequestBytes: 16 }, async (f, up) => {
    assert.equal((await request(f.port, { path: '/v1/upload', body: 'x'.repeat(16) })).status, 200);
    const c = await connect(f.port, head('Transfer-Encoding: chunked\r\nConnection: close\r\n'));
    c.socket.write('10\r\n' + 'y'.repeat(16) + '\r\n0\r\n\r\n');
    assert.match(await c.closed, /^HTTP\/1.1 200/);
    assert.deepEqual(up.hits.map((h) => h.body.toString()), ['x'.repeat(16), 'y'.repeat(16)]);
  });
});

test('listen.maxConcurrentRequests=1 answers a second request 503 server_busy while the first completes', { timeout: 5000 }, async (t) => {
  await withProxy(t, { maxConcurrentRequests: 1 }, async (f) => {
    const first = await connect(f.port, head('Content-Length: 4\r\nConnection: close\r\n') + 'ab');
    await until(() => f.proxy.active() === 1);
    const busy = await request(f.port, { path: '/v1/upload', body: '{}' });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers['retry-after'], '1');
    assertOpenAiError(busy.json(), 'server_busy', 'listen.maxConcurrentRequests');
    first.socket.write('cd');
    assert.match(await first.closed, /^HTTP\/1.1 200/);
    await until(() => f.proxy.active() === 0);
    assert.equal((await request(f.port, { path: '/v1/upload', body: '{}' })).status, 200);
    assert.equal(f.proxy.snapshot()['concurrency_rejected'], 1);
  });
});

test('a client aborting mid-upload releases its concurrency slot', { timeout: 5000 }, async (t) => {
  await withProxy(t, { maxConcurrentRequests: 1 }, async (f, up) => {
    for (let i = 0; i < 3; i++) {
      const c = await connect(f.port, head('Content-Length: 100\r\n') + 'partial');
      await until(() => f.proxy.active() === 1);
      c.socket.destroy();
      await until(() => f.proxy.active() === 0);
    }
    assert.equal((await request(f.port, { path: '/v1/upload', body: '{}' })).status, 200);
    assert.equal(up.hits.length, 1);
  });
});

test('a client that stops sending its body does not hold a slot forever', { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-inbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { ok: true }));
  const cfg = testConfig({ upstream: { origin: up.origin }, listen: { maxConcurrentRequests: 1 } });
  const proxy = createProxyServer(cfg, {
    engine: passthrough(), counter: charCounter(),
    state: new StateStore({ dir, configuredWindow: cfg.budget.window, counterId: 'test' }),
    stats: new StatsWriter(null),
  });
  // Node's request timeout (default 300 s) is the bound; shorten it, and its check interval, for the test.
  assert.ok(proxy.server.requestTimeout > 0 && Number.isFinite(proxy.server.requestTimeout), 'stalled uploads are bounded');
  proxy.server.requestTimeout = 300;
  proxy.server.headersTimeout = 300;
  (proxy.server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval = 50;
  const { port } = await proxy.listen();
  try {
    const stalled = await connect(port, head('Content-Length: 100\r\n') + 'partial');
    await until(() => proxy.active() === 1);
    await stalled.closed;
    await until(() => proxy.active() === 0);
    assert.equal((await request(port, { path: '/v1/upload', body: '{}' })).status, 200);
  } finally {
    await proxy.close(0);
    await up.close();
  }
});
