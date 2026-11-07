import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, chunk, DONE, fakeUpstream, jsonRes, request, sseRes, startProxy, waitRecords } from './harness.js';

async function eventually(check: () => boolean, label: string, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const logOutcome = (logs: string[], outcome: string) => logs.some(line => line.includes(`outcome=${outcome}`));

const streams = [
  {
    name: 'recurring keep-alive comments before first data',
    script: async (_h: unknown, res: http.ServerResponse) => sseRes(res, [': ping\n\n', ': ping\n\n', ': ping\n\n', chunk('hello'), DONE], { delayMs: 40 }),
    expected: ': ping\n\n'.repeat(3) + chunk('hello') + DONE, outcome: 'ok',
  },
  {
    name: 'no-space data field and CRLF [DONE]',
    script: (_h: unknown, res: http.ServerResponse) => { const body = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r\n\r\ndata:[DONE]\r\n\r\n'; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); },
    expected: 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r\n\r\ndata:[DONE]\r\n\r\n', outcome: 'ok',
  },
  {
    name: 'error event after several chunks and [DONE]',
    script: (_h: unknown, res: http.ServerResponse) => { const body = chunk('one') + chunk('two') + chunk('three') + DONE + 'data: {"error":{"message":"late"}}\n\n'; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); },
    expected: chunk('one') + chunk('two') + chunk('three') + DONE + 'data: {"error":{"message":"late"}}\n\n', outcome: 'upstream_error',
  },
  {
    name: 'finish reason followed by clean socket close without DONE',
    script: (_h: unknown, res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk('hello', 'stop')); },
    expected: chunk('hello', 'stop'), outcome: 'ok',
  },
  {
    name: 'socket closes without finish reason or DONE',
    script: (_h: unknown, res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk('hello')); },
    expected: chunk('hello'), outcome: 'incomplete',
  },
  {
    name: 'large event is relayed byte-exactly',
    script: (_h: unknown, res: http.ServerResponse) => { const body = chunk('x'.repeat((1 << 20) + 64)) + DONE; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); },
    expected: chunk('x'.repeat((1 << 20) + 64)) + DONE, outcome: 'ok',
  },
  {
    name: 'HTTP 200 JSON error body for a stream request',
    script: (_h: unknown, res: http.ServerResponse) => jsonRes(res, 200, { error: { message: 'gateway failure' } }),
    expected: '{"error":{"message":"gateway failure"}}', outcome: 'ok',
  },
] as const;

for (const c of streams) test(`stream edge: ${c.name}`, async t => {
  const logs: string[] = [];
  const up = await fakeUpstream((h, res) => c.script(h, res));
  const f = await startProxy(t, up, passthroughEngine(), { log: (_level, msg) => logs.push(msg) });
  try {
    const r = await request(f.port, { body: chatBody('hello', { stream: true }) });
    assert.equal(r.text(), c.expected);
    await waitRecords(f, 1);
    assert.ok(logOutcome(logs, c.outcome), logs.join('\n'));
  } finally { await f.close(); await up.close(); }
});

for (const [label, responseBody] of [['with include_usage', { stream_options: { include_usage: true } }], ['without include_usage', {}]] as const) {
  test(`stream edge: usage-only chunk ${label}`, async t => {
    const usage = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n';
    const bytes = chunk('hello') + usage + DONE;
    const logs: string[] = [];
    const up = await fakeUpstream((_h, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(bytes); });
    const f = await startProxy(t, up, passthroughEngine(), { log: (_level, msg) => logs.push(msg) });
    try {
      const r = await request(f.port, { body: chatBody('hello', { stream: true, ...responseBody }) });
      assert.equal(r.text(), bytes);
      await waitRecords(f, 1);
      assert.ok(logOutcome(logs, 'ok'), logs.join('\n'));
    } finally { await f.close(); await up.close(); }
  });
}

for (const [label, first] of [['while comments are held', ': ping\n\n'], ['mid-stream', chunk('hello')]] as const) {
  test(`stream edge: client aborts ${label}`, { timeout: 10_000 }, async t => {
    const logs: string[] = [];
    let closed!: () => void;
    let wrote = false;
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    const up = await fakeUpstream((_h, res) => {
      res.once('close', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(first);
      wrote = true;
    });
    const f = await startProxy(t, up, passthroughEngine(), { log: (_level, msg) => logs.push(msg) });
    try {
      let client!: http.ClientRequest;
      const started = new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, res => {
          res.on('error', () => undefined);
          if (label === 'while comments are held') { res.destroy(); resolve(); }
          else res.once('data', () => { res.destroy(); resolve(); });
        });
        client = req;
        req.on('error', reject);
        req.end(JSON.stringify(chatBody('hello', { stream: true })));
      });
      if (label === 'while comments are held') {
        void started.catch(() => undefined);
        await eventually(() => wrote, 'upstream comment write');
        client.destroy();
        await upstreamClosed;
      } else await started;
      await upstreamClosed;
      await eventually(() => logOutcome(logs, 'aborted'), 'aborted outcome');
    } finally { await f.close(); await up.close(); }
  });
}

test('stream edge: upstream header stall times out', async t => {
  const logs: string[] = [];
  const up = await fakeUpstream(() => undefined);
  const f = await startProxy(t, up, passthroughEngine(), { config: { upstream: { timeoutMs: 80 } }, log: (_level, msg) => logs.push(msg) });
  try {
    const r = await request(f.port, { body: chatBody('hello', { stream: true }) });
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, Buffer.from('{"error":{"message":"kitzur: upstream unavailable","type":"api_error","code":"upstream_unavailable"}}'));
    await eventually(() => logOutcome(logs, 'upstream_error'), 'upstream timeout outcome');
  } finally { await f.close(); await up.close(); }
});
