// Adversarial tests written by the regression verifier: they try to break the proxy's invariants with
// inputs earlier tests did not cover (unsafe integers on retries, shadow transparency, slow
// upstream headers vs the keep-alive idle timer, number formatting at every boundary, ...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine, result } from './fake-engine.js';
import {
  DONE, chunk, fakeUpstream, jsonRes, okCompletion, rawRequest, request, sleep, sseRes, startProxy, testConfig, waitRecords,
  type FakeUpstream, type ProxyFixture,
} from './harness.js';
import { Upstream, readBody } from '../../src/proxy/upstream.js';
import { CLIENT_RETRY_RUNS, contextLengthExceededBody, formatK, inStreamOverflowEvents } from '../../src/dialect/openai-chat.js';
import { overflowMessage, refuseMessage } from '../../src/proxy/recovery.js';

async function withProxy(up: FakeUpstream, engine: FakeEngine, fn: (f: ProxyFixture) => Promise<void>, opts: Parameters<typeof startProxy>[2] = {}): Promise<void> {
  const f = await startProxy(up, engine, opts);
  try {
    await fn(f);
  } finally {
    await f.close();
    await up.close();
  }
}

const VLLM_OVERFLOW = {
  error: {
    message: "This model's maximum context length is 90000 tokens. However, you requested 1000 output tokens and your prompt contains 95000 input tokens, for a total of 96000 tokens. Please reduce the length of the input prompt or the number of requested output tokens.",
    type: 'BadRequestError', param: null, code: 400,
  },
};

// ---------------------------------------------------------------- : unsafe integers are never re-serialized

test(': an unsafe-integer body is not rewritten on a retry after an upstream overflow', async () => {
  const up = await fakeUpstream((hit, res) => (hit.n === 1 ? jsonRes(res, 400, VLLM_OVERFLOW) : jsonRes(res, 200, okCompletion())));
  const engine = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true));
  await withProxy(up, engine, async (f) => {
    const raw = '{"model":"m1","seed":12345678901234567890,"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}],"max_tokens":1000}';
    const r = await request(f.port, { body: raw });
    for (const h of up.hits) assert.equal(h.body.toString(), raw, `upstream hit ${h.n} carries a re-serialized body`);
    assert.equal(r.status, 400, 'the overflow goes back translated (nothing smaller can be sent)');
    assert.equal(r.json().error.code, 'context_length_exceeded');
  });
});

test(': include_usage is not injected into an unsafe-integer body (that would re-serialize it)', async () => {
  const up = await fakeUpstream((_h, res) => sseRes(res, [chunk('hi', 'stop'), DONE]));
  const engine = new FakeEngine((req) => result(req, req, false));
  await withProxy(up, engine, async (f) => {
    const raw = '{"model":"m1","seed":12345678901234567890,"stream":true,"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}]}';
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits[0]!.body.toString(), raw, 'the upstream sees the client bytes');
  }, { config: { stream: { injectIncludeUsage: true } } });
});

test('shadow mode forwards the original bytes even for an unsafe-integer body that does not fit', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const engine = new FakeEngine((req) => result(req, req, false));
  await withProxy(up, engine, async (f) => {
    const raw = `{"model":"m1","seed":12345678901234567890,"messages":[{"role":"user","content":"${'x'.repeat(60_000)}"}],"max_tokens":1000}`;
    const r = await request(f.port, { body: raw });
    assert.equal(up.hits.length, 1, 'shadow mode never refuses by itself');
    assert.equal(up.hits[0]!.body.toString(), raw);
    assert.equal(r.status, 200);
  }, { config: { shadow: true, budget: { window: 8000, defaultMaxTokens: 1000 } } });
});

// ---------------------------------------------------------------- keep-alive idle close vs slow headers

