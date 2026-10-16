import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusTracker } from '../../src/proxy/status.js';
import { testConfig } from './harness.js';

test('status retains the last compaction and the latest 64 requests in completion order', () => {
  const tracker = new StatusTracker(testConfig(), 'test', () => 1000);
  const snapshot = () => tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} });
  assert.equal(snapshot().last_compaction, null);
  for (let i = 0; i < 66; i++) {
    tracker.recordRequest({ action: i === 0 ? 'compact' : 'passthrough', tokens: { in: 100, out: i === 0 ? 20 : 100, trigger: 80 }, model: `m${i}`, ms: i });
  }
  const s = snapshot();
  assert.deepEqual(s.last_compaction, { at: '1970-01-01T00:00:01.000Z', in: 100, out: 20, trigger: 80 });
  const recent = s.recent_requests as Array<{ model: string; tokens: { in: number } }>;
  assert.equal(recent.length, 64);
  assert.equal(recent[0]!.model, 'm2');
  assert.equal(recent[63]!.model, 'm65');
  recent[0]!.tokens.in = -1;
  assert.equal((snapshot().recent_requests as typeof recent)[0]!.tokens.in, 100);
});
