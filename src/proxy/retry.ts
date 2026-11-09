// The waiting rules for transient upstream retries, as pure functions: Retry-After parsing, capped
// exponential backoff with full jitter, and the order in which a retry is given up. Time and
// randomness come in as arguments so every rule can be tested without a server or a clock.

export const TRANSIENT_STATUSES = [429, 502, 503, 504] as const;

export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface RetryConfig extends BackoffConfig {
  maxAttempts: number;
  maxTotalDelayMs: number;
  honorRetryAfter: boolean;
}

export type RetryPlan =
  | { retry: true; delayMs: number }
  | { retry: false; reason: 'status' | 'attempts' | 'retry-after-beyond-cap' | 'total-delay' };

/**
 * The wait a Retry-After value asks for, in milliseconds: delta-seconds or an HTTP-date relative to
 * nowMs. A date at or before now gives 0. Returns null for a missing, empty, negative, decimal or
 * otherwise unreadable value.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^[0-9]+$/.test(v)) {
    const ms = Number(v) * 1000;
    return Number.isSafeInteger(ms) ? ms : Number.MAX_SAFE_INTEGER;
  }
  // An HTTP-date always names a weekday or a month; this keeps '-1' or '1.5' from reading as a date.
  if (!/[A-Za-z]/.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * The delay before attempt nextAttempt (2 for the first retry): min(maxDelayMs, baseDelayMs * 2^(nextAttempt-2)),
 * and with jitter a uniform pick in [0, delay]. random() must return a value in [0, 1).
 */
export function backoffDelayMs(nextAttempt: number, cfg: BackoffConfig, random: () => number): number {
  // Double step by step and stop at the cap, so a large attempt number never overflows.
  let delay = cfg.baseDelayMs;
  for (let i = 0; i < nextAttempt - 2 && delay < cfg.maxDelayMs; i++) delay *= 2;
  delay = Math.min(cfg.maxDelayMs, delay);
  return cfg.jitter ? Math.floor(random() * (delay + 1)) : delay;
}

/**
 * Whether to retry a transient upstream error and how long to wait first. The rules apply in order:
 * the status must be transient, the attempt count must allow another attempt, a Retry-After beyond
 * maxDelayMs gives up at once (a shorter wait would retry before the server allows it), and the total
 * added waiting must stay within maxTotalDelayMs.
 */
export function planRetry(i: {
  status: number;
  retryAfter: string | undefined;
  nextAttempt: number;
  delayedMs: number;
  nowMs: number;
  random: () => number;
  cfg: RetryConfig;
}): RetryPlan {
  const { cfg } = i;
  if (!(TRANSIENT_STATUSES as readonly number[]).includes(i.status)) return { retry: false, reason: 'status' };
  if (i.nextAttempt > cfg.maxAttempts) return { retry: false, reason: 'attempts' };
  let delayMs: number;
  const asked = cfg.honorRetryAfter ? parseRetryAfter(i.retryAfter, i.nowMs) : null;
  if (asked !== null) {
    if (asked > cfg.maxDelayMs) return { retry: false, reason: 'retry-after-beyond-cap' };
    delayMs = asked;
  } else {
    delayMs = backoffDelayMs(i.nextAttempt, cfg, i.random);
  }
  if (i.delayedMs + delayMs > cfg.maxTotalDelayMs) return { retry: false, reason: 'total-delay' };
  return { retry: true, delayMs };
}
