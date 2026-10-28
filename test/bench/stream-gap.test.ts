import { test } from 'node:test';
import assert from 'node:assert/strict';
import { p99InterChunkGap } from '../../bench/stream-gap.js';

test('p99 inter-chunk gap reports the observed interval', () => {
  assert.equal(p99InterChunkGap([0, 10, 20, 45]), 25);
  assert.equal(p99InterChunkGap([5]), 0);
});
