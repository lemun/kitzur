import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusTracker } from '../../src/proxy/status.js';
import { testConfig } from './harness.js';

test('status retains the last compaction and the latest 64 requests in completion order', () => {
  const tracker = new StatusTracker(testConfig(), 'test', () => 1000);
  tracker.paths = () => ({ config: '/tmp/kitzur.jsonc', state_dir: '/tmp/state', log_file: '/tmp/kitzur.log' });
  const snapshot = () => tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} });
  assert.deepEqual(snapshot().paths, { config: '/tmp/kitzur.jsonc', state_dir: '/tmp/state', log_file: '/tmp/kitzur.log' });
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

test('client compaction uses the previous forwarded prompt, isolated by model and session', () => {
  const tracker = new StatusTracker(testConfig(), 'test');
  const req = { model: 'm', messages: [{ role: 'user', content: 'What did we do so far?' }] };
  tracker.forwardedPrompt('m', 'a', 123);
  tracker.forwardedPrompt('other', 'a', 999);
  assert.equal(tracker.clientRequest(req, 'a', 500), 'client compacted at 123 < kitzur trigger 500');
  let s = tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} });
  assert.equal(s.client_compactions, 1);
  assert.deepEqual(s.last_client_compaction, { previous_prompt_tokens: 123, trigger: 500 });
  assert.equal(tracker.clientRequest(req, 'b', 500), null);
  assert.equal(tracker.clientRequest({ ...req, messages: [...req.messages, { role: 'assistant', content: 'summary' }] }, 'a', 500), null);
  s = tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} });
  assert.equal(s.client_compactions, 2);
});

test('p99 completion usage warns only above allowance and ignores invalid samples', () => {
  const tracker = new StatusTracker(testConfig(), 'test');
  const snapshot = () => tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} });
  tracker.completionUsage(NaN, 100);
  tracker.completionUsage(100, 100);
  assert.equal((snapshot().warnings as unknown[]).length, 0);
  tracker.completionUsage(101, 100);
  assert.equal(snapshot().completion_tokens_p99, 101);
  assert.match(JSON.stringify(snapshot().warnings), /client.outputAllowanceTokens/);
});

test('status exposes bounded stats writer drop and failure counters', () => {
  const tracker = new StatusTracker(testConfig(), 'test');
  const s = tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {}, statsDropped: 3, statsWriteFailures: 2 });
  assert.deepEqual(s.stats, { path: null, error: null, dropped: 3, write_failures: 2 });
});
