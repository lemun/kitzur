// How the proxy relays upstream rate limits (429), gateway errors (502/503) and streams that end early:
// status, Retry-After and the error body reach the client unchanged, nothing is learned from them, and no
// extra upstream request is made.
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine, passthroughEngine, result } from './fake-engine.js';
import { chatBody, chunk, fakeUpstream, jsonRes, request, startProxy, waitRecords, type ProxyFixture } from './harness.js';

const rateLimitBody = { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' } };

/** A streaming request that keeps the bytes received before the response ended or broke. */
function streamRequest(port: number, body: object): Promise<{ status: number; received: string; broken: boolean }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      let received = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { received += d; });
      res.on('error', () => {});
      res.on('close', () => resolve({ status: res.statusCode ?? 0, received, broken: !res.complete }));
    });
    req.end(payload);
  });
}

/** Nothing learned: no state entry and no engine update. */
function assertNothingLearned(f: ProxyFixture, engine: FakeEngine): void {
  assert.deepEqual(f.state.entries(), {});
  assert.equal(engine.setCalls.length, 0);
}

for (const stream of [false, true]) {
  test(`upstream 429 with Retry-After (${stream ? 'stream' : 'json'}): status, header and body relayed unchanged, no retry, nothing learned`, async (t) => {
    const body = JSON.stringify(rateLimitBody);
    const up = await fakeUpstream((_h, res) => jsonRes(res, 429, body, { 'retry-after': '17' }));
    const engine = passthroughEngine();
    const f = await startProxy(t, up, engine);
    try {
      const r = await request(f.port, { body: chatBody('hello', { stream }) });
      assert.equal(r.status, 429);
      assert.equal(r.headers['retry-after'], '17');
      assert.equal(r.text(), body);
      const [rec] = await waitRecords(f, 1);
      assert.equal(up.hits.length, 1, 'a rate limit is not retried');
      assert.equal(rec!.client_status, 429);
      assert.deepEqual(rec!.attempts.map((a) => [a.status, a.kind]), [[429, 'excluded']]);
      assertNothingLearned(f, engine);
    } finally { await f.close(); await up.close(); }
  });
}

test('upstream 429s on consecutive requests: one upstream call each, still nothing learned', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 429, rateLimitBody, { 'retry-after': '1' }));
  const engine = passthroughEngine();
  const f = await startProxy(t, up, engine);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await request(f.port, { body: chatBody(`hello ${i}`) })).status, 429);
    await waitRecords(f, 3);
    assert.equal(up.hits.length, 3);
    assertNothingLearned(f, engine);
  } finally { await f.close(); await up.close(); }
});

for (const status of [502, 503]) {
  for (const retryAfter of ['5', null]) {
    test(`upstream ${status} ${retryAfter ? 'with' : 'without'} Retry-After: relayed unchanged, one upstream call, nothing learned`, async (t) => {
      const body = JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'server_error' } });
      const up = await fakeUpstream((_h, res) => jsonRes(res, status, body, retryAfter ? { 'retry-after': retryAfter } : {}));
      const engine = passthroughEngine();
      const f = await startProxy(t, up, engine);
      try {
        const r = await request(f.port, { body: chatBody('hello', { stream: true }) });
        assert.equal(r.status, status);
        assert.equal(r.headers['retry-after'], retryAfter ?? undefined);
        assert.equal(r.text(), body);
        const [rec] = await waitRecords(f, 1);
        // a gateway error is retried (tightened) only near the hard limit; this request is far below it
        assert.equal(up.hits.length, 1);
        assert.deepEqual(rec!.attempts.map((a) => [a.status, a.kind]), [[status, 'gateway_error']]);
        assertNothingLearned(f, engine);
      } finally { await f.close(); await up.close(); }
    });
  }
}

for (const how of ['ends cleanly', 'drops the socket'] as const) {
  test(`upstream ${how} mid-stream after some chunks: the partial stream reaches the client, no second upstream request`, async (t) => {
    const logs: string[] = [];
    const sent = chunk('one') + chunk('two');
    const up = await fakeUpstream((h, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      if (how === 'ends cleanly') res.end(sent);
      else res.write(sent, () => setTimeout(() => h.socket.destroy(), 20));
    });
    const engine = passthroughEngine();
    const f = await startProxy(t, up, engine, { log: (_l, m) => logs.push(m) });
    try {
      const r = await streamRequest(f.port, chatBody('hello', { stream: true }));
      assert.equal(r.status, 200);
      assert.equal(r.received, sent, 'the chunks relayed before the end reach the client');
      // headers were already sent: a dropped upstream socket breaks the client stream instead of ending it cleanly
      assert.equal(r.broken, how === 'drops the socket');
      const [rec] = await waitRecords(f, 1);
      assert.equal(up.hits.length, 1, 'no retry once bytes were relayed');
      assert.equal(rec!.upstream_incomplete, true, JSON.stringify(rec));
      assert.equal((f.proxy.snapshot()['counters'] as Record<string, number>)['upstream_incomplete'], 1);
      assert.equal(rec!.client_status, 200);
      assertNothingLearned(f, engine);
    } finally { await f.close(); await up.close(); }
  });
}

test('upstream 429 on a compacted request still reports the compaction in the diagnostics headers', async (t) => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 429, rateLimitBody, { 'retry-after': '3' }));
  const engine = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true, {
    tokensIn: 50, tokensOut: 10, budget: { trigger: 61_000 },
  }));
  const f = await startProxy(t, up, engine);
  try {
    const r = await request(f.port, { body: chatBody('hello') });
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '3');
    assert.deepEqual(r.json(), rateLimitBody);
    assert.equal(r.headers['x-kitzur-action'], 'compact');
    assert.equal(r.headers['x-kitzur-tokens'], '50/10/61000');
    assert.equal(up.hits.length, 1);
    assert.equal(up.hits[0]!.json.messages.length, 1, 'the compacted request went upstream');
    const [rec] = await waitRecords(f, 1);
    assert.equal(rec!.compacted, true);
  } finally { await f.close(); await up.close(); }
});
