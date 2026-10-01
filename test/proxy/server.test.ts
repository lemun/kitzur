import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatRequest } from '../../src/types.js';
import { parseFaults } from '../../src/proxy/server.js';
import { readLearnedState, learnedKey } from '../../src/proxy/state.js';
import { classifyHttpError, classifyStreamError, OC_RETRY_RUNS } from './opencode-port.js';
import { FakeEngine, passthroughEngine, result, shrinkingEngine } from './fake-engine.js';
import {
  DONE, bodyTokens, charCounter, chatBody, chunk, fakeUpstream, jsonRes, okCompletion, rawRequest, request, sleep, sseRes, startProxy,
  testConfig, usageChunk, waitRecords, type FakeUpstream, type ProxyFixture,
} from './harness.js';

async function withProxy(up: FakeUpstream, engine: FakeEngine, fn: (f: ProxyFixture) => Promise<void>, opts: Parameters<typeof startProxy>[2] = {}): Promise<void> {
  const f = await startProxy(up, engine, opts);
  try {
    await fn(f);
  } finally {
    await f.close();
    await up.close();
  }
}

// ---------------------------------------------------------------- relay byte-exactness

test('JSON: an unchanged request goes upstream as the original bytes; the response is relayed byte-exactly', async () => {
  const weird = '{ "model" : "m1",\n  "messages": [ {"role":"user", "content":"h\\u00e9llo \\/ ✓"} ], "max_tokens": 5 }';
  const respBody = '{"id":"x",  "choices":[{"message":{"content":"\\u00e9"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3}}  ';
  const up = await fakeUpstream((_h, res) => jsonRes(res, 201, respBody, { 'x-up': 'yes', 'keep-alive': 'timeout=5' }));
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: weird, headers: { authorization: 'Bearer secret', 'x-sim-step': '4' } });
    assert.equal(r.status, 201);
    assert.equal(r.text(), respBody);
    assert.equal(r.headers['x-up'], 'yes');
    assert.equal(r.headers['keep-alive'] === 'timeout=5', false, "the upstream's hop-by-hop header is not relayed");
    const hit = up.hits[0]!;
    assert.equal(hit.body.toString('utf8'), weird, 'original bytes');
    assert.equal(hit.headers['authorization'], 'Bearer secret');
    assert.equal(hit.headers['x-sim-step'], '4');
    assert.equal(hit.headers['accept-encoding'], 'identity');
    assert.equal(hit.url, '/v1/chat/completions');
  });
});

test('a changed request is serialized with JSON.stringify, key order kept', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const engine = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true));
  await withProxy(up, engine, async (f) => {
    const body = '{"zz":1,"model":"m1","messages":[{"role":"system","content":"s"},{"role":"user","content":"u","b":2,"a":1}],"aa":2}';
    await request(f.port, { body });
    assert.equal(up.hits[0]!.body.toString(), '{"zz":1,"model":"m1","messages":[{"role":"user","content":"u","b":2,"a":1}],"aa":2}');
  });
});

test('SSE: relayed byte-exactly across arbitrary chunking (CRLF, comments, events)', async () => {
  const pieces = [': hello\r\n\r\n', 'data: {"choices":[{"delta":{"role":"assistant","content":"hé', 'llo"},"finish_reason":null}]}\r\n', '\r\n', 'event: x\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', ': keep-alive\n\n', 'data: [DONE]\n\n'];
  const up = await fakeUpstream(async (_h, res) => sseRes(res, pieces, { delayMs: 5, headers: { 'x-accel-buffering': 'no' } }));
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('hi', { stream: true }) });
    assert.equal(r.status, 200);
    assert.equal(r.text(), pieces.join(''));
    assert.equal(r.headers['content-type'], 'text/event-stream');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.equal(rec.upstream_incomplete, undefined);
  });
});

// ---------------------------------------------------------------- first-event hold ()

test('hold: the client status line waits for the first data event; comments are flushed before it', async () => {
  const up = await fakeUpstream(async (_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    await sleep(150);
    res.write(': ping\n\n');
    await sleep(150);
    res.write(chunk('a'));
    res.end(chunk('', 'stop') + DONE);
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('hi', { stream: true }) });
    assert.ok(r.headerMs >= 280, `headers after the first event (${r.headerMs.toFixed(0)} ms)`);
    assert.ok(r.text().startsWith(': ping\n\n' + chunk('a')));
  });
});

test('hold: the timer starts at the upstream headers and commits after firstEventTimeoutMs', async () => {
  let headersAt = 0;
  const up = await fakeUpstream(async (_h, res) => {
    await sleep(200); // late headers: the client just waits (no invented status)
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    headersAt = performance.now();
    await sleep(700);
    res.end(chunk('a', 'stop') + DONE);
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const t0 = performance.now();
    const pending = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } });
      req.on('response', (res) => {
        resolve(performance.now());
        res.resume();
      });
      req.on('error', reject);
      req.end(JSON.stringify(chatBody('x', { stream: true })));
    });
    const got = await pending;
    assert.ok(got - t0 >= 380, 'not before upstream headers + timeout');
    assert.ok(got - headersAt >= 180 && got - headersAt < 600, `committed ${Math.round(got - headersAt)} ms after the upstream headers`);
  }, { config: { stream: { firstEventTimeoutMs: 200 } } });
});

test('late upstream error status (): the client gets the real HTTP status, not an invented 200', async () => {
  const up = await fakeUpstream(async (_h, res) => {
    await sleep(250);
    jsonRes(res, 429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: '429' } });
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x', { stream: true }) });
    assert.equal(r.status, 429);
    assert.equal(up.hits.length, 1, 'excluded: returned unchanged, no retry');
    assert.equal(r.json().error.message, 'Rate limit exceeded');
  }, { config: { stream: { firstEventTimeoutMs: 100 } } });
});

