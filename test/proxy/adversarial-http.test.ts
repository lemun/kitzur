// Adversarial HTTP tests (second adversary pass on the component): hostile or broken upstreams and
// clients that the fuzz, the benchmark matrix and the first adversarial batch did not reach. Each test
// pins a defect that was reproduced against the real proxy and then fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { FakeEngine, result } from './fake-engine.js';
import {
  DONE, chatBody, chunk, fakeUpstream, jsonRes, request, sseRes, startProxy, waitRecords,
  type FakeUpstream, type ProxyFixture,
} from './harness.js';
import { Upstream } from '../../src/proxy/upstream.js';
import { SseParser } from '../../src/proxy/sse.js';
import { hostAllowed } from '../../src/proxy/hostcheck.js';
import { CLIENT_RETRY_RUNS, formatK } from '../../src/dialect/openai-chat.js';
import { refuseMessage } from '../../src/proxy/recovery.js';

async function withProxy(up: FakeUpstream, engine: FakeEngine, fn: (f: ProxyFixture) => Promise<void>, opts: Parameters<typeof startProxy>[2] = {}): Promise<void> {
  const f = await startProxy(up, engine, opts);
  try {
    await fn(f);
  } finally {
    await f.close();
    await up.close();
  }
}

const passthrough = (): FakeEngine => new FakeEngine((req) => result(req, req, false));

/** A raw TCP "upstream" that answers every request with `reply` (latin1). */
async function rawUpstream(reply: string): Promise<{ origin: string; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
    let got = '';
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (got.includes('\r\n\r\n')) s.write(Buffer.from(reply, 'latin1'));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        srv.close(() => r());
      }),
  };
}

// ---------------------------------------------------------------- upstream protocol

test('an upstream 101 Switching Protocols fails the attempt at once (it used to hang past timeoutMs, forever)', { timeout: 30_000 }, async () => {
  const up = await rawUpstream('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nxx');
  const u = new Upstream({ origin: up.origin, timeoutMs: 60_000, idleTimeoutMs: 60_000, keepAliveIdleMs: 4000, headers: {}, caFile: null, insecureTls: false, maxBodyBytes: null });
  try {
    const t0 = performance.now();
    await assert.rejects(u.request({ method: 'POST', path: '/v1/chat/completions', headers: {}, body: Buffer.from('{}') }), /101/);
    assert.ok(performance.now() - t0 < 2000);
  } finally {
    u.close();
    await up.close();
  }
  // through the proxy: a 502 before any header, and nothing left in flight
  const up2 = await rawUpstream('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  const f = await startProxy(up2.origin, passthrough());
  try {
    const r = await request(f.port, { body: chatBody('hi', { stream: true }) });
    assert.equal(r.status, 502);
    assert.match(r.text(), /upstream_unavailable/);
    const p = await request(f.port, { method: 'GET', path: '/v1/models' });
    assert.equal(p.status, 502, 'pass-through too');
    assert.equal(f.proxy.active(), 0);
  } finally {
    await f.close();
    await up2.close();
  }
});

// ---------------------------------------------------------------- SSE parser

test('SSE parser is linear in the line length: a 32 MiB single-line event in 64 KiB chunks parses fast and exactly', () => {
  const big = Buffer.from('data: ' + 'x'.repeat(32 * 1024 * 1024) + '\r\n\r\n');
  const p = new SseParser();
  const t0 = performance.now();
  const evs = [];
  for (let i = 0; i < big.length; i += 65536) evs.push(...p.push(big.subarray(i, i + 65536)));
  const ms = performance.now() - t0;
  assert.equal(evs.length, 1);
  assert.ok(evs[0]!.raw.equals(big), 'raw bytes exact');
  assert.equal(evs[0]!.data!.length, 32 * 1024 * 1024);
  // the quadratic re-concatenation took ~4 s here; linear parsing takes well under 0.2 s
  assert.ok(ms < 2000, `${ms} ms`);
  // a CR at a chunk end still waits for the next byte after a deferred long line
  const q = new SseParser();
  const out = [...q.push(Buffer.from('data: a')), ...q.push(Buffer.from('bc')), ...q.push(Buffer.from('\r')), ...q.push(Buffer.from('\n\r')), ...q.push(Buffer.from('\ndata: z\n\n'))];
  assert.deepEqual(out.map((e) => [e.data, e.raw.toString()]), [['abc', 'data: abc\r\n\r\n'], ['z', 'data: z\n\n']]);
  assert.equal(q.pending().length, 0);
});

// ---------------------------------------------------------------- unchanged in-stream error relays

const ODD_ERR = 'data: {"error":{"message":"weird thing","code":500}}\n\n';

for (const shadow of [false, true]) {
  test(`an unrecoverable first-event error is relayed unchanged even when the stream runs past the 2 s / 1 MiB tail bound${shadow ? ' (shadow mode)' : ''}`, async () => {
    const big = [ODD_ERR, ...Array.from({ length: 40 }, (_, i) => chunk('z'.repeat(60_000) + i)), chunk('e', 'stop'), DONE];
    const slow = [ODD_ERR, chunk('a'), chunk('b'), chunk('c'), chunk('d', 'stop'), DONE];
    const up = await fakeUpstream((hit, res) => (hit.json.messages[1].content === 'big' ? sseRes(res, big) : sseRes(res, slow, { delayMs: 700 })));
    await withProxy(up, passthrough(), async (f) => {
      const r1 = await request(f.port, { body: chatBody('big', { stream: true }) });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.length, Buffer.byteLength(big.join('')));
      assert.equal(r1.text(), big.join(''), 'byte-identical past 1 MiB (it was cut at ~1.1 MB and ended cleanly)');
      const r2 = await request(f.port, { body: chatBody('slow', { stream: true }) });
      assert.equal(r2.text(), slow.join(''), 'byte-identical past 2 s (it was cut after the first two chunks)');
      assert.equal(up.hits.length, 2, 'no retry');
      await waitRecords(f, 2);
      assert.equal(f.proxy.active(), 0);
    }, { config: { shadow } });
  });
}