test('keepAliveIdleMs never cuts a request that is waiting for its response headers (fresh and reused sockets)', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.url === '/slow') await sleep(450);
    jsonRes(res, 200, { ok: hit.url });
  });
  const u = new Upstream({ ...testConfig().upstream, origin: up.origin, keepAliveIdleMs: 100, timeoutMs: 5000, idleTimeoutMs: 5000 });
  try {
    const a = await u.request({ method: 'POST', path: '/slow', headers: {}, body: Buffer.from('{}') });
    assert.equal(a.status, 200);
    assert.equal((await readBody(a.body)).body.toString(), '{"ok":"/slow"}');
    const b = await u.request({ method: 'POST', path: '/fast', headers: {}, body: Buffer.from('{}') });
    await readBody(b.body);
    const c = await u.request({ method: 'POST', path: '/slow', headers: {}, body: Buffer.from('{}') });
    assert.equal(c.status, 200);
    assert.equal((await readBody(c.body)).body.toString(), '{"ok":"/slow"}');
  } finally {
    u.close();
    await up.close();
  }
});

// ---------------------------------------------------------------- generated numbers (§5.7)

test('formatK: every tenth up to 10M tokens avoids the retry runs, never rounds up past the value, is monotone', () => {
  let prev = -1;
  for (let tenths = 0; tenths <= 100_000; tenths++) {
    for (const n of [tenths * 100 - 50, tenths * 100, tenths * 100 + 49]) {
      if (n < 0) continue;
      const s = formatK(n);
      assert.ok(!CLIENT_RETRY_RUNS.test(s), `${n} -> ${s}`);
      const v = Math.round(Number(s.slice(0, -1)) * 10);
      assert.ok(v <= Math.round(n / 100), `${n} -> ${s} rounds up`);
      assert.ok(v >= prev, `${n} -> ${s} not monotone`);
      prev = v;
    }
  }
});

test('generated overflow bodies never match the retry pattern, for any numbers', () => {
  const r = (() => {
    let s = 7;
    return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  })();
  for (let i = 0; i < 20_000; i++) {
    const a = Math.floor(r() * 2_000_000);
    const w = Math.floor(r() * 1_100_000);
    const m1 = overflowMessage(i % 7 === 0 ? null : a, w);
    const m2 = refuseMessage(i % 11 === 0 ? NaN : a, w - a, w, Math.floor(r() * 200_000));
    for (const b of [contextLengthExceededBody(m1), contextLengthExceededBody(m2), inStreamOverflowEvents(m1), inStreamOverflowEvents(m2)]) {
      assert.ok(!CLIENT_RETRY_RUNS.test(b.toString()), b.toString());
    }
  }
});


// ---------------------------------------------------------------- batch 2: framing and routing probes

test('absolute-form request targets are refused: a client-chosen authority never reaches the upstream (§10)', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { data: [] }));
  const engine = new FakeEngine((req) => result(req, req, false));
  await withProxy(up, engine, async (f) => {
    for (const line of ['GET http://evil.example/v1/models HTTP/1.1', 'POST http://evil.example/v1/chat/completions HTTP/1.1']) {
      const out = await rawRequest(f.port, `${line}\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      assert.match(out.split('\r\n')[0]!, /^HTTP\/1\.1 400 /);
      assert.match(out, /invalid_request_target/);
    }
    assert.equal(up.hits.length, 0);
    const ok = await request(f.port, { method: 'GET', path: '/v1/models' });
    assert.equal(ok.status, 200, 'origin-form still passes through');
  });
});

test('a first-event error on a stream the upstream never ends is recovered within the 2 s tail bound', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.n === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ error: { message: "This model's maximum context length is 90000 tokens. However, your request has 95000 input tokens. Please reduce the length of the input messages.", code: 400 } })}\n\n`);
      return; // never ends
    }
    await sseRes(res, [chunk('ok', 'stop'), DONE]);
  });
  const engine = new FakeEngine((req, o) => (o.attempt === 1 ? result(req, req, false) : result(req, { ...req, messages: req.messages.slice(0, 1) }, true)));
  await withProxy(up, engine, async (f) => {
    const t0 = performance.now();
    const r = await request(f.port, { body: { model: 'm1', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(4000) }], max_tokens: 100, stream: true } });
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `recovered after ${Math.round(ms)} ms`);
    assert.equal(up.hits.length, 2);
    assert.equal(r.status, 200);
    assert.equal(r.text(), chunk('ok', 'stop') + DONE);
  });
});