// ---------------------------------------------------------------- in-stream errors

const SSE_OVERFLOW = (prompt: number, window: number): string =>
  `data: ${JSON.stringify({ error: { object: 'error', message: `The input (${prompt} tokens) is longer than the model's context length (${window} tokens).`, type: 'BadRequestError', param: null, code: 400 } })}\n\n`;

test('a first-event in-stream overflow is recovered: the client sees only the retry, on a 200', async () => {
  const cfg = testConfig({ budget: { window: 4000, defaultMaxTokens: 500, planMaxTokens: 500 } });
  const counter = charCounter();
  const up = await fakeUpstream(async (hit, res) => {
    const p = bodyTokens(hit.json);
    if (p > 2000) await sseRes(res, [': ping\n\n', SSE_OVERFLOW(p, 2500), DONE]);
    else await sseRes(res, [chunk('ok'), chunk('', 'stop'), DONE]);
  });
  const history: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'goal' }];
  for (let i = 0; i < 8; i++) history.push({ role: 'assistant', content: 'a'.repeat(1000) }, { role: 'user', content: 'u'.repeat(1000) });
  await withProxy(up, shrinkingEngine(cfg, counter), async (f) => {
    const r = await request(f.port, { body: { model: 'm1', messages: history, max_tokens: 500, stream: true } });
    assert.equal(r.status, 200);
    assert.equal(r.text(), chunk('ok') + chunk('', 'stop') + DONE, 'only the retry: nothing of the failed attempt (its held comment included)');
    assert.equal(up.hits.length, 2);
    const e = f.state.entry(learnedKey(up.origin, 'm1'));
    assert.equal(e.window, 2500, 'learned from the in-stream body');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.deepEqual(rec.attempts.map((a) => [a.kind, a.inStream]), [['overflow_prompt', true], ['ok', false]]);
  }, { counter, config: { budget: { window: 4000, defaultMaxTokens: 500, planMaxTokens: 500 } } });
});

test('an unterminated first-event error at the end of the body is still caught (not an empty 200)', async () => {
  const errEv = `data: ${JSON.stringify({ error: { message: 'Internal failure', type: 'InternalServerError', code: 500 } })}`;
  const up = await fakeUpstream(async (_h, res) => sseRes(res, [errEv]));
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x', { stream: true }) });
    assert.equal(r.status, 200);
    assert.equal(r.text(), errEv, 'relayed unchanged');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.deepEqual([rec.attempts[0]!.kind, rec.attempts[0]!.inStream, rec.attempts[0]!.status], ['unmatched', true, 500]);
  });
});

test('an unrecoverable in-stream error that is not an overflow is relayed unchanged', async () => {
  const errEv = `data: ${JSON.stringify({ error: { message: 'Internal failure', type: 'InternalServerError', code: 500 } })}\n\n`;
  const up = await fakeUpstream(async (_h, res) => sseRes(res, [': c\n\n', errEv, DONE]));
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x', { stream: true }) });
    assert.equal(r.status, 200);
    assert.equal(r.text(), ': c\n\n' + errEv + DONE, 'byte-identical to what the upstream sent');
    assert.equal(up.hits.length, 1);
  });
});

test('after a committed 200, a failed overflow recovery is reported in the  shape both clients recognise', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    await sleep(250); // past the hold timeout: the client's 200 is committed
    res.end(SSE_OVERFLOW(bodyTokens(hit.json), 60) + DONE);
  });
  // the engine cannot shrink anything: recovery fails after learning
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x', { stream: true }) });
    assert.equal(r.status, 200);
    const events = r.text().split('\n\n').filter(Boolean);
    assert.equal(events.length, 2);
    assert.equal(events[1], 'data: [DONE]');
    for (const c of ['opencode', 'kilo'] as const) assert.equal(classifyStreamError(c, events[0]!.slice(6)), 'overflow');
    assert.ok(!OC_RETRY_RUNS.test(r.text()));
  }, { config: { stream: { firstEventTimeoutMs: 100 } } });
});

// ---------------------------------------------------------------- include_usage (§9, )

test('include_usage: injected only for stream:true, the usage chunk is stripped, the tap still sees it', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.json.stream) {
      const pieces = [chunk('a'), chunk('', 'stop')];
      if (hit.json.stream_options?.include_usage) pieces.push(usageChunk(4321));
      await sseRes(res, [...pieces, DONE]);
    } else jsonRes(res, 200, okCompletion(99));
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const r1 = await request(f.port, { body: chatBody('x', { stream: true }) });
    assert.equal(up.hits[0]!.json.stream_options.include_usage, true, 'injected');
    assert.ok(!r1.text().includes('"choices":[]'), 'stripped');
    assert.equal(r1.text(), chunk('a') + chunk('', 'stop') + DONE);
    const r2 = await request(f.port, { body: chatBody('x', { stream: true, stream_options: { include_usage: true } }) });
    assert.ok(r2.text().includes(usageChunk(4321)), 'the client asked: not stripped');
    await request(f.port, { body: chatBody('x', { stream: false }) });
    assert.equal(up.hits[2]!.json.stream_options, undefined, 'never on stream:false (vLLM rejects it)');
    const recs = await waitRecords(f, 3);
    assert.equal(recs[0]!.usage?.prompt_tokens, 4321);
    assert.equal(recs[0]!.usage_injected, true);
    assert.equal(recs[1]!.usage_injected, undefined);
  }, { config: { stream: { injectIncludeUsage: true } } });
});

