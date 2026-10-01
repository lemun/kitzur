import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCounter } from '../../src/tokenize/counter.js';
import { createRemoteTokenizer, parseTokenizeResponse, tokenizeRequestBody, type TokenizeStyle } from '../../src/tokenize/remote.js';
import { renderPrompt, qwen3Profile } from '../../src/tokenize/template.js';
import type { ChatRequest } from '../../src/types.js';

// A fake gateway: "tokenizes" by UTF-16 length, so the expected remote total of a request without
// images is the length of its full render (pieces are exact substrings of it).
interface Fake {
  origin: string;
  requests: Array<{ path: string; body: any }>;
  close(): Promise<void>;
}

function fakeGateway(style: TokenizeStyle, mode: 'ok' | 'error' | 'hang' = 'ok'): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = JSON.parse(data);
      requests.push({ path: req.url ?? '', body });
      if (mode === 'hang') return; // never answers
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
        return;
      }
      const text: string = style === 'llamacpp' ? body.content : style === 'tgi' ? body.inputs : body.prompt;
      const n = text.length;
      const ids = Array.from({ length: n }, (_, i) => i);
      const out = style === 'tgi' ? ids.map((id) => ({ id, text: 'x', start: 0, stop: 1 })) : style === 'llamacpp' ? { tokens: ids } : { count: n, max_model_len: 100000, tokens: ids };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      }),
    ),
  );
}

const REQ: ChatRequest = {
  model: 'qwen3.6',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'Read the config.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"filePath": "/repo/a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1;\n' },
  ],
  tools: [{ type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } }],
};

test('request/response shapes per style', () => {
  assert.deepEqual(tokenizeRequestBody('vllm', 'hi', 'm'), { model: 'm', prompt: 'hi', add_special_tokens: false });
  assert.deepEqual(tokenizeRequestBody('sglang', 'hi', null), { prompt: 'hi', add_special_tokens: false });
  assert.deepEqual(tokenizeRequestBody('llamacpp', 'hi'), { content: 'hi', add_special: false, parse_special: true });
  assert.deepEqual(tokenizeRequestBody('tgi', 'hi'), { inputs: 'hi' });
  assert.equal(parseTokenizeResponse('vllm', { count: 7, tokens: [1] }), 7);
  assert.equal(parseTokenizeResponse('sglang', { tokens: [1, 2, 3] }), 3);
  assert.equal(parseTokenizeResponse('llamacpp', { tokens: [{ id: 1, piece: 'a' }, { id: 2, piece: 'b' }] }), 2);
  assert.equal(parseTokenizeResponse('tgi', [{ id: 1 }, { id: 2 }]), 2);
  assert.equal(parseTokenizeResponse('vllm', { error: 'x' }), null);
  assert.equal(parseTokenizeResponse('tgi', { tokens: [] }), null);
});

for (const style of ['vllm', 'sglang', 'llamacpp', 'tgi'] as TokenizeStyle[]) {
  test(`remote ${style}: prefetch fills the piece cache; measure() then uses the gateway's counts`, async () => {
    const gw = await fakeGateway(style);
    const remote = createRemoteTokenizer({ origin: gw.origin, style, timeoutMs: 2000 });
    try {
      const counter = createCounter({ mode: 'remote', template: 'qwen3', remote });
      await counter.prefetch!(REQ);
      const m = counter.measure(REQ);
      assert.equal(m.total, renderPrompt(qwen3Profile(), REQ).length);
      const path = { vllm: '/tokenize', sglang: '/v1/tokenize', llamacpp: '/tokenize', tgi: '/tokenize' }[style];
      assert.ok(gw.requests.length >= REQ.messages.length);
      assert.ok(gw.requests.every((r) => r.path === path));
      if (style === 'vllm' || style === 'sglang') assert.ok(gw.requests.every((r) => r.body.model === 'qwen3.6' && r.body.add_special_tokens === false));
      // the engine measures with its own digests (prefetch cannot know them): same remote counts
      const engineDigests = REQ.messages.map((_, i) => `engine-digest-${i}`);
      assert.deepEqual(counter.measure(REQ, engineDigests), m);
      // a second prefetch of the same request sends nothing
      const sent = gw.requests.length;
      await counter.prefetch!(REQ);
      assert.equal(gw.requests.length, sent);
      assert.ok(counter.stats().remoteHits > 0);
    } finally {
      remote.close();
      await gw.close();
    }
  });
}