test('hold timeout, then a first-event overflow, then a successful retry: one status line, comments, retry events', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.n === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-attempt': '1' });
      res.flushHeaders();
      res.write(': ping\n\n');
      await sleep(250);
      res.end(`data: ${JSON.stringify({ error: { message: "This model's maximum context length is 90000 tokens. However, your request has 95000 input tokens.", code: 400 } })}\n\n` + DONE);
      return;
    }
    await sseRes(res, [': p2\n\n', chunk('ok', 'stop'), DONE], { headers: { 'x-attempt': '2' } });
  });
  const engine = new FakeEngine((req, o) => (o.attempt === 1 ? result(req, req, false) : result(req, { ...req, messages: req.messages.slice(0, 1) }, true)));
  await withProxy(up, engine, async (f) => {
    const r = await request(f.port, { body: { model: 'm1', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(4000) }], max_tokens: 100, stream: true } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-attempt'], '1');
    assert.equal(r.text(), ': ping\n\n: p2\n\n' + chunk('ok', 'stop') + DONE);
  }, { config: { stream: { firstEventTimeoutMs: 100 } } });
});

// ---------------------------------------------------------------- learning at the last attempt

test('the last attempt\'s rejection still teaches: with maxRetries 0 a validated window is learned (and persisted)', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 400, {
    error: { message: "This model's maximum context length is 60000 tokens. However, your request has 400 input tokens. Please reduce the length of the input messages.", code: 400 },
  }));
  const engine = new FakeEngine((req) => result(req, req, false));
  await withProxy(up, engine, async (f) => {
    const body = { model: 'm1', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(1560) }], max_tokens: 100 };
    const r = await request(f.port, { body });
    assert.equal(r.status, 400);
    assert.equal(r.json().error.code, 'context_length_exceeded', 'translated ()');
    assert.equal(up.hits.length, 1, 'no retry with maxRetries 0');
    const { readLearnedState, learnedKey } = await import('../../src/proxy/state.js');
    const disk = readLearnedState(`${f.stateDir}/learned.json`).state.entries[learnedKey(up.origin, 'm1')];
    assert.equal(disk?.window, 60_000, 'the window is on disk');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.deepEqual(rec.attempts.map((a) => a.kind), ['overflow_prompt']);
  }, { config: { errors: { maxRetries: 0 } } });
});

test(' at the ladder level: every error kind on an unsafe-integer body sends exactly one (original) request', async () => {
  const bodies: Array<[number, unknown]> = [
    [400, VLLM_OVERFLOW],
    [400, { error: { message: 'max_tokens=40000 cannot be greater than max_model_len=90000.', code: 400 } }],
    [413, '<html><title>413 Request Entity Too Large</title></html>'],
    [502, '<html><title>502 Bad Gateway</title></html>'],
    [400, { error: { message: 'E_TEMPLATE: two consecutive user turns', code: 400 } }],
  ];
  for (const [status, b] of bodies) {
    const up = await fakeUpstream((hit, res) => (hit.n === 1 ? jsonRes(res, status, b) : jsonRes(res, 200, okCompletion())));
    const engine = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true));
    await withProxy(up, engine, async (f) => {
      const raw = `{"model":"m1","seed":-98765432109876543210,"messages":[{"role":"system","content":"s"},{"role":"user","content":"${'u'.repeat(20_000)}"}],"max_tokens":1000,"stream":true}`;
      await request(f.port, { body: raw });
      assert.equal(up.hits.length, 1, `status ${status}: retried`);
      assert.equal(up.hits[0]!.body.toString(), raw);
      assert.equal(engine.calls.length, 0);
    }, { config: { stream: { injectIncludeUsage: true } } });
  }
});