test(': a stream_options rejection of an injected include_usage is retried once without it, and remembered', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.json.stream_options) return jsonRes(res, 400, { error: { message: 'Stream options can only be defined when `stream=True`.', type: 'BadRequestError', param: 'stream_options', code: 400 } });
    await sseRes(res, [chunk('a', 'stop'), DONE]);
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const raw = JSON.stringify(chatBody('x', { stream: true }));
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    assert.equal(up.hits[1]!.body.toString(), raw, 'the retry is the original again');
    assert.equal(f.state.entry(learnedKey(up.origin, 'm1')).includeUsageRejected, true);
    await request(f.port, { body: raw });
    assert.equal(up.hits.length, 3, 'no injection any more: one request');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.equal(rec.attempts.length, 2);
    assert.equal((f.proxy.snapshot()['counters'] as Record<string, number>)['include_usage_retries'], 1);
  }, { config: { stream: { injectIncludeUsage: true } } });
});

// ---------------------------------------------------------------- abort ()

test('client disconnect aborts the upstream within 50 ms (mid-stream and before headers)', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.json.messages[1].content === 'before') return; // never answers
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('a'));
    // keeps streaming slowly
    for (let i = 0; i < 100 && !res.destroyed; i++) {
      await sleep(20);
      if (!res.destroyed) res.write(': k\n\n');
    }
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    for (const mode of ['mid', 'before']) {
      const n0 = up.hits.length;
      const t = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } });
        req.on('error', () => undefined);
        req.on('response', (res) => {
          res.once('data', () => {
            const at = performance.now();
            req.destroy();
            resolve(at);
          });
        });
        req.end(JSON.stringify(chatBody(mode, { stream: true })));
        if (mode === 'before') {
          setTimeout(() => {
            const at = performance.now();
            req.destroy();
            resolve(at);
          }, 100);
        }
        void reject;
      });
      await sleep(80);
      const hit = up.hits[n0]!;
      assert.ok(hit.closedAt !== undefined, `${mode}: upstream request closed`);
      assert.ok(hit.closedAt! - t < 50, `${mode}: aborted after ${(hit.closedAt! - t).toFixed(1)} ms`);
    }
    const recs = await waitRecords(f, 2);
    assert.equal(recs.length, 2, 'aborted requests still get a stats record');
  });
});

// ---------------------------------------------------------------- the ladder end to end

test('ladder: vLLM overflow teaches the window (persisted before the retry); the retry is strictly smaller; the next request plans with it', async () => {
  const counter = charCounter();
  const cfgOver = { budget: { window: 10_000, defaultMaxTokens: 1000, planMaxTokens: 1000 } };
  const cfg = testConfig(cfgOver);
  const LIMIT = 7000; // the server's real window, below the configured 10k
  let learnedAtRetry: number | null | undefined;
  let stateDir = '';
  const up = await fakeUpstream((hit, res) => {
    const p = bodyTokens(hit.json);
    const M = hit.json.max_tokens;
    if (hit.n === 2) learnedAtRetry = readLearnedState(join(stateDir, 'learned.json')).state.entries[learnedKey(up.origin, 'm1')]?.window;
    if (p + M > LIMIT) {
      return jsonRes(res, 400, { object: 'error', message: `This model's maximum context length is ${LIMIT} tokens. However, you requested ${p + M} tokens (${p} in the messages, ${M} in the completion). Please reduce the length of the messages or completion.`, type: 'BadRequestError', param: null, code: 400 });
    }
    jsonRes(res, 200, okCompletion(p));
  });
  const msgs: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'goal' }];
  for (let i = 0; i < 12; i++) msgs.push({ role: 'assistant', content: 'a'.repeat(2000) }, { role: 'user', content: 'u'.repeat(800) });
  const engine = shrinkingEngine(cfg, counter);
  await withProxy(up, engine, async (f) => {
    stateDir = f.stateDir;
    const raw = JSON.stringify({ model: 'm1', messages: msgs, max_tokens: 1000 });
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    assert.equal(learnedAtRetry, LIMIT, 'on disk before the retry was sent');
    assert.notEqual(up.hits[1]!.body.toString(), raw);
    assert.ok(bodyTokens(up.hits[1]!.json) < bodyTokens(up.hits[0]!.json));
    assert.equal(engine.calls[1]!.opts.attempt, 2);
    assert.equal(engine.calls[1]!.opts.learned?.window, LIMIT);
    const rec = (await waitRecords(f, 1))[0]!;
    assert.equal(rec.attempts[0]!.kind, 'overflow_total');
    assert.ok(rec.attempts[1]!.raw < rec.attempts[0]!.raw);
    // next request (appended history): planned with the learned window, one attempt
    const r2 = await request(f.port, { body: { model: 'm1', messages: [...msgs, { role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }], max_tokens: 1000 } });
    assert.equal(r2.status, 200);
    assert.equal(up.hits.length, 3);
    assert.equal(engine.learnedMap.get(learnedKey(up.origin, 'm1'))?.window, LIMIT, 'engine.setLearned was called');
  }, { counter, config: cfgOver });
});

