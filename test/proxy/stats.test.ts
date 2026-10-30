import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildStatsRecord, StatsWriter } from '../../src/proxy/stats.js';
import { result } from './fake-engine.js';

test('stats persist typed retention outcome counts without request content', () => {
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'PRIVATE-REQUEST-CONTENT' }] };
  const engine = result(req, req, false);
  engine.stats.retention = { verbatim: 1, excerpted: 2, summarized: 3, dropped: 4 };
  const record = buildStatsRecord({
    seq: 1, ts: new Date('2026-01-01T00:00:00.000Z'), path: '/v1/chat/completions', first: engine, last: engine,
    action: 'passthrough', attempts: [], clientStatus: 200, tokensIn: 1, correction: 1, engineMs: 0, totalMs: 1,
    compacted: false, shadow: false, forwarded: 'engine', usage: null, usageMismatch: false, rewriteRejected: false,
  });
  assert.deepEqual(record.retention, { verbatim: 1, excerpted: 2, summarized: 3, dropped: 4 });
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-REQUEST-CONTENT/);
});

test('stats writer bounds queued records while the destination is blocked', () => {
  let release!: () => void;
  const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { release = callback; } });
  const writer = new StatsWriter(null, sink);
  const record = { seq: 1 } as never;
  for (let i = 0; i < 1100; i++) writer.write(record);
  assert.equal(writer.dropped, 76);
  assert.equal(writer.written, 1024);
  release();
  sink.destroy();
});

test('stats writer bounds records the stream accepted but has not completed (default highWaterMark)', async () => {
  const callbacks: Array<() => void> = [];
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callbacks.push(callback); } });
  const writer = new StatsWriter(null, sink);
  for (let i = 0; i < 1100; i++) writer.write({ seq: i } as never);
  assert.equal(writer.written, 1024);
  assert.equal(writer.dropped, 76);
  while (callbacks.length) { callbacks.shift()!(); await new Promise((r) => setImmediate(r)); }
  assert.equal(lines.length, 1024);
  sink.destroy();
});

test('stats writer resolves close when the blocked stream errors', async () => {
  const sink = new Writable({ highWaterMark: 1, write() {} });
  const writer = new StatsWriter('/unused', sink);
  writer.write({ seq: 1 } as never);
  const closing = writer.close();
  sink.emit('error', new Error('disk failed'));
  await closing;
  assert.equal(writer.writeFailures, 1);
});

test('disabled stats output does not count records as dropped', () => {
  const writer = new StatsWriter(null);
  writer.write({ seq: 1 } as never);
  assert.equal(writer.dropped, 0);
});