test('a recoverable first-event overflow on a stream that keeps going past the tail bound: the parked rest is dropped, only the retry reaches the client', async () => {
  const OVER = 'data: {"error":{"message":"This model\'s maximum context length is 90000 tokens. However, you requested 1000 output tokens and your prompt contains 95000 input tokens.","code":400}}\n\n';
  const up = await fakeUpstream((hit, res) =>
    hit.n === 1 ? sseRes(res, [OVER, ...Array.from({ length: 40 }, () => chunk('LEAK'.repeat(15_000)))], { end: false }) : sseRes(res, [chunk('retry', 'stop'), DONE]),
  );
  const engine = new FakeEngine((req, o) => (o.attempt === 1 ? result(req, req, false) : result(req, { ...req, messages: req.messages.slice(-1) }, true)));
  await withProxy(up, engine, async (f) => {
    const r = await request(f.port, { body: chatBody('x'.repeat(4000), { stream: true }) });
    assert.equal(r.status, 200);
    assert.equal(r.text(), chunk('retry', 'stop') + DONE);
    assert.equal(up.hits.length, 2);
    const t0 = performance.now();
    while (up.hits[0]!.closedAt === undefined && performance.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 10));
    assert.ok(up.hits[0]!.closedAt !== undefined, 'the first upstream response was closed');
  });
});

// ---------------------------------------------------------------- I7: internal failures fail open

const deepObject = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n);

test('I7: a pathologically deep tools schema (bytes() overflows the stack) forwards the original instead of a 500', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { choices: [] }));
  const engine = new FakeEngine(() => {
    throw new RangeError('Maximum call stack size exceeded');
  });
  await withProxy(up, engine, async (f) => {
    const raw = `{"model":"m1","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f","parameters":${deepObject(20_000)}}}]}`;
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200, r.text());
    assert.equal(up.hits.length, 1);
    assert.equal(up.hits[0]!.body.toString(), raw);
  });
});