test('ladder: at most maxRetries + 1 upstream calls; a failed overflow recovery is translated (TGI 422)', async () => {
  const counter = charCounter();
  const up = await fakeUpstream((hit, res) => {
    const p = bodyTokens(hit.json);
    jsonRes(res, 422, { error_type: 'validation', error: `Input validation error: \`inputs\` tokens + \`max_new_tokens\` must be <= 60000. Given: ${p} \`inputs\` tokens and 1024 \`max_new_tokens\`` });
  });
  // an engine that shrinks by one message per call, always strictly smaller
  const engine = new FakeEngine((req, o) => (o.attempt === 1 ? result(req, req, false) : result(req, { ...req, messages: req.messages.slice(0, Math.max(1, req.messages.length - o.attempt)) }, true)));
  await withProxy(up, engine, async (f) => {
    const body = chatBody('x', { messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i} `.repeat(50) })) });
    const r = await request(f.port, { body });
    assert.equal(up.hits.length, 3, 'maxRetries 2 -> 3 upstream calls');
    assert.equal(r.status, 400);
    assert.equal(r.json().error.code, 'context_length_exceeded');
    for (const c of ['opencode', 'kilo'] as const) assert.equal(classifyHttpError(c, r.status, r.text()).overflow, true);
    assert.ok(!OC_RETRY_RUNS.test(r.text()));
    const sizes = up.hits.map((h) => h.body.length);
    assert.ok(sizes[1]! < sizes[0]! && sizes[2]! < sizes[1]!);
  }, { counter });
});

test('ladder: max_tokens_too_large keeps the prompt and lowers max_tokens', async () => {
  const up = await fakeUpstream((hit, res) => {
    const M = hit.json.max_tokens;
    if (M > 9000) return jsonRes(res, 400, { error: { message: `max_tokens=${M} cannot be greater than max_model_len=9000. Please request fewer output tokens.`, type: 'BadRequestError', code: 400 } });
    if (bodyTokens(hit.json) + M > 9000) return jsonRes(res, 400, { error: { message: 'unexpected', code: 400 } });
    jsonRes(res, 200, okCompletion());
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x', { max_tokens: 12_000 }) });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    assert.deepEqual(up.hits[1]!.json.messages, up.hits[0]!.json.messages, 'same prompt');
    const e = f.state.entry(learnedKey(up.origin, 'm1'));
    assert.equal(up.hits[1]!.json.max_tokens, 9000 - 512 - bodyTokens(up.hits[0]!.json), 'M = W - margin - tighten - ceil(raw * correction)');
    assert.equal(e.window, 9000);
  }, { config: { budget: { window: 10_000, defaultMaxTokens: 1000, planMaxTokens: 1000, maxTokensClamp: { enabled: false, floorTokens: 100 } } } });
});

test('ladder: gateway 502 near the budget gets one tightened retry; far below it is returned unchanged', async () => {
  const counter = charCounter();
  const cfgOver = { budget: { window: 10_000, defaultMaxTokens: 1000, planMaxTokens: 1000 } };
  const cfg = testConfig(cfgOver);
  let threshold = Infinity;
  const up = await fakeUpstream((hit, res) => {
    if (bodyTokens(hit.json) > threshold) return jsonRes(res, 502, '<html><title>502 Bad Gateway</title></html>', { 'content-type': 'text/html' });
    jsonRes(res, 200, okCompletion());
  });
  const engine = shrinkingEngine(cfg, counter);
  await withProxy(up, engine, async (f) => {
    // hard = min(budget, clientPoint - allowance) = min(8488, 9000 - 500) = 8488; near = 0.9 * hard = 7639
    const near: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'g' }];
    for (let i = 0; i < 9; i++) near.push({ role: 'assistant', content: 'a'.repeat(3500) }, { role: 'user', content: 'u' });
    const raw0 = bodyTokens({ messages: near });
    assert.ok(raw0 >= 0.9 * 8488 && raw0 <= 8488, `near the budget (${raw0})`);
    threshold = raw0 - 100;
    const r = await request(f.port, { body: { model: 'm1', messages: near, max_tokens: 1000 } });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    assert.ok(engine.calls[1]!.opts.extraTighten! > 0, 'request-local extra tighten');
    const e = f.state.entry(learnedKey(up.origin, 'm1'));
    assert.equal(e.tighten, 0, 'not persisted after one chain');
    assert.equal(e.pendingTighten.length, 1);
    // a small request that still gets a 502: unchanged, no retry
    up.responder = (_h, res) => jsonRes(res, 502, '<html><title>502 Bad Gateway</title></html>', { 'content-type': 'text/html' });
    const n0 = up.hits.length;
    const r2 = await request(f.port, { body: chatBody('small') });
    assert.equal(r2.status, 502);
    assert.equal(r2.text(), '<html><title>502 Bad Gateway</title></html>', 'never translated (OpenCode retries a 502)');
    assert.equal(up.hits.length - n0, 1);
  }, { counter, config: cfgOver });
});

test('ladder: a 413 teaches maxBodyBytes and the retry is smaller in bytes; mandatory images alone -> 413 unchanged', async () => {
  const counter = charCounter();
  const cfgOver = { budget: { window: 100_000 } };
  const cfg = testConfig(cfgOver);
  let LIMIT = Infinity;
  const up = await fakeUpstream((hit, res) => {
    if (hit.body.length > LIMIT) return jsonRes(res, 413, '<html><title>413 Request Entity Too Large</title></html>', { 'content-type': 'text/html' });
    jsonRes(res, 200, okCompletion());
  });
  const engine = shrinkingEngine(cfg, counter);
  await withProxy(up, engine, async (f) => {
    const msgs: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'g' }];
    for (let i = 0; i < 10; i++) msgs.push({ role: 'assistant', content: 'a'.repeat(4000) }, { role: 'user', content: 'u' });
    const body = { model: 'm1', messages: msgs, max_tokens: 1000 };
    LIMIT = Math.floor(0.95 * Buffer.byteLength(JSON.stringify(body)));
    const r = await request(f.port, { body });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    const e = f.state.entry(learnedKey(up.origin, 'm1'));
    assert.ok(e.maxBodyBytes !== null && e.maxBodyBytes < up.hits[0]!.body.length);
    assert.equal(e.tighten, 0, 'a 413 never touches tighten');
    assert.ok(up.hits[1]!.body.length < up.hits[0]!.body.length);
  }, { counter, config: cfgOver });
  // the newest unit carries a huge image: no re-plan can fit, the 413 goes back unchanged (OpenCode strips media on a 413)
  const up2 = await fakeUpstream((hit, res) => {
    if (hit.body.length > 40_000) return jsonRes(res, 413, '<html><title>413 Request Entity Too Large</title></html>', { 'content-type': 'text/html' });
    jsonRes(res, 200, okCompletion());
  });
  await withProxy(up2, passthroughEngine(), async (f) => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(60_000) } };
    const withImg = [{ role: 'user', content: 'g' }, { role: 'assistant', content: 'look' }, { role: 'user', content: [{ type: 'text', text: 'see' }, img] }];
    const r2 = await request(f.port, { body: { model: 'm1', messages: withImg, max_tokens: 1000 } });
    assert.equal(r2.status, 413);
    assert.equal(r2.text(), '<html><title>413 Request Entity Too Large</title></html>');
    assert.equal(up2.hits.length, 1, 'no retry');
    assert.ok((f.state.entry(learnedKey(up2.origin, 'm1')).maxBodyBytes ?? 0) > 0);
  });
});

test(': an unmatched 400 on a rewritten request resends the original once if it fits; else a translated 400', async () => {
  const up = await fakeUpstream((hit, res) => {
    if (hit.json.messages.length === 1) return jsonRes(res, 400, 'E_UPSTREAM_7: request refused', { 'content-type': 'text/plain' });
    jsonRes(res, 200, okCompletion());
  });
  const rewrite = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true));
  await withProxy(up, rewrite, async (f) => {
    const raw = JSON.stringify(chatBody('fits'));
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits.length, 2);
    assert.equal(up.hits[1]!.body.toString(), raw, 'the original bytes');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.equal(rec.upstream_rejected_rewrite, true);
    assert.equal(rec.original_resent, true);
    assert.deepEqual(f.proxy.snapshot()['upstream_rejected_rewrite'], { 'unmatched:400': 1 });
    // an original that does not fit the server: translated, never resent
    const n0 = up.hits.length;
    const big = chatBody('x'.repeat(50_000));
    const r2 = await request(f.port, { body: big });
    assert.equal(up.hits.length - n0, 1);
    assert.equal(r2.status, 400);
    assert.equal(r2.json().error.code, 'context_length_exceeded');
  }, { config: { budget: { window: 10_000, defaultMaxTokens: 1000 } } });
  // an unmatched error on an unchanged request reaches the client unchanged, in one attempt
  const up2 = await fakeUpstream((_h, res) => jsonRes(res, 400, 'E_UPSTREAM_7: request refused', { 'content-type': 'text/plain' }));
  await withProxy(up2, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x') });
    assert.deepEqual([r.status, r.text(), up2.hits.length], [400, 'E_UPSTREAM_7: request refused', 1]);
  });
});

// ---------------------------------------------------------------- guard outcomes, faults, unsafe integers, shadow

test('guard_reject and impossible return the engine error without an upstream call; guard_fallback forwards the original', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const errBody = { error: { message: 'kitzur: the system prompt and tool definitions alone need about 26.0k tokens', type: 'invalid_request_error', param: null, code: 'kitzur_fixed_prompt_too_large' } };
  let action: 'impossible' | 'guard_reject' | 'guard_fallback' = 'impossible';
  const engine = new FakeEngine((req) => result(req, action === 'guard_fallback' ? req : null, false, { action, error: action === 'guard_fallback' ? undefined : { status: 400, body: errBody }, ...(action === 'impossible' ? {} : { guard: 'guard:pairing' }) }));
  await withProxy(up, engine, async (f) => {
    for (action of ['impossible', 'guard_reject'] as const) {
      const r = await request(f.port, { body: chatBody('x') });
      assert.equal(r.status, 400);
      assert.deepEqual(r.json(), errBody);
    }
    assert.equal(up.hits.length, 0);
    action = 'guard_fallback';
    const raw = '{"model":"m1",   "messages":[{"role":"user","content":"x"}]}';
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits[0]!.body.toString(), raw);
    const recs = await waitRecords(f, 3);
    assert.deepEqual(recs.map((x) => x.action), ['impossible', 'guard_reject', 'guard_fallback']);
    assert.deepEqual(recs.map((x) => [x.messages_in, x.messages_out]), [[2, 0], [2, 0], [1, 1]], 'nothing forwarded / the original forwarded');
    assert.equal(recs[2]!.guard, 'guard:pairing');
    assert.deepEqual(f.proxy.snapshot()['guard'], { 'guard:pairing': 2 });
  });
});

test('KITZUR_TEST_FAULTS engine-throw: the original only when it fits (I7)', async () => {
  assert.deepEqual(parseFaults('engine-throw:0.01'), { engineThrow: 0.01 });
  const a = parseFaults('engine-throw:0.5:42')!;
  const b = parseFaults('engine-throw:0.5:42')!;
  const seq = (f: typeof a) => Array.from({ length: 20 }, () => f.random!() < f.engineThrow);
  assert.deepEqual(seq(a), seq(b), 'seeded faults are reproducible');
  assert.equal(parseFaults('engine-throw:2'), null);
  assert.equal(parseFaults(undefined), null);
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  await withProxy(up, passthroughEngine(), async (f) => {
    const small = JSON.stringify(chatBody('small'));
    assert.equal((await request(f.port, { body: small })).status, 200);
    assert.equal(up.hits[0]!.body.toString(), small);
    const big = await request(f.port, { body: chatBody('x'.repeat(60_000)) });
    assert.equal(big.status, 400);
    assert.equal(big.json().error.code, 'context_length_exceeded');
    assert.equal(up.hits.length, 1);
    const recs = await waitRecords(f, 2);
    assert.deepEqual(recs.map((r) => [r.action, r.guard]), [['guard_fallback', 'engine:InjectedFault'], ['guard_reject', 'engine:InjectedFault']]);
  }, { faults: { engineThrow: 1 }, config: { budget: { window: 10_000, defaultMaxTokens: 1000 } } });
});

test('an unsafe-integer body is never rewritten ()', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const engine = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true));
  await withProxy(up, engine, async (f) => {
    const raw = '{"model":"m1","seed":12345678901234567890,"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}]}';
    await request(f.port, { body: raw });
    assert.equal(up.hits[0]!.body.toString(), raw);
    assert.equal(engine.calls.length, 0);
    const rec = (await waitRecords(f, 1))[0]!;
    assert.equal(rec.reason, 'unsafe_integer');
  });
});

test('shadow mode: the engine runs, the upstream sees the original bytes, errors are relayed unchanged', async () => {
  const up = await fakeUpstream((hit, res) => {
    if (hit.n === 2) return jsonRes(res, 400, { object: 'error', message: "This model's maximum context length is 9000 tokens. However, you requested 12000 tokens (11000 in the messages, 1000 in the completion).", code: 400 });
    jsonRes(res, 200, okCompletion(20));
  });
  const engine = new FakeEngine((req) => result(req, { ...req, messages: req.messages.slice(-1) }, true, { tokensOut: 3, tokensIn: 9 }));
  await withProxy(up, engine, async (f) => {
    const raw = '{"model":"m1",\n "messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}], "stream":false}';
    const r = await request(f.port, { body: raw });
    assert.equal(r.status, 200);
    assert.equal(up.hits[0]!.body.toString(), raw, 'byte-identical');
    const r2 = await request(f.port, { body: raw });
    assert.equal(r2.status, 400, 'no recovery in shadow');
    assert.equal(up.hits.length, 2);
    assert.equal(engine.calls.length, 2);
    const recs = await waitRecords(f, 2);
    assert.equal(recs[0]!.action, 'shadow');
    assert.equal(recs[0]!.shadow, true);
    assert.equal(recs[0]!.shadow_tokens_out, 3);
    assert.equal(recs[0]!.est_tokens_out, recs[0]!.est_tokens_in, 'gobstopper semantics: out = in in shadow');
  }, { config: { shadow: true, stream: { injectIncludeUsage: true } } });
});

// ---------------------------------------------------------------- host check, routes, status

test('host check blocks DNS rebinding; allowed names, missing Host and "*" pass', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { data: [] }));
  await withProxy(up, passthroughEngine(), async (f) => {
    const evil = await request(f.port, { method: 'GET', path: '/v1/models', headers: { host: 'evil.example:1234' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json().error.type, 'permission_error');
    assert.equal((await request(f.port, { method: 'GET', path: '/v1/models', headers: { host: '127.0.0.2' } })).status, 403);
    assert.equal((await request(f.port, { method: 'GET', path: '/v1/models', headers: { host: 'localhost:99' } })).status, 200);
    assert.equal((await request(f.port, { method: 'GET', path: '/status', headers: { host: '[::1]:8270' } })).status, 200);
    const noHost = await rawRequest(f.port, 'GET /v1/models HTTP/1.0\r\n\r\n');
    assert.match(noHost, /^HTTP\/1\.[01] 200/);
    assert.equal(up.hits.length, 2, 'rejected requests never reach the upstream');
  });
  const up2 = await fakeUpstream((_h, res) => jsonRes(res, 200, {}));
  await withProxy(up2, passthroughEngine(), async (f) => {
    assert.equal((await request(f.port, { method: 'GET', path: '/x', headers: { host: 'evil.example' } })).status, 200);
  }, { config: { listen: { allowedHosts: ['*'] } } });
});

test('everything else is a streamed pass-through to the same upstream; /status never is', async () => {
  const up = await fakeUpstream((hit, res) => jsonRes(res, 200, { path: hit.url, method: hit.method, body: hit.body.toString() }));
  await withProxy(up, passthroughEngine(), async (f) => {
    const m = await request(f.port, { method: 'GET', path: '/v1/models?x=1' });
    assert.deepEqual(m.json(), { path: '/v1/models?x=1', method: 'GET', body: '' });
    const e = await request(f.port, { method: 'POST', path: '/v1/embeddings', body: '{"input":"a"}' });
    assert.deepEqual(e.json(), { path: '/v1/embeddings', method: 'POST', body: '{"input":"a"}' });
    const s = await request(f.port, { method: 'GET', path: '/kitzur/status' });
    const j = s.json();
    for (const k of ['version', 'uptime_s', 'config', 'budget', 'counter', 'learned', 'counters', 'actions', 'error_kinds', 'guard', 'replan', 'upstream_rejected_rewrite', 'warnings', 'sessions', 'latency_ms', 'memory']) assert.ok(k in j, k);
    assert.equal(j.budget.budget, 67_000, 'the §3 budget of the 100k preset');
    assert.equal(up.hits.length, 2);
    assert.equal(j.counters.passthrough_requests, 2);
  });
});

test('unparseable chat bodies fail open: forwarded unchanged, recorded', async () => {
  const up = await fakeUpstream((hit, res) => jsonRes(res, 400, { error: { message: 'bad json' } }));
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: '{"messages": [' });
    assert.equal(r.status, 400);
    assert.equal(up.hits[0]!.body.toString(), '{"messages": [');
    const rec = (await waitRecords(f, 1))[0]!;
    assert.equal(rec.reason, 'parse:invalid_json');
  });
});

test('upstream unavailable before headers: 502 upstream_unavailable', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, {}));
  const port = up.port;
  await up.close();
  const f = await startProxy(`http://127.0.0.1:${port}`, passthroughEngine());
  try {
    const r = await request(f.port, { body: chatBody('x') });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json(), { error: { message: 'kitzur: upstream unavailable', type: 'api_error', code: 'upstream_unavailable' } });
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------- stats, calibration, drain

test('stats JSONL: one record per chat request, gobstopper-compatible fields plus ours, never content', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion(20)));
  const engine = new FakeEngine((req, o) => result(req, { ...req, messages: req.messages.slice(-1) }, true, { tokensIn: 50, tokensOut: 10, budget: { trigger: 61_000, budget: 67_000 } }));
  await withProxy(up, engine, async (f) => {
    await request(f.port, { body: chatBody('SECRET-CONTENT-1', { messages: [{ role: 'user', content: 'SECRET-CONTENT-2' }] }), headers: { 'x-session-id': 'ses_abc', authorization: 'Bearer SECRET-TOKEN' } });
    await request(f.port, { method: 'GET', path: '/v1/models' });
    await request(f.port, { body: chatBody('SECRET-CONTENT-3') });
    const recs = await waitRecords(f, 2);
    await sleep(50);
    assert.equal(f.records().length, 2, 'pass-through routes get no record');
    const r = recs[0]!;
    for (const k of ['ts', 'compacted', 'reused_prefix', 'rung', 'over_budget', 'est_tokens_in', 'est_tokens_out', 'est_summary_tokens', 'carry_chars', 'threshold_tokens', 'ratio_permille']) assert.ok(k in r, k);
    for (const k of ['seq', 'session', 'path', 'action', 'messages_in', 'messages_out', 'tokens_in', 'tokens_out', 'budget', 'trigger', 'attempts', 'engine_ms', 'total_ms', 'client_status']) assert.ok(k in r, k);
    assert.deepEqual([r.seq, recs[1]!.seq], [1, 2]);
    assert.deepEqual([r.compacted, r.est_tokens_in, r.est_tokens_out, r.threshold_tokens, r.carry_chars, r.ratio_permille, r.client_status], [true, 50, 10, 61_000, 0, 1000, 200]);
    assert.equal(r.client_session, 'ses_abc');
    assert.equal(r.attempts.length, 1);
    assert.equal(r.attempts[0]!.kind, 'ok');
    assert.ok(r.attempts[0]!.bytes > 0 && r.attempts[0]!.raw > 0);
    assert.equal(r.path, '/v1/chat/completions');
    const text = readFileSync(f.statsPath, 'utf8');
    assert.ok(!/SECRET/.test(text), 'no content, no header values');
  });
});

test('calibration from usage: accepted samples move the correction, persisted before the next request plans with it', async () => {
  const counter = charCounter('estimate');
  // the server counts 1.3x our estimate
  const up = await fakeUpstream((hit, res) => jsonRes(res, 200, okCompletion(Math.round(bodyTokens(hit.json) * 1.3))));
  const engine = passthroughEngine();
  await withProxy(up, engine, async (f) => {
    const body = { model: 'm1', messages: [{ role: 'user', content: 'x'.repeat(40_000) }], max_tokens: 100 };
    for (let i = 0; i < 3; i++) await request(f.port, { body });
    await waitRecords(f, 3);
    await sleep(30);
    const key = learnedKey(up.origin, 'm1');
    const disk = readLearnedState(join(f.stateDir, 'learned.json')).state.entries[key]!;
    assert.equal(disk.correction, 1.3);
    assert.equal(disk.samples, 3);
    await request(f.port, { body });
    assert.equal(engine.calls[3]!.opts.learned?.correction, 1.3, 'the next request plans with it');
    const tiny = { model: 'm1', messages: [{ role: 'user', content: 'x' }] };
    await request(f.port, { body: tiny });
    await waitRecords(f, 5);
    await sleep(30);
    assert.equal(f.state.entry(key).samples, 4, 'tiny requests are filtered');
    // an out-of-band sample is a usage_mismatch, never learned
    up.responder = (hit, res) => jsonRes(res, 200, okCompletion(bodyTokens(hit.json) * 5));
    await request(f.port, { body });
    const recs = await waitRecords(f, 6);
    assert.equal(recs[5]!.usage_mismatch, true);
    assert.equal(f.state.entry(key).samples, 4);
  }, { counter, config: { calibration: { minSamples: 3, minCountedTokens: 1000 } } });
});

test('calibration from the tokenize endpoint when no usage comes back (a calibration source only)', async () => {
  const counter = charCounter('estimate');
  const up = await fakeUpstream((_h, res) => sseRes(res, [chunk('a', 'stop'), DONE]));
  let calls = 0;
  const remote = {
    style: 'vllm' as const, url: 'x',
    count: async (text: string) => (calls++, Math.round(text.length / 4 * 1.2)),
    stats: () => ({ requests: calls, ok: calls, failed: 0, skipped: 0, lastError: null }), down: () => false, close: () => undefined,
  };
  const { createProfile, renderPrompt } = await import('../../src/tokenize/template.js');
  const profile = createProfile('chatml');
  // a counter whose raw count equals chars/4 of the chatml render (so the ratio is exactly 1.2)
  const c2 = Object.assign(counter, { profile, countRequest: (r: ChatRequest) => Math.round(renderPrompt(profile, r).length / 4) });
  await withProxy(up, passthroughEngine(), async (f) => {
    const body = { model: 'm1', messages: [{ role: 'user', content: 'y'.repeat(40_000) }], stream: true };
    for (let i = 0; i < 3; i++) {
      await request(f.port, { body });
      await waitRecords(f, i + 1);
      await sleep(20);
    }
    assert.equal(calls, 3);
    const e = f.state.entry(learnedKey(up.origin, 'm1'));
    assert.equal(e.samples, 3);
    assert.equal(e.correction, 1.2);
  }, { counter: c2, remote, config: { calibration: { minSamples: 3, minCountedTokens: 1000 } } });
});

test('graceful close drains an in-flight stream, then flushes state and stats', async () => {
  const up = await fakeUpstream(async (_h, res) => sseRes(res, [chunk('a'), chunk('b'), chunk('', 'stop'), DONE], { delayMs: 100 }));
  const f = await startProxy(up, passthroughEngine());
  try {
    const p = request(f.port, { body: chatBody('x', { stream: true }) });
    await sleep(120);
    const t0 = performance.now();
    await f.proxy.close(5000);
    const r = await p;
    assert.ok(performance.now() - t0 >= 150, 'close waited for the stream');
    assert.equal(r.text(), chunk('a') + chunk('b') + chunk('', 'stop') + DONE);
    assert.equal(f.records().length, 1, 'stats flushed');
    await assert.rejects(request(f.port, { body: chatBody('y') }), 'no longer accepting');
  } finally {
    await up.close();
  }
});

// ---------------------------------------------------------------- more streaming edge cases

test('after headers, an upstream failure destroys the client response with no terminating chunk; incomplete streams are recorded', async () => {
  const up = await fakeUpstream(async (hit, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('a'));
    await sleep(50);
    if (hit.json.messages[1].content === 'die') res.socket?.destroy(); // upstream crash mid-stream
    else res.end(chunk('b')); // ends without [DONE] and without finish_reason
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const died = await new Promise<{ error: boolean; body: string }>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } });
      let body = '';
      req.on('response', (res) => {
        res.on('data', (d: Buffer) => (body += d.toString()));
        res.on('end', () => resolve({ error: false, body }));
        res.on('error', () => resolve({ error: true, body }));
        res.on('aborted', () => resolve({ error: true, body }));
      });
      req.on('error', () => resolve({ error: true, body }));
      req.end(JSON.stringify(chatBody('die', { stream: true })));
    });
    assert.equal(died.error, true, 'the client sees a broken stream, not a clean end');
    assert.equal(died.body, chunk('a'));
    const r = await request(f.port, { body: chatBody('short', { stream: true }) });
    assert.equal(r.text(), chunk('a') + chunk('b'));
    const recs = await waitRecords(f, 2);
    assert.equal(recs.find((x) => x.client_status === 200 && x.upstream_incomplete)?.upstream_incomplete, true);
    assert.ok((f.proxy.snapshot()['counters'] as Record<string, number>)['upstream_incomplete']! >= 1);
  });
});

