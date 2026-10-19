import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawCapture } from '../../src/proxy/capture.js';
import { passthroughEngine } from './fake-engine.js';
import { fakeUpstream, startProxy, request, sseRes, chunk, DONE } from './harness.js';

function records(path: string): any[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('capture preserves response bytes before parsing, redacts headers, records shape only and expires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-capture-'));
  const path = join(dir, 'raw.jsonl');
  const pieces = [Buffer.from(': comment\r\n\r\n'), Buffer.from(chunk('héllo')), Buffer.from(DONE), Buffer.from([0xff, 0xc3])];
  const up = await fakeUpstream(async (_hit, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', authorization: 'AUTH_SECRET', cookie: 'COOKIE_SECRET',
      'set-cookie': 'SET_COOKIE_SECRET', 'x-api-key': 'API_SECRET', 'x-private': 'CUSTOM_SECRET', 'x-public': 'visible' });
    for (const piece of pieces) { res.write(piece); await new Promise(resolve => setImmediate(resolve)); }
    res.end();
  });
  const logs: string[] = [];
  const f = await startProxy(up, passthroughEngine(), { config: {
    upstream: { headers: { 'X-Private': 'CUSTOM_SECRET' } },
    debug: { capture: { path, requests: 1 } },
  }, log: (_level, msg) => logs.push(msg) });
  try {
    assert.equal((f.proxy.snapshot().debug as any).capture.active, true);
    assert.ok(logs.some(s => s.includes('raw response capture') && s.includes('"active":true')));
    const body = { model: 'MODEL_TEXT_SECRET', messages: [{ role: 'user', content: 'MESSAGE_SECRET' }],
      tools: [{ type: 'function', function: { name: 'TOOL_SECRET', description: 'DESCRIPTION_SECRET' } }],
      temperature: 0.2, stream: true, chat_template_kwargs: { enable_thinking: false, arbitrary: 'KWARG_SECRET' },
      unexpected: 'EXTRA_SECRET' };
    const response = await request(f.port, { body, headers: { authorization: 'Bearer CLIENT_SECRET' } });
    assert.deepEqual(response.body, Buffer.concat(pieces));
    const rows = records(path);
    assert.deepEqual(Buffer.concat(rows.filter(r => r.type === 'chunk').map(r => Buffer.from(r.base64, 'base64'))), Buffer.concat(pieces));
    assert.ok(rows.filter(r => r.type === 'chunk').every(r => !Number.isNaN(Date.parse(r.ts))));
    assert.deepEqual(rows[0].shape, { params: { temperature: 0.2, stream: true }, chat_template_kwargs: { enable_thinking: false }, messages: 1, tools: 1 });
    const headers = rows.find(r => r.type === 'response');
    assert.equal(headers.status, 'HTTP/1.1 200 OK');
    assert.ok(headers.headers.includes('visible'));
    assert.equal(headers.headers.filter((v: string) => v === '[REDACTED]').length, 5);
    assert.equal(rows.at(-1).reason, 'end');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path);
    await request(f.port, { body });
    assert.deepEqual(readFileSync(path), before);
    assert.equal((f.proxy.snapshot().debug as any).capture.active, false);
    assert.doesNotMatch(before.toString(), /SECRET/);
  } finally { await f.close(); await up.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('maxBytes includes metadata and base64 overhead, ends capture without affecting relay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-capture-'));
  const path = join(dir, 'raw.jsonl');
  const payload = chunk('x'.repeat(5000)) + DONE;
  const up = await fakeUpstream(async (_hit, res) => sseRes(res, [payload]));
  const f = await startProxy(up, passthroughEngine(), { config: { debug: { capture: { path, maxBytes: 1024 } } } });
  try {
    assert.equal((await request(f.port, { body: { messages: [], stream: true } })).text(), payload);
    assert.ok(statSync(path).size <= 1024);
    assert.equal(records(path).at(-1).reason, 'maxBytes');
    const before = readFileSync(path);
    await request(f.port, { body: { messages: [], stream: true } });
    assert.deepEqual(readFileSync(path), before);
    assert.equal((f.proxy.snapshot().debug as any).capture.active, false);
  } finally { await f.close(); await up.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('disabled capture writes nothing; existing files and symlinks are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-capture-'));
  try {
    const disabled = new RawCapture({ path: null, requests: 5, maxBytes: 1024 }, {});
    assert.equal(disabled.snapshot().active, false);
    disabled.close();
    const path = join(dir, 'existing');
    writeFileSync(path, 'untouched', { mode: 0o644 });
    const link = join(dir, 'link');
    symlinkSync(path, link);
    for (const file of [path, link]) {
      const capture = new RawCapture({ path: file, requests: 5, maxBytes: 1024 }, {});
      assert.equal(capture.snapshot().active, false);
      assert.ok(capture.snapshot().error);
      capture.close();
    }
    assert.equal(readFileSync(path, 'utf8'), 'untouched');
    assert.equal(statSync(path).mode & 0o777, 0o644);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stream mock: exact chunks are captured before consumers; request budget stops at N', async () => {
  const { IncomingMessage } = await import('node:http');
  const { Socket } = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-capture-'));
  const path = join(dir, 'raw');
  const capture = new RawCapture({ path, requests: 2, maxBytes: 8192 }, { 'X-Private': 'private' });
  try {
    for (let i = 0; i < 3; i++) {
      const body = new IncomingMessage(new Socket());
      body.httpVersion = '1.1';
      const up = { status: 200, statusMessage: 'OK', headers: {}, rawHeaders: ['Authorization', 'SECRET', 'X-Private', 'SECRET'], body, headerMs: 0, reused: false, retried: false };
      await capture.request(async () => up, { method: 'POST', path: '/', headers: {}, body: Buffer.from('{"messages":[{"content":"SECRET"}],"chat_template_kwargs":{"enable_thinking":true}}') });
      const pieces = [Buffer.from([0xc3]), Buffer.from([0xa9, 0xff]), Buffer.from('data: [DONE]\n\n')];
      body.on('data', () => {
        if (i < 2) assert.equal(records(path).at(-1).type, 'chunk', 'capture precedes the parser');
      });
      for (const piece of pieces) body.emit('data', piece);
      body.emit('end');
      body.emit('close');
      if (i < 2) assert.deepEqual(Buffer.concat(records(path).filter(r => r.type === 'chunk' && r.id === i + 1).map(r => Buffer.from(r.base64, 'base64'))), Buffer.concat(pieces));
    }
    assert.equal(records(path).filter(r => r.type === 'request').length, 2);
    assert.equal(records(path).filter(r => r.type === 'end').length, 2);
    assert.equal(capture.snapshot().active, false);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /SECRET/);
  } finally { capture.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('stream mock: byte cap and failed upstream attempts automatically stop capture', async () => {
  const { IncomingMessage } = await import('node:http');
  const { Socket } = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-capture-'));
  const path = join(dir, 'raw');
  const capture = new RawCapture({ path, requests: 5, maxBytes: 1024 }, {});
  try {
    const body = new IncomingMessage(new Socket());
    await capture.request(async () => ({ status: 200, statusMessage: 'OK', headers: {}, rawHeaders: [], body, headerMs: 0, reused: false, retried: false }),
      { method: 'POST', path: '/', headers: {}, body: Buffer.from('invalid SECRET') });
    body.emit('data', Buffer.alloc(5000, 0xff));
    body.emit('end');
    assert.equal(records(path).at(-1).reason, 'maxBytes');
    assert.ok(statSync(path).size <= 1024);
    assert.equal(capture.snapshot().active, false);
    const failedPath = join(dir, 'failed');
    const failed = new RawCapture({ path: failedPath, requests: 1, maxBytes: 1024 }, {});
    await assert.rejects(failed.request(async () => { throw new Error('SECRET'); }, { method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) }));
    assert.equal(records(failedPath).at(-1).reason, 'upstream_error');
    assert.doesNotMatch(readFileSync(failedPath, 'utf8'), /SECRET/);
    assert.equal(failed.snapshot().active, false);
  } finally { capture.close(); rmSync(dir, { recursive: true, force: true }); }
});
