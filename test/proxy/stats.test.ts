import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { StatsWriter } from '../../src/proxy/stats.js';

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