test("llama.cpp's old `error:` frame is caught as a first-event error and recovered", async () => {
  const counter = charCounter();
  const cfgOver = { budget: { window: 4000, defaultMaxTokens: 500, planMaxTokens: 500 } };
  const cfg = testConfig(cfgOver);
  const up = await fakeUpstream(async (hit, res) => {
    if (bodyTokens(hit.json) > 1500) return sseRes(res, ['error: {"code":400,"message":"the request exceeds the available context size. try increasing the context size or enable context shift","type":"invalid_request_error"}\n\n', DONE]);
    await sseRes(res, [chunk('ok', 'stop'), DONE]);
  });
  const history: ChatRequest['messages'] = [{ role: 'system', content: 's' }, { role: 'user', content: 'goal' }];
  for (let i = 0; i < 8; i++) history.push({ role: 'assistant', content: 'a'.repeat(800) }, { role: 'user', content: 'u' });
  await withProxy(up, shrinkingEngine(cfg, counter), async (f) => {
    const r = await request(f.port, { body: { model: 'm1', messages: history, max_tokens: 500, stream: true } });
    assert.equal(r.status, 200);
    assert.equal(r.text(), chunk('ok', 'stop') + DONE);
    assert.ok(up.hits.length >= 2);
    const e = f.state.entry(learnedKey(up.origin, 'm1'));
    assert.ok(e.tighten > 0, 'no numbers: the overflow_unknown tighten was learned');
    assert.equal(e.tightenLog[0]!.rule, 'llamacpp.old');
    const snap = f.proxy.snapshot();
    assert.equal((snap['recent_rejections'] as Array<{ rule: string }>)[0]!.rule, 'llamacpp.old');
  }, { counter, config: cfgOver });
});

test('hold disabled: headers are committed at once; errors.inStream=false relays a first-event error unchanged', async () => {
  const errEv = SSE_OVERFLOW(9000, 8000);
  const up = await fakeUpstream(async (_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    await sleep(200);
    res.end(errEv + DONE);
  });
  await withProxy(up, passthroughEngine(), async (f) => {
    const r = await request(f.port, { body: chatBody('x', { stream: true }) });
    assert.ok(r.headerMs < 150, `committed at the upstream headers (${r.headerMs.toFixed(0)} ms)`);
    assert.equal(r.text(), errEv + DONE);
    assert.equal(up.hits.length, 1);
  }, { config: { stream: { holdFirstEvent: false }, errors: { inStream: false } } });
});

test('probe() records the upstream check in /status', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, { data: [] }));
  await withProxy(up, passthroughEngine(), async (f) => {
    assert.deepEqual(await f.proxy.probe(), { ok: true, status: 200 });
    const s = await request(f.port, { method: 'GET', path: '/status' });
    assert.equal(s.json().upstream.probe.ok, true);
  });
});
