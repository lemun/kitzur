import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, fakeUpstream, jsonRes, okCompletion, request, sleep, startProxy, waitRecords, type ClientResponse, type ProxyFixture } from './harness.js';

// Odd non-stream upstream answers: the first upstream hit gets `odd`, later hits an ordinary completion.
// Each case checks what the client sees, then that the proxy still serves and logged no error.
async function oddAnswer(t: Parameters<typeof startProxy>[0], odd: (res: ServerResponse) => void, check: (r: ClientResponse | Error, f: ProxyFixture, logs: string[]) => void | Promise<void>, config = {}): Promise<void> {
  const logs: string[] = [];
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => { rejections.push(e); };
  process.on('unhandledRejection', onRejection);
  const up = await fakeUpstream((hit, res) => (hit.n === 1 ? odd(res) : jsonRes(res, 200, okCompletion())));
  const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`), config });
  try {
    const r = await request(f.port, { body: chatBody('hi') }).catch((e: Error) => e);
    await waitRecords(f, 1);
    // The chat log line can land a tick after the stats record (seen on an aborted body): wait for it, bounded.
    for (let i = 0; i < 50 && !logs.some(l => l.includes(' outcome=')); i++) await sleep(10);
    await check(r, f, logs);
    const again = await request(f.port, { body: chatBody('again') });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json(), okCompletion());
    assert.equal((await request(f.port, { method: 'GET', path: '/status' })).status, 200);
    assert.deepEqual(logs.filter(l => l.startsWith('error')), []);
    assert.deepEqual(rejections, []);
  } finally { process.off('unhandledRejection', onRejection); await f.close(); await up.close(); }
}

const ok = (r: ClientResponse | Error): ClientResponse => { assert.ok(!(r instanceof Error), String(r)); return r; };

test('(a) JSON cut mid-body is relayed as-is with outcome=ok', (t) => oddAnswer(t, res => jsonRes(res, 200, '{"choices":[{"mess'), (r, _f, logs) => {
  assert.equal(ok(r).status, 200);
  assert.equal(ok(r).text(), '{"choices":[{"mess');
  assert.equal(ok(r).headers['x-kitzur-action'], 'passthrough');
  assert.ok(logs.some(l => /outcome=ok .*bytes=18/.test(l)));
}));

test('(b) an HTML body is relayed unchanged', (t) => oddAnswer(t, res => jsonRes(res, 200, '<html>hi</html>', { 'content-type': 'text/html' }), (r, _f, logs) => {
  assert.equal(ok(r).status, 200);
  assert.equal(ok(r).headers['content-type'], 'text/html');
  assert.equal(ok(r).text(), '<html>hi</html>');
  assert.ok(logs.some(l => /outcome=ok/.test(l)));
}));

test('(c) an empty body (content-length 0) is relayed empty', (t) => oddAnswer(t, res => jsonRes(res, 200, ''), (r) => {
  assert.equal(ok(r).status, 200);
  assert.equal(ok(r).body.length, 0);
}));

test('(d) a body cut short of its content-length aborts the client and logs upstream_error', (t) => oddAnswer(t, res => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
  res.write('{"choices":[]', () => res.destroy());
}, (r, f, logs) => {
  assert.ok(r instanceof Error, 'the client sees no clean end');
  assert.ok(logs.some(l => /status=200 outcome=upstream_error .*bytes=13/.test(l)));
  // client_status is the status already sent in the headers before the upstream body broke off.
  assert.equal(f.records()[0]?.client_status, 200);
}));

test('(e) no response headers within timeoutMs is a 502 upstream_unavailable', (t) => oddAnswer(t, () => undefined, async (r, f, logs) => {
  assert.equal(ok(r).status, 502);
  assert.deepEqual(ok(r).json(), { error: { message: 'kitzur: upstream unavailable', type: 'api_error', code: 'upstream_unavailable' } });
  assert.ok(logs.some(l => l.startsWith('warn upstream unavailable: no response headers within 300 ms')));
  assert.equal((await request(f.port, { method: 'GET', path: '/status' })).json().counters.upstream_unavailable, 1);
}, { upstream: { timeoutMs: 300 } }));

test('(f) a redirect is relayed, not followed', (t) => oddAnswer(t, res => jsonRes(res, 307, '', { location: 'http://elsewhere.invalid/x' }), (r, _f, logs) => {
  assert.equal(ok(r).status, 307);
  assert.equal(ok(r).headers.location, 'http://elsewhere.invalid/x');
  assert.ok(logs.some(l => /status=307 outcome=upstream_error/.test(l)));
}));

test('(g) a gzip-labelled body that is not gzip is relayed byte for byte', (t) => oddAnswer(t, res => jsonRes(res, 200, 'not gzip', { 'content-encoding': 'gzip' }), (r) => {
  assert.equal(ok(r).status, 200);
  assert.equal(ok(r).headers['content-encoding'], 'gzip');
  assert.equal(ok(r).text(), 'not gzip');
}));
