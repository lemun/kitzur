import { test } from 'node:test';
import assert from 'node:assert/strict';
import { p99InterChunkGap, pooledP99InterChunkGap } from '../../bench/stream-gap.js';

test('p99 inter-chunk gap reports the observed interval', () => {
  assert.equal(p99InterChunkGap([0, 10, 20, 45]), 25);
  assert.equal(p99InterChunkGap([5]), 0);
  assert.equal(p99InterChunkGap([]), 0);
});

test('pooled p99 differs from the worst stream p99 when one gap is slow among many fast ones', () => {
  // stream 0: 3 gaps, one of them 200 ms; streams 1..3: 99 gaps of 10 ms each
  const slow = [0, 10, 210, 220];
  const fast = Array.from({ length: 100 }, (_, i) => i * 10);
  const sets = [slow, fast, fast, fast];
  const worst = Math.max(...sets.map(p99InterChunkGap));
  assert.equal(worst, 200);
  // 300 pooled gaps: the 297th smallest is still 10 ms
  assert.equal(pooledP99InterChunkGap(sets), 10);
});

test('pooled p99 handles empty and single-chunk streams', () => {
  assert.equal(pooledP99InterChunkGap([]), 0);
  assert.equal(pooledP99InterChunkGap([[], [5]]), 0);
  assert.equal(pooledP99InterChunkGap([[], [5], [0, 10, 20, 45]]), 25);
});
