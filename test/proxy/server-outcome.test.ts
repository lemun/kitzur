import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, chunk, DONE, fakeUpstream, request, startProxy, waitRecords } from './harness.js';

for (const legacy of [false, true]) test(`mid-stream error (${legacy ? 'legacy' : 'modern'}) is diagnosed and byte-exact`, async (t) => {
  const message = 'boom ' + 'x'.repeat(250);
  const error = legacy ? { object: 'error', message, content: 'PRIVATE' } : { error: { message, content: 'PRIVATE' } };
  const bytes = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n' + `data: ${JSON.stringify(error)}\n\n` + DONE;
  const logs: string[] = [];
  const up = await fakeUpstream((_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(bytes);
  });
  const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`) });
  try {
    const r = await request(f.port, { body: chatBody('hi', { stream: true }) });
    assert.equal(r.text(), bytes);
    await waitRecords(f, 1);
    const snapshot = (await request(f.port, { method: 'GET', path: '/status' })).json();
    assert.equal(snapshot.counters.midstream_errors, 1);
    assert.ok(logs.some(l => /warn upstream sent an error event/.test(l) && l.includes(message.slice(0, 200))));
    assert.ok(logs.some(l => /status=200 outcome=upstream_error finish=none done=true events=3 bytes=/.test(l)));
    assert.ok(logs.every(l => !l.includes('PRIVATE') && !l.includes(message)));
  } finally { await f.close(); await up.close(); }
});

test('stream ending without a completion marker warns and logs incomplete', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((_h, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk('hello'));
  });
  const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`) });
  try {
    await request(f.port, { body: chatBody('hi', { stream: true }) });
    await waitRecords(f, 1);
    assert.ok(logs.some(l => l.startsWith('warn upstream stream ended without')));
    assert.ok(logs.some(l => /outcome=incomplete finish=none done=false events=1 bytes=/.test(l)));
  } finally { await f.close(); await up.close(); }
});

for (const failOpen of [false, true]) test(`client abort warns with counts (passthrough=${failOpen})`, { timeout: 10_000 }, async (t) => {
  const logs: string[] = [];
  let closed!: () => void;
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const up = await fakeUpstream((_h, res) => {
    res.once('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('hello'));
  });
  const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`) });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`expected upstream stream, got HTTP ${res.statusCode}`));
          return;
        }
        res.once('data', () => { res.destroy(); resolve(); });
        res.on('error', () => undefined);
      });
      req.on('error', reject);
      req.end(failOpen ? 'invalid-json' : JSON.stringify(chatBody('hi', { stream: true })));
    });
    await upstreamClosed;
    // A subsequent round trip lets the proxy's close handlers finish.
    if (!failOpen) await waitRecords(f, 1);
    const snapshot = (await request(f.port, { method: 'GET', path: '/status' })).json();
    assert.equal(snapshot.counters.aborted, 1);
    assert.ok(logs.some(l => /warn client closed before upstream ended .*events=1 bytes=\d+ ms_since_first_byte=/.test(l)));
    assert.ok(logs.some(l => /chat .*outcome=aborted/.test(l)));
  } finally { await f.close(); await up.close(); }
});
