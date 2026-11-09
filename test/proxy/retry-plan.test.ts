import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSIENT_STATUSES, backoffDelayMs, parseRetryAfter, planRetry, type RetryConfig } from '../../src/proxy/retry.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const never = (): number => {
  throw new Error('random() must not be called');
};

test('parseRetryAfter reads delta-seconds and HTTP-dates and rejects everything else', () => {
  assert.equal(parseRetryAfter('0', NOW), 0);
  assert.equal(parseRetryAfter('2', NOW), 2000);
  assert.equal(parseRetryAfter(' 7 ', NOW), 7000);
  assert.equal(parseRetryAfter('', NOW), null);
  assert.equal(parseRetryAfter('   ', NOW), null);
  assert.equal(parseRetryAfter('abc', NOW), null);
  assert.equal(parseRetryAfter('-1', NOW), null);
  assert.equal(parseRetryAfter('1.5', NOW), null);
  assert.equal(parseRetryAfter(undefined, NOW), null);
  assert.equal(parseRetryAfter('9'.repeat(400), NOW), Number.MAX_SAFE_INTEGER);
  assert.equal(parseRetryAfter('99999999999999', NOW), Number.MAX_SAFE_INTEGER);
  assert.equal(parseRetryAfter(new Date(NOW + 10_000).toUTCString(), NOW), 10_000);
  assert.equal(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter(new Date(NOW).toUTCString(), NOW), 0);
});

test('backoffDelayMs doubles from the base, stops at the cap and jitters uniformly in [0, delay]', () => {
  const plain = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false };
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, plain, never)), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  const jittered = { ...plain, jitter: true };
  assert.equal(backoffDelayMs(4, jittered, () => 0), 0);
  assert.equal(backoffDelayMs(4, jittered, () => 0.999999), 2000);
  assert.equal(backoffDelayMs(4, jittered, () => 0.5), 1000);
  const big = backoffDelayMs(2000, plain, never);
  assert.equal(big, 8000);
  const huge = backoffDelayMs(2000, { baseDelayMs: 500, maxDelayMs: Number.MAX_SAFE_INTEGER, jitter: false }, never);
  assert.ok(Number.isFinite(huge) && huge <= Number.MAX_SAFE_INTEGER, String(huge));
});

const CFG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  maxTotalDelayMs: 20_000,
  honorRetryAfter: true,
  jitter: false,
};
const plan = (over: Partial<Parameters<typeof planRetry>[0]> = {}) =>
  planRetry({ status: 503, retryAfter: undefined, nextAttempt: 2, delayedMs: 0, nowMs: NOW, random: never, cfg: CFG, ...over });

test('planRetry retries only transient statuses, treating 429 and 5xx alike', () => {
  for (const status of [500, 400, 200]) assert.deepEqual(plan({ status }), { retry: false, reason: 'status' }, String(status));
  for (const status of TRANSIENT_STATUSES) assert.deepEqual(plan({ status }), { retry: true, delayMs: 500 }, String(status));
});

test('planRetry stops after maxAttempts', () => {
  assert.deepEqual(plan({ nextAttempt: 3 }), { retry: true, delayMs: 1000 });
  assert.deepEqual(plan({ nextAttempt: 4 }), { retry: false, reason: 'attempts' });
});

test('planRetry honors Retry-After up to maxDelayMs and gives up beyond it', () => {
  assert.deepEqual(plan({ retryAfter: '3' }), { retry: true, delayMs: 3000 });
  assert.deepEqual(plan({ retryAfter: '9' }), { retry: false, reason: 'retry-after-beyond-cap' });
  assert.deepEqual(plan({ retryAfter: '9', cfg: { ...CFG, honorRetryAfter: false } }), { retry: true, delayMs: 500 });
  assert.deepEqual(plan({ retryAfter: 'soon', nextAttempt: 3 }), { retry: true, delayMs: 1000 });
});

test('planRetry keeps the total added waiting within maxTotalDelayMs, inclusive', () => {
  assert.deepEqual(plan({ retryAfter: '2', delayedMs: 19_000 }), { retry: false, reason: 'total-delay' });
  assert.deepEqual(plan({ retryAfter: '2', delayedMs: 18_000 }), { retry: true, delayMs: 2000 });
  assert.deepEqual(plan({ nextAttempt: 4, delayedMs: 19_000, cfg: { ...CFG, maxAttempts: 5 } }), { retry: false, reason: 'total-delay' });
});