test('I7: a ladder failure before any upstream call forwards the original bytes (fail open), recorded as reason internal', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { choices: [] }));
  const engine = new FakeEngine((req) => {
    const r = result(req, req, true);
    Object.defineProperty(r, 'request', { get: () => { throw new TypeError('broken engine result'); } });
    return r;
  });
  await withProxy(up, engine, async (f) => {
    const raw = '{"model":"m1", "messages":[{"role":"user","content":"hi"}]}';
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 1);
    assert.equal(up.hits[0]!.body.toString(), raw);
    const [rec] = await waitRecords(f, 1);
    assert.equal(rec!.reason, 'internal');
    assert.equal(rec!.action, 'passthrough');
  });
});

// ---------------------------------------------------------------- generated text

test('formatK stays a number for absurd values (max_tokens: 1e300 printed "1e+297.1.16e+282k")', () => {
  for (const n of [1e300, Number.MAX_VALUE, 1e21, 2 ** 60, Infinity]) {
    const s = formatK(n);
    assert.match(s, /^\d+\.\dk$/, `${n} -> ${s}`);
    assert.ok(!CLIENT_RETRY_RUNS.test(s), s);
  }
  assert.doesNotMatch(refuseMessage(50, 1000, 100_000, 1e300), /e\+/);
});

// ---------------------------------------------------------------- : include_usage rejections

