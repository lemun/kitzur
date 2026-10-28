import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, startProxy, request, chatBody, jsonRes } from './harness.js';
import { FakeEngine, result } from './fake-engine.js';

for (const mode of ['chat', 'shadow', 'passthrough'] as const) {
  test(`${mode}: oversized error keeps a bounded upstream prefix and truncation marker`, async () => {
    const up = await fakeUpstream((_hit, res) => jsonRes(res, 503, { error: 'x'.repeat(2 * 1024 * 1024) }));
    const f = await startProxy(up, new FakeEngine((req) => result(req, req, false)), { config: { shadow: mode === 'shadow' } });
    try {
      const r = await request(f.port, { path: mode === 'passthrough' ? '/other' : '/v1/chat/completions', body: chatBody() });
      assert.equal(r.status, 503);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
      assert.ok(r.body.length <= 64 * 1024, `error body must be bounded; got ${r.body.length}`);
      assert.match(r.text(), /"error":"x{20,}/);
      assert.match(r.text(), /upstream error body truncated/);
    } finally { await f.close(); await up.close(); }
  });
}

import { PassThrough } from 'node:stream';
import { readErrorBody } from '../../src/proxy/upstream.js';
test('reader: one oversized chunk is capped and destroyed', async () => {
  const stream = new PassThrough();
  const pending = readErrorBody(stream, 100, 64);
  stream.end(Buffer.alloc(1024));
  assert.ok((await pending).body.length <= 64);
});


for (const drip of [false, true]) {
  test(`reader: ${drip ? 'slow drip' : 'headers then silence'} hits absolute deadline`, async () => {
    const stream = new PassThrough();
    const start = performance.now();
    const pending = readErrorBody(stream, 80);
    const interval = drip ? setInterval(() => stream.write('x'), 10) : undefined;
    try {
      const r = await pending;
      assert.equal(r.complete, false);
      assert.equal(r.reason, 'timeout');
      assert.ok(performance.now() - start < 1000);
      assert.ok(stream.destroyed);
      for (const event of ['data', 'end', 'error', 'close']) assert.equal(stream.listenerCount(event), 0);
    } finally { clearInterval(interval); stream.destroy(); }
  });
}

test('reader: exact cap and normal body relay unchanged', async () => {
  for (const size of [0, 12, 64]) {
    const stream = new PassThrough();
    const pending = readErrorBody(stream, 100, 64);
    const bytes = Buffer.alloc(size, 'x');
    stream.end(bytes);
    const r = await pending;
    assert.equal(r.complete, true);
    assert.deepEqual(r.body, bytes);
    for (const event of ['data', 'end', 'error', 'close']) assert.equal(stream.listenerCount(event), 0);
  }
});

test('reader: client abort during read resolves and cleans up', async () => {
  const stream = new PassThrough();
  const pending = readErrorBody(stream, 1000);
  stream.write('prefix');
  stream.destroy(new Error('aborted by client'));
  const r = await pending;
  assert.equal(r.complete, false);
  assert.equal(r.reason, 'closed');
  assert.equal(r.body.toString(), 'prefix');
  for (const event of ['data', 'end', 'error', 'close']) assert.equal(stream.listenerCount(event), 0);
});

for (const mode of ['chat', 'shadow', 'passthrough'] as const) {
  test(`${mode}: normal 4xx/5xx bodies relay unchanged`, async () => {
    const body = '{"error":{"message":"denied"}}';
    const up = await fakeUpstream((_hit, res) => jsonRes(res, 403, body));
    const f = await startProxy(up, new FakeEngine((req) => result(req, req, false)), { config: { shadow: mode === 'shadow' } });
    try {
      for (const status of [403, 503]) {
        up.responder = (_hit, res) => jsonRes(res, status, body);
        const r = await request(f.port, { path: mode === 'passthrough' ? '/other' : '/v1/chat/completions', body: chatBody() });
        assert.equal(r.status, status);
        assert.equal(r.text(), body);
      }
    } finally { await f.close(); await up.close(); }
  });

  test(`${mode}: slow-drip error preserves status, returns generic JSON and warns`, async () => {
    const logs: string[] = [];
    const up = await fakeUpstream((_hit, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.flushHeaders();
      const timer = setInterval(() => res.write(' '), 20);
      res.once('close', () => clearInterval(timer));
    });
    const f = await startProxy(up, new FakeEngine((req) => result(req, req, false)), {
      config: { shadow: mode === 'shadow', upstream: { idleTimeoutMs: 1000 } },
      log: (level, message) => { if (level === 'warn') logs.push(message); },
    });
    try {
      const start = performance.now();
      const r = await request(f.port, { path: mode === 'passthrough' ? '/other' : '/v1/chat/completions', body: chatBody() });
      assert.equal(r.status, 503);
      assert.equal(r.headers['content-type'], 'application/json');
      assert.match(r.json().error.message, /truncated.*timeout/);
      assert.ok(performance.now() - start < 8000);
      assert.ok(logs.some((message) => message.includes('upstream error body cut: timeout')));
    } finally { await f.close(); await up.close(); }
  });
}
