// Header passthrough on POST /v1/chat/completions, where the body may be rewritten: client headers
// reach the upstream (content-length recomputed), upstream headers reach the client.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRequest } from '../../src/types.js';
import { DONE, charCounter, chatBody, chunk, fakeUpstream, jsonRes, okCompletion, request, sseRes, startProxy, testConfig, type FixtureOptions, type ProxyFixture, type Responder, type UpstreamHit } from './harness.js';
import { passthroughEngine, shrinkingEngine, type FakeEngine } from './fake-engine.js';

const CLIENT = {
  'x-session-id': 'ses_1', 'x-custom': 'c', accept: 'application/json', 'user-agent': 'ua/1', 'openai-organization': 'org_1',
  cookie: 'k=v', authorization: 'Bearer zzz', 'x-forwarded-for': '1.2.3.4',
};
const UP = { 'x-request-id': 'abc', 'x-ratelimit-remaining': '9', 'cache-control': 'no-store', 'x-dup': 'one', 'x-kitzur-action': 'spoofed', 'x-kitzur-tokens': 'spoofed' };

async function withProxy(t: TestContext, responder: Responder, engine: FakeEngine, fn: (f: ProxyFixture, hits: UpstreamHit[]) => Promise<void>, o?: FixtureOptions): Promise<void> {
  const up = await fakeUpstream(responder);
  const f = await startProxy(t, up, engine, o);
  try {
    await fn(f, up.hits);
  } finally {
    await f.close();
    await up.close();
  }
}

function assertForwarded(h: UpstreamHit): void {
  for (const [k, v] of Object.entries(CLIENT)) assert.equal(h.headers[k], v, k);
  const names = h.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n in CLIENT);
  assert.deepEqual(names, Object.keys(CLIENT), "the client's order");
  assert.equal(h.headers['accept-encoding'], 'identity');
  assert.equal(h.headers['content-length'], String(h.body.length));
}

test('passthrough chat: client headers reach the upstream, accept-encoding is identity, content-length is the forwarded body', (t) =>
  withProxy(t, (_h, res) => jsonRes(res, 200, okCompletion(), UP), passthroughEngine(), async (f, hits) => {
    const r = await request(f.port, { body: chatBody('hi'), headers: { ...CLIENT, 'accept-encoding': 'gzip, br' } });
    assert.equal(r.status, 200);
    assertForwarded(hits[0]!);
  }));

test('rewritten chat: the same headers are forwarded with the rewritten content-length; the client gets x-request-id', (t) => {
  const budget = { window: 4000, defaultMaxTokens: 500, planMaxTokens: 500 };
  const counter = charCounter();
  const msgs: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'goal' }];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'assistant', content: 'a'.repeat(1000) }, { role: 'user', content: 'u'.repeat(1000) });
  const raw = JSON.stringify({ model: 'm1', messages: msgs, max_tokens: 500 });
  return withProxy(t, (_h, res) => jsonRes(res, 200, okCompletion(), UP), shrinkingEngine(testConfig({ budget }), counter), async (f, hits) => {
    const r = await request(f.port, { body: raw, headers: CLIENT });
    assert.equal(r.status, 200);
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.body.length < Buffer.byteLength(raw), 'the body was rewritten');
    assertForwarded(hits[0]!);
    assert.equal(r.headers['x-request-id'], 'abc');
  }, { counter, config: { budget } });
});

for (const mode of ['json', 'sse'] as const) {
  test(`chat success (${mode}): upstream headers and repeated set-cookie reach the client; local x-kitzur-* win`, (t) =>
    withProxy(t, async (_h, res) => {
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      if (mode === 'json') return jsonRes(res, 200, okCompletion(), UP);
      await sseRes(res, [chunk('ok'), chunk('', 'stop'), DONE], { headers: UP });
    }, passthroughEngine(), async (f) => {
      const r = await request(f.port, { body: chatBody('hi', mode === 'sse' ? { stream: true } : {}) });
      assert.equal(r.status, 200);
      for (const k of ['x-request-id', 'x-ratelimit-remaining', 'cache-control', 'x-dup'] as const) assert.equal(r.headers[k], UP[k], k);
      assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
      assert.equal(r.headers['x-kitzur-action'], 'passthrough');
      assert.match(String(r.headers['x-kitzur-tokens']), /^\d+\/\d+\/\d+$/);
    }));
}

test('chat: headers named in the client Connection header do not reach the upstream', (t) =>
  withProxy(t, (_h, res) => jsonRes(res, 200, okCompletion()), passthroughEngine(), async (f, hits) => {
    const r = await request(f.port, { body: chatBody('hi'), headers: { connection: 'x-drop-me', 'x-drop-me': '1', 'x-keep': '1' } });
    assert.equal(r.status, 200);
    assert.equal(hits[0]!.headers['x-drop-me'], undefined);
    assert.equal(hits[0]!.headers['x-keep'], '1');
  }));