const usageRejections: Record<string, (res: import('node:http').ServerResponse) => void | Promise<void>> = {
  'vLLM pydantic 422 extra_forbidden': (res) => jsonRes(res, 422, { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted' }] }),
  'OpenAI-style 400 unrecognized argument': (res) => jsonRes(res, 400, { error: { message: 'Unrecognized request argument supplied: stream_options' } }),
  'in-stream error on a 200': (res) => sseRes(res, ['data: {"error":{"message":"stream_options.include_usage is not supported","code":400}}\n\n', DONE]),
};

for (const [name, reject] of Object.entries(usageRejections)) {
  test(`: an injected include_usage rejected as "${name}" is retried once without it, and remembered`, async () => {
    const up = await fakeUpstream((hit, res) => (hit.json.stream_options ? reject(res) : sseRes(res, [chunk('ok', 'stop'), DONE])));
    await withProxy(up, passthrough(), async (f) => {
      const body = chatBody('hi', { stream: true });
      const r = await request(f.port, { body });
      assert.equal(r.status, 200, r.text());
      assert.equal(r.text(), chunk('ok', 'stop') + DONE);
      assert.equal(up.hits.length, 2);
      assert.equal(up.hits[1]!.body.toString(), JSON.stringify(body), 'the client\'s own bytes');
      const r2 = await request(f.port, { body: chatBody('again', { stream: true }) });
      assert.equal(r2.status, 200);
      assert.equal(up.hits.length, 3, 'not injected again');
      assert.equal(up.hits[2]!.json.stream_options, undefined);
    }, { config: { stream: { injectIncludeUsage: true } } });
  });
}

test(': a 429 or an unrelated 400 on an injected request is not mistaken for an include_usage rejection', async () => {
  const up = await fakeUpstream((hit, res) =>
    hit.json.messages[1].content === 'rl' ? jsonRes(res, 429, { error: { message: 'rate limit (stream_options ignored)' } }) : jsonRes(res, 400, { error: { message: 'bad role' } }),
  );
  await withProxy(up, passthrough(), async (f) => {
    assert.equal((await request(f.port, { body: chatBody('rl', { stream: true }) })).status, 429);
    assert.equal((await request(f.port, { body: chatBody('x', { stream: true }) })).status, 400);
    assert.equal(up.hits.length, 2);
  }, { config: { stream: { injectIncludeUsage: true } } });
});

// ---------------------------------------------------------------- host check

test('host check: only a port may follow the name (userinfo-like and junk suffixes are refused)', () => {
  const allowed = ['127.0.0.1', 'localhost', '[::1]', '::1'];
  for (const h of ['localhost:80@evil.example', 'localhost:abc', '127.0.0.1:1:2', '[::1]evil', '[::1]:80@evil.example', 'localhost:']) {
    assert.equal(hostAllowed(h, allowed), h === 'localhost:', h);
  }
  for (const h of ['localhost:8270', '[::1]:8270', '127.0.0.1', '::1']) assert.equal(hostAllowed(h, allowed), true, h);
});

test('first-event hold: a server streaming only comments ends the hold after HOLD_MAX bytes (bounded memory), bytes unchanged', { timeout: 30_000 }, async () => {
  const comments = Array.from({ length: 40 }, (_, i) => `: ${'p'.repeat(60_000)} ${i}\n\n`);
  const up = await fakeUpstream(async (_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of comments) res.write(c);
    await new Promise((r) => setTimeout(r, 1500));
    res.end(chunk('late', 'stop') + DONE);
  });
  await withProxy(up, passthrough(), async (f) => {
    const r = await request(f.port, { body: chatBody('hi', { stream: true }) });
    assert.equal(r.status, 200);
    assert.ok(r.headerMs < 1200, `headers after ${r.headerMs} ms: the hold ended at HOLD_MAX, not at the first event`);
    assert.equal(r.text(), comments.join('') + chunk('late', 'stop') + DONE);
  }, { config: { stream: { firstEventTimeoutMs: 15_000 } } });
});

test('a burst of small events larger than 64 KiB in one relay step never stalls the stream (corked writes lost their drain)', { timeout: 30_000 }, async () => {
  const burst = Array.from({ length: 5000 }, (_, i) => chunk(`token${i}${' '.repeat(100)}`)).join('');
  const up = await fakeUpstream(async (_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('first'));
    await new Promise((r) => setTimeout(r, 30));
    res.write(burst); // the upstream got ahead of the proxy (e.g. while the engine ran): ~1 MB at once
    await new Promise((r) => setTimeout(r, 30));
    res.end(chunk('', 'stop') + DONE);
  });
  await withProxy(up, passthrough(), async (f) => {
    const t0 = performance.now();
    const r = await request(f.port, { body: chatBody('hi', { stream: true }) });
    assert.ok(performance.now() - t0 < 5000);
    assert.equal(r.text(), chunk('first') + burst + chunk('', 'stop') + DONE);
    const [rec] = await waitRecords(f, 1);
    assert.equal(rec!.upstream_incomplete, undefined);
  }, { config: { upstream: { idleTimeoutMs: 60_000 } } });
});

test('§9 keep-alive: a reused socket reset after the server already sent response bytes is not retried (it was processed)', async () => {
  let requests = 0;
  const srv = net.createServer((s) => {
    let buf = '';
    s.on('error', () => undefined);
    s.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const cl = Number(/content-length: (\d+)/i.exec(buf.slice(0, i))?.[1] ?? 0);
        if (buf.length < i + 4 + cl) return;
        buf = buf.slice(i + 4 + cl);
        requests++;
        if (requests === 2) {
          s.write('HTTP/1.1 200 OK\r\nContent-'); // started answering, then dies
          setTimeout(() => s.resetAndDestroy(), 20);
        } else s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}');
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const u = new Upstream({ origin: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, timeoutMs: 5000, idleTimeoutMs: 5000, keepAliveIdleMs: 4000, headers: {}, caFile: null, insecureTls: false, maxBodyBytes: null });
  try {
    const r1 = await u.request({ method: 'POST', path: '/x', headers: {}, body: Buffer.from('{}') });
    r1.body.resume();
    await new Promise((r) => r1.body.on('end', r));
    await assert.rejects(u.request({ method: 'POST', path: '/x', headers: {}, body: Buffer.from('{}') }));
    assert.equal(requests, 2, 'not resent');
    assert.equal(u.stats.transportRetries, 0);
  } finally {
    u.close();
    srv.close();
  }
});