test('remote: messages that were not prefetched (proxy-generated text) are estimated', async () => {
  const gw = await fakeGateway('vllm');
  const remote = createRemoteTokenizer({ origin: gw.origin, style: 'vllm' });
  try {
    const counter = createCounter({ mode: 'remote', template: 'qwen3', remote });
    const est = createCounter({ mode: 'estimate', template: 'qwen3' });
    await counter.prefetch!(REQ);
    const summary = { role: 'user', content: 'The following is a summary of your previous actions (long observations omitted): ...' };
    const req2: ChatRequest = { ...REQ, messages: [...REQ.messages.slice(0, 2), summary, ...REQ.messages.slice(2)] };
    const m = counter.measure(req2);
    const e = est.measure(req2);
    const base = counter.measure(REQ);
    assert.equal(m.perMessage[2], e.perMessage[2], 'the new message costs its estimate');
    assert.equal(m.perMessage[0], base.perMessage[0], 'the system piece keeps its remote count');
    assert.equal(counter.countText('abc'), est.countText('abc'));
  } finally {
    remote.close();
    await gw.close();
  }
});

test('remote: a dead, failing or hanging endpoint never rejects; measure() falls back to the estimate; backoff skips it', async () => {
  const est = createCounter({ mode: 'estimate', template: 'qwen3' });
  const want = est.measure(REQ);

  // connection refused: a port that was just closed
  const gw0 = await fakeGateway('vllm');
  const dead = gw0.origin;
  await gw0.close();
  const r1 = createRemoteTokenizer({ origin: dead, style: 'vllm', timeoutMs: 500, failureBackoffMs: 60_000 });
  const c1 = createCounter({ mode: 'remote', template: 'qwen3', remote: r1 });
  await c1.prefetch!(REQ);
  assert.deepEqual(c1.measure(REQ), want);
  assert.ok(r1.stats().failed >= 1 && r1.down());
  await c1.prefetch!(REQ); // in backoff: nothing is sent
  assert.equal(r1.stats().requests, r1.stats().failed);
  r1.close();

  // HTTP 500
  const gw2 = await fakeGateway('vllm', 'error');
  const r2 = createRemoteTokenizer({ origin: gw2.origin, style: 'vllm', timeoutMs: 500 });
  const c2 = createCounter({ mode: 'remote', template: 'qwen3', remote: r2 });
  await c2.prefetch!(REQ);
  assert.deepEqual(c2.measure(REQ), want);
  assert.match(r2.stats().lastError ?? '', /HTTP 500/);
  r2.close();
  await gw2.close();

  // no answer: the timeout ends it
  const gw3 = await fakeGateway('vllm', 'hang');
  const r3 = createRemoteTokenizer({ origin: gw3.origin, style: 'vllm', timeoutMs: 150 });
  const c3 = createCounter({ mode: 'remote', template: 'qwen3', remote: r3 });
  const t0 = Date.now();
  await c3.prefetch!(REQ);
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(c3.measure(REQ), want);
  assert.match(r3.stats().lastError ?? '', /timeout/);
  r3.close();
  await gw3.close();
});

test('remote: prefetch of a request the template rejects resolves', async () => {
  const r = createRemoteTokenizer({ origin: 'http://127.0.0.1:9', style: 'vllm', timeoutMs: 100 });
  const c = createCounter({ mode: 'remote', template: 'qwen3', remote: r });
  await c.prefetch!({ messages: [{ role: 'assistant', content: 'no user' }] });
  r.close();
});
