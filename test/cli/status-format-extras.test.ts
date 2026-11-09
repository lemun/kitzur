import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from '../../src/cli/format.js';
import { StatusTracker } from '../../src/proxy/status.js';
import { testConfig } from '../proxy/harness.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const base = { counters: { chat_requests: 3 }, outcomes: { ok: 3 } };
const lines = (out: string) => out.split('\n').filter((l) => /^(Upstream retries|Legacy completions):/.test(l));

test('formatStatus shows the upstream retries and legacy completions inside the Chat requests group', () => {
  const out = formatStatus({
    ...base,
    counters: { chat_requests: 3, legacy_completions: 4, legacy_over_budget: 1 },
    transient_retries: { retries: 5, by_status: { 503: 2, 429: 3 }, delay_ms: 1500, exhausted: 1 },
  }, NOW);
  assert.deepEqual(lines(out), ['Upstream retries: 5 (429=3, 503=2); waited 1500ms; gave up on 1 request', 'Legacy completions: 4 counted, 1 over budget']);
  const group = out.split('\n\n').find((g) => g.startsWith('Chat requests:'))!;
  assert.deepEqual(group.split('\n').map((l) => l.split(':')[0]), ['Chat requests', 'Outcomes', 'Upstream retries', 'Legacy completions', 'Last compaction']);
});

test('formatStatus sorts the retry statuses numerically and words the give-up clause', () => {
  const out = formatStatus({ ...base, transient_retries: { retries: 6, by_status: { 503: 1, 429: 2, 502: 3 }, delay_ms: 10, exhausted: 0 } }, NOW);
  assert.deepEqual(lines(out), ['Upstream retries: 6 (429=2, 502=3, 503=1); waited 10ms']);
  assert.deepEqual(lines(formatStatus({ ...base, transient_retries: { retries: 0, by_status: {}, delay_ms: 0, exhausted: 2 } }, NOW)),
    ['Upstream retries: 0; waited 0ms; gave up on 2 requests']);
  assert.deepEqual(lines(formatStatus({ ...base, transient_retries: { retries: 1, by_status: { 429: 1 } } }, NOW)), ['Upstream retries: 1 (429=1); waited 0ms']);
  assert.deepEqual(lines(formatStatus({ ...base, counters: { legacy_completions: 2, legacy_over_budget: 0 } }, NOW)), ['Legacy completions: 2 counted']);
});

test('formatStatus prints nothing for zero, missing, non-numeric, negative or oversized values', () => {
  const plain = formatStatus(base, NOW);
  for (const extra of [
    { transient_retries: { retries: 0, by_status: {}, delay_ms: 0, exhausted: 0 }, counters: { chat_requests: 3, legacy_completions: 0, legacy_over_budget: 0 } },
    { transient_retries: { retries: '5', exhausted: 'x' }, counters: { chat_requests: 3, legacy_completions: '4', legacy_over_budget: 1 } },
    { transient_retries: { retries: -1, exhausted: -2 }, counters: { chat_requests: 3, legacy_completions: -4 } },
    { transient_retries: { retries: 1e300, exhausted: Infinity }, counters: { chat_requests: 3, legacy_completions: 2 ** 60 } },
    { transient_retries: 'yes' },
    { transient_retries: null },
  ]) assert.equal(formatStatus({ ...base, ...extra }, NOW), plain, JSON.stringify(extra));
  const odd = formatStatus({ ...base, counters: { legacy_completions: 1, legacy_over_budget: -1 }, transient_retries: { retries: 2, by_status: { 429: 'x', abc: 1, 503: -1, 502: 2 }, delay_ms: NaN, exhausted: '1' } }, NOW);
  assert.deepEqual(lines(odd), ['Upstream retries: 2 (502=2); waited 0ms', 'Legacy completions: 1 counted']);
  assert.doesNotMatch(odd, /undefined|NaN|\[object/);
});

test('formatStatus of a real snapshot shows the recorded retries and legacy prompts', () => {
  const tracker = new StatusTracker(testConfig({}), 'test', () => NOW);
  tracker.transientRetry(503, 400);
  tracker.transientRetry(429, 250);
  tracker.transientExhausted();
  tracker.legacyCompletions++;
  const s = JSON.parse(JSON.stringify(tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {}, statsDropped: 0 })));
  assert.deepEqual(lines(formatStatus(s, NOW)), ['Upstream retries: 2 (429=1, 503=1); waited 650ms; gave up on 1 request', 'Legacy completions: 1 counted']);
  assert.deepEqual(lines(formatStatus(JSON.parse(JSON.stringify(new StatusTracker(testConfig({}), 'test', () => NOW).snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {}, statsDropped: 0 }))), NOW)), []);
});
