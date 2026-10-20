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
  assert.equal(writer.dropped, 75);
  assert.equal(writer.written, 1025);
  release();
  sink.destroy();
});