// ---------------------------------------------------------------- TLS against a real TLS server ()

test('TLS: a self-signed upstream fails verification (probe reports tlsError); caFile and insecureTls connect', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const https = (await import('node:https')).default;
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-tls-'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  if (gen.status !== 0) {
    t.skip('openssl is not available');
    return;
  }
  const srv = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    req.resume();
    req.on('end', () => jsonRes(res, 200, { data: [], url: req.url }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const origin = `https://127.0.0.1:${(srv.address() as { port: number }).port}/base`;
  try {
    const strict = new Upstream({ ...testConfig().upstream, origin });
    const p = await strict.probe();
    assert.equal(p.ok, false);
    assert.match(p.tlsError ?? '', /SELF_SIGNED|CERT/);
    await assert.rejects(strict.request({ method: 'POST', path: '/v1/chat/completions', headers: {}, body: Buffer.from('{}') }), (e: { code?: string }) => e.code === 'tls');
    strict.close();
    for (const o of [{ caFile: join(dir, 'cert.pem') }, { insecureTls: true }]) {
      const u = new Upstream({ ...testConfig().upstream, origin, ...o });
      assert.deepEqual(await u.probe(), { ok: true, status: 200 });
      const r1 = await u.request({ method: 'POST', path: '/v1/chat/completions', headers: {}, body: Buffer.from('{}') });
      assert.equal(JSON.parse((await readBody(r1.body)).body.toString()).url, '/base/v1/chat/completions');
      const r2 = await u.request({ method: 'POST', path: '/v1/x', headers: {}, body: Buffer.from('{}') });
      await readBody(r2.body);
      assert.equal(r2.reused, true, 'keep-alive over TLS');
      u.close();
    }
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------- SSE parser: differential against a spec reference

test('SSE parser agrees with a WHATWG-style reference on data/event fields for random streams and chunkings', async () => {
  const { SseParser } = await import('../../src/proxy/sse.js');
  let s = 12345;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  // reference: split into lines on CRLF | LF | CR, then apply the field rules; dispatch at blank lines
  const reference = (text: string): Array<{ data: string | null; event: string | null }> => {
    const out: Array<{ data: string | null; event: string | null }> = [];
    const lines = text.split(/\r\n|\n|\r/);
    lines.pop(); // the text always ends with a line end: the last piece is empty
    let data: string[] = [];
    let event: string | null = null;
    for (const line of lines) {
      if (line === '') {
        out.push({ data: data.length ? data.join('\n') : null, event });
        data = [];
        event = null;
        continue;
      }
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const f = i < 0 ? line : line.slice(0, i);
      let v = i < 0 ? '' : line.slice(i + 1);
      if (v.startsWith(' ')) v = v.slice(1);
      if (f === 'data') data.push(v);
      else if (f === 'event') event = v;
    }
    return out;
  };
  const EOLS = ['\n', '\r\n', '\r'];
  const LINES = ['data: {"a":1}', 'data:x', 'data:  two spaces', 'data', 'event: ping', 'event:', ': comment', ':', 'id: 7', 'retry: 10', 'data: é✓ multi', 'dat', 'DATA: upper', 'data: [DONE]'];
  for (let trial = 0; trial < 400; trial++) {
    let text = '';
    const nEv = 1 + Math.floor(rnd() * 6);
    for (let e = 0; e < nEv; e++) {
      const nl = Math.floor(rnd() * 4);
      for (let l = 0; l < nl; l++) text += pick(LINES) + pick(EOLS);
      text += pick(EOLS); // blank line: dispatch
    }
    // a CR line end followed by an LF-started blank line would read as CRLF: the reference splits the
    // same way, so both see the same line sequence
    const bytes = Buffer.from(text, 'utf8');
    const p = new SseParser();
    const got: Array<{ data: string | null; event: string | null }> = [];
    let i = 0;
    while (i < bytes.length) {
      const n = 1 + Math.floor(rnd() * 7);
      for (const ev of p.push(bytes.subarray(i, i + n))) got.push({ data: ev.data, event: ev.event });
      i += n;
    }
    const last = p.end(); // an unterminated trailing event is dispatched for end-of-body error checks only
    if (last && last.terminated) got.push({ data: last.data, event: last.event });
    assert.deepEqual(got, reference(text), JSON.stringify(text));
  }
});

// ---------------------------------------------------------------- host check edge cases (DNS rebinding)

test('host check: case, ports and IPv6 forms pass; look-alike names do not', async () => {
  const { hostAllowed } = await import('../../src/proxy/hostcheck.js');
  const allowed = testConfig().listen.allowedHosts;
  for (const h of ['127.0.0.1', '127.0.0.1:8270', 'LOCALHOST', 'localhost:1', '[::1]', '[::1]:8270', '::1', ' localhost ']) assert.equal(hostAllowed(h, allowed), true, h);
  for (const h of ['localhost.', '127.0.0.1.nip.io', 'evil@127.0.0.1', '127.0.0.2', 'localhost.evil.example', '[::2]', '0.0.0.0', '[::ffff:127.0.0.1]']) assert.equal(hostAllowed(h, allowed), false, h);
});

// ---------------------------------------------------------------- HTTP-level ladder fuzz (real server, fake upstream)

test('HTTP fuzz: client-visible invariants of the ladder over random server styles, stream timings and configs', async () => {
  const { shrinkingEngine } = await import('./fake-engine.js');
  const { bodyTokens, charCounter, usageChunk } = await import('./harness.js');
  const { ErrorClassifier } = await import('../../src/proxy/errors.js');
  const { requestBytes, requestMaxTokens } = await import('../../src/dialect/openai-chat.js');
  const { classifyStreamError } = await import('./opencode-port.js');
  type Style = 'vllm' | 'sse-first' | 'sse-late' | 'tgi' | 'gw502' | '413' | 'unknown400' | 'errfield';
  const STYLES: Style[] = ['vllm', 'sse-first', 'sse-late', 'tgi', 'gw502', '413', 'unknown400', 'errfield'];
  const OVERFLOW = new Set(['overflow_prompt', 'overflow_total', 'overflow_unknown', 'max_tokens_too_large']);
  let seed = 99;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const coverage: Record<string, number> = {};
  const cov = (k: string): void => void (coverage[k] = (coverage[k] ?? 0) + 1);
  const trials = Number(process.env['KITZUR_FUZZ_TRIALS'] ?? 70);
  for (let trial = 0; trial < trials; trial++) {
    const window = 6000;
    const style = STYLES[trial % STYLES.length]!;
    const maxRetries = Math.floor(rnd() * 3);
    const hold = rnd() < 0.8;
    const inject = rnd() < 0.4;
    const stream = style.startsWith('sse') || style === 'errfield' ? true : rnd() < 0.5;
    const cfgOver = { budget: { window, defaultMaxTokens: 500, planMaxTokens: 500 }, errors: { maxRetries }, stream: { holdFirstEvent: hold, firstEventTimeoutMs: 60, injectIncludeUsage: inject } };
    const cfg = testConfig(cfgOver);
    const counter = charCounter();
    const hidden = Math.floor(window * (0.4 + rnd() * 0.5));
    const byteLimit = 4000 + Math.floor(rnd() * 20_000);
    const successes = new Set<number>();
    const successBody = new Map<number, string>();
    const up = await fakeUpstream(async (hit, res) => {
      const j = hit.json ?? { messages: [] };
      const p = bodyTokens(j);
      const m = requestMaxTokens(j, 500);
      const tooBig = style === '413' ? requestBytes(j) > byteLimit : p + m > hidden;
      const inStreamErr = (msg: string) => `data: ${JSON.stringify({ error: { message: msg, type: 'BadRequestError', code: 400 } })}\n\n`;
      if (tooBig) {
        switch (style) {
          case 'vllm': return jsonRes(res, 400, { object: 'error', message: `This model's maximum context length is ${hidden} tokens. However, you requested ${p + m} tokens (${p} in the messages, ${m} in the completion).`, code: 400 });
          case 'tgi': return jsonRes(res, 422, { error: `Input validation error: \`inputs\` tokens + \`max_new_tokens\` must be <= ${hidden}. Given: ${p} \`inputs\` tokens and ${Math.min(m, 1024)} \`max_new_tokens\``, error_type: 'validation' });
          case 'gw502': return jsonRes(res, 502, '<html><title>502 Bad Gateway</title></html>', { 'content-type': 'text/html' });
          case '413': return jsonRes(res, 413, '<html><title>413 Request Entity Too Large</title></html>', { 'content-type': 'text/html' });
          case 'unknown400': return jsonRes(res, 400, { error: { message: 'E_UPSTREAM_7: request refused', code: 400 } });
          case 'sse-first': return sseRes(res, [': k\n\n', inStreamErr(`The input (${p} tokens) is longer than the model's context length (${hidden} tokens).`), DONE]);
          case 'sse-late': {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.flushHeaders();
            res.write(': k\n\n');
            await sleep(120); // past the 60 ms hold: the client's 200 is committed
            res.end(inStreamErr(`The input (${p} tokens) is longer than the model's context length (${hidden} tokens).`) + DONE);
            return;
          }
          case 'errfield': return sseRes(res, [`error: {"code":400,"message":"the request exceeds the available context size, try increasing it","type":"invalid_request_error"}\n\n`, DONE]);
        }
      }
      successes.add(hit.n);
      if (j.stream === true) {
        const pieces = [chunk('ok'), chunk('', 'stop')];
        if (j.stream_options?.include_usage === true) pieces.push(usageChunk(p));
        pieces.push(DONE);
        successBody.set(hit.n, pieces.join(''));
        return sseRes(res, pieces);
      }
      const b = JSON.stringify(okCompletion(p));
      successBody.set(hit.n, b);
      return jsonRes(res, 200, b);
    });
    const hist: ChatMessageLike[] = [{ role: 'system', content: 's'.repeat(40) }, { role: 'user', content: 'goal' }];
    const turns = 3 + Math.floor(rnd() * 8);
    for (let i = 0; i < turns; i++) hist.push({ role: 'assistant', content: 'a'.repeat(200 + Math.floor(rnd() * 3000)) }, { role: 'user', content: 'u'.repeat(50 + Math.floor(rnd() * 3000)) });
    const clientUsage = stream && rnd() < 0.3;
    const body = { model: 'm1', messages: hist, max_tokens: 500, stream, ...(clientUsage ? { stream_options: { include_usage: true } } : {}) };
    const raw = JSON.stringify(body);
    const engine = shrinkingEngine(cfg, counter);
    const f = await startProxy(up, engine, { counter, config: cfgOver });
    try {
      const r = await request(f.port, { body: raw });
      const tag = `trial ${trial} style ${style} retries ${maxRetries} hold ${hold} inject ${inject} clientUsage ${clientUsage} stream ${stream} hits ${up.hits.length} status ${r.status}`;
      // upstream side: attempt count, sizes, original bytes
      assert.ok(up.hits.length <= maxRetries + 2, `${tag}: too many upstream calls`);
      const size = (h: { json: any }) => ({ raw: bodyTokens(h.json), bytes: requestBytes(h.json) });
      const orig = size({ json: body });
      for (let i = 0; i < up.hits.length; i++) {
        const h = up.hits[i]!;
        const s = size(h);
        assert.ok(s.raw <= orig.raw && s.bytes <= orig.bytes, `${tag}: hit ${i + 1} larger than the client request`);
        if (i === 0) continue;
        const prevS = size(up.hits[i - 1]!);
        const sameAsPrev = JSON.stringify(h.json.messages) === JSON.stringify(up.hits[i - 1]!.json.messages) && h.json.max_tokens === up.hits[i - 1]!.json.max_tokens;
        if (sameAsPrev) { cov('usage-retry'); continue; } // the  include_usage retry repeats the attempt
        const isOrig = JSON.stringify(h.json.messages) === JSON.stringify(body.messages);
        if (isOrig) { cov('originalResend'); continue; } // the single  resend
        assert.ok(s.raw < prevS.raw || (s.raw === prevS.raw && requestMaxTokens(h.json, 500) < requestMaxTokens(up.hits[i - 1]!.json, 500)), `${tag}: hit ${i + 1} not smaller`);
        assert.ok(s.bytes <= prevS.bytes, `${tag}: hit ${i + 1} more bytes`);
      }
      // client side
      const lastHit = up.hits[up.hits.length - 1];
      if (lastHit && successes.has(lastHit.n)) {
        cov(up.hits.length > 1 ? 'recovered' : 'ok-first');
        assert.equal(r.status, 200, tag);
        const text = r.text();
        const want = successBody.get(lastHit.n)!;
        if (stream) {
          // comments may precede (held or committed before a retry); the data events are exactly the successful attempt's
          const data = text.split(/\n\n/).filter((e) => e.startsWith('data:')).join('\n\n');
          const wantData = want.split(/\n\n/).filter((e) => e.startsWith('data:') && (!inject || clientUsage || !e.includes('"choices":[]'))).join('\n\n');
          assert.equal(data, wantData, `${tag}: relayed events`);
        } else assert.equal(text, want, tag);
      } else {
        cov(`fail:${style}`);
        const classifier = new ErrorClassifier(cfg.errors);
        if (r.status !== 200) {
          const c = classifier.classify({ status: r.status, body: r.text(), inStream: false });
          const translated = c.ruleId === 'openai.code' && r.json().error?.message?.startsWith('kitzur:');
          assert.ok(translated || !OVERFLOW.has(c.kind), `${tag}: an overflow reached the client untranslated: ${r.text().slice(0, 200)}`);
        } else {
          // committed stream: the last data event is [DONE], the one before it the error the client sees
          const evs = r.text().split(/\n\n/).filter((e) => e.startsWith('data:') || e.startsWith('error:'));
          const errEv = evs.find((e) => /"error"|^error:/.test(e));
          assert.ok(errEv, `${tag}: a failed committed stream carries an error event: ${r.text().slice(0, 300)}`);
          const payload = errEv!.replace(/^(data|error): ?/, '');
          const c = classifier.classify({ status: 400, body: payload, inStream: true });
          if (OVERFLOW.has(c.kind)) {
            assert.equal(c.ruleId, 'openai.code', `${tag}: in-stream overflow not in the  shape`);
            assert.equal(classifyStreamError('opencode', payload), 'overflow', `${tag}: OpenCode does not see an overflow`);
          }
        }
      }
      const recs = await waitRecords(f, 1);
      assert.equal(recs.length, 1, `${tag}: one stats record`);
    } finally {
      await f.close();
      await up.close();
    }
  }
  for (const k of ['recovered', 'ok-first', 'fail:vllm', 'fail:sse-late']) assert.ok((coverage[k] ?? 0) > 0, `coverage ${k}: ${JSON.stringify(coverage)}`);
  if (process.env['KITZUR_TEST_VERBOSE']) console.log(coverage);
});

type ChatMessageLike = { role: string; content: string };
