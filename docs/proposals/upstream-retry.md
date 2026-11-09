# Proposal: opt-in upstream retry with backoff for 429 and gateway 5xx

Status: follow-ups 1 and 2 are implemented (the `upstream.retry.*` config keys and the chat retry loop); passthrough paths and observability are not. Decisions taken: 500 is not retryable, a `Retry-After` above `maxDelayMs` is relayed at once, the defaults of section 2 stay, and there is no per-request opt-out header.

## 1. Problem

When the upstream answers 429, or a gateway answers 502/503/504, Kitzur hands the error to the client:

- A 502/503/504 is treated as a possible context overflow only when the request was near the budget (`gateway.5xx` rule, `src/proxy/errors.ts:82`; `errors.nearBudgetFraction`, `CONFIG.md:418`). Then it retries with a *smaller* request, up to `errors.maxRetries` (default 2, `src/config/schema.ts:310`, `CONFIG.md:417`). A 503 on a small request is relayed unchanged.
- A 429 is never an overflow (built-in `rate_limit` exclusion) and is relayed with its status, `Retry-After` and body unchanged (`test/proxy/upstream-limits.test.ts:39`). The include_usage retry skips 429 on purpose (`src/proxy/recovery.ts:604-609`).
- The only transport retry is one repeat on a fresh socket when a reused keep-alive socket fails before any response byte (`src/proxy/upstream.ts:11`).

Who it affects: people behind a shared gateway or a rate-limited key, and people running a local server that briefly answers 503 while it loads a model. Coding agents vary a lot in how they handle a 429 or 503. Some back off, some stop the whole session. Kitzur could absorb a short blip that today ends a session.

## 2. Proposed config

```jsonc
"upstream": {
  "retry": {
    "enabled": false,                     // off by default: today's behavior
    "statuses": [429, 502, 503, 504],
    "maxAttempts": 3,                     // total upstream attempts for one transient-retry chain, first included
    "baseDelayMs": 500,                   // delay before attempt n = min(maxDelayMs, baseDelayMs * 2^(n-2))
    "maxDelayMs": 8000,
    "maxTotalDelayMs": 20000,             // cap on all added waiting per client request
    "honorRetryAfter": true,
    "jitter": true,                       // full jitter: uniform in [0, delay]
    "paths": []                           // extra non-chat paths the user declares safe to repeat
  }
}
```

How it fits with `errors.maxRetries`: the two mechanisms do different things. Overflow retries send a smaller request. Transient retries resend the same request. They must not multiply. The proposed rule:

- Apply the transient retry first, per attempt. A 502/503/504 that would also count as a possible overflow is first retried unchanged. Only when the transient budget runs out does it go on to the overflow classifier, as it does today.
- Ceiling: at most `1 + errors.maxRetries + (maxAttempts - 1)` upstream attempts per client request. The transient count is shared across the whole request, not reset after each overflow retry. The stale-socket repeat stays separate and does not count, as it does today.

## 3. Safety rules

1. Never retry after the first response byte reached the client. The retry decision is made before the status and headers are committed.
2. Chat completions are retried. Any other passthrough request is retried only if its path appears in `retry.paths`, whatever its method.
3. Wait at most `maxTotalDelayMs` in total. When the next wait would go past that cap, relay the last error unchanged.
4. `Retry-After` is read as delta-seconds or an HTTP-date. The wait is clamped to `[0, maxDelayMs]`. A value that is missing or can't be parsed falls back to the backoff delay. If the clamped wait would break rule 3, Kitzur gives up at once and relays the error and its header.
5. If the client disconnects during a wait, cancel the wait and send no further attempt. The same `close` handlers that abort the upstream today (`passthrough` in `src/proxy/server.ts:401`, chat in `src/proxy/server.ts:501`) also cancel the timer.
6. Log only the status, attempt number and delay. Never log request or response content.
7. Nothing is learned from a transient retry: no state entry and no tightening.

## 4. Observability

- Stats record (`src/proxy/stats.ts`): `transient_retries` (count) and `transient_retry_delay_ms` (total wait) per request, written only when the request was retried. A per-status breakdown per request was not implemented.
- `/status` (`src/proxy/status.ts`): running totals `transient_retries.retries`, `transient_retries.by_status` and `transient_retries.delay_ms`, plus `transient_retries.exhausted` (how many requests the retry gave up on). The camelCase names first proposed here were never implemented.
- Follow-up: add these field names to the contract in `docs/JSON-OUTPUT.md` in the same change that emits them.

## 5. Test plan

Use the fake upstreams in `test/proxy/harness.ts` (`fakeUpstream`, `jsonRes`, `sseRes`, `startProxy`, `waitRecords`) with small delays:

- Off by default: the existing 429 test in `test/proxy/upstream-limits.test.ts` still passes as it stands.
- 429 then 200: the client gets 200, `up.hits.length === 2`, and the record shows one retry.
- `Retry-After: 1` honored (measure the elapsed time). An HTTP-date in the past gives no wait. A huge value is clamped, or makes Kitzur give up under rule 4.
- Budget used up: three 503s with `maxAttempts: 3` relay the last 503 unchanged, with `exhausted` counted.
- Client aborts during the wait: no further upstream hit, and the record shows the abort.
- Streamed 200 that fails mid-stream: not retried once bytes have been sent.
- Near-budget 503: transient retries come first, and the attempt ceiling defined under Proposed config above is never exceeded.
- Non-chat POST: not retried unless its path is in `retry.paths`.

## 6. Follow-up changes (each under 300 lines)

1. Config: add `upstream.retry` to `src/config/schema.ts` and its validation, a row in `CONFIG.md`, and config tests. No behavior change.
2. Retry loop for chat: a `Retry-After` parser and backoff helper (new `src/proxy/retry.ts`), the hook in `src/proxy/recovery.ts`, abort wiring in `src/proxy/server.ts`, and new `test/proxy/upstream-retry.test.ts`.
3. Passthrough paths: retry for listed non-chat paths in `src/proxy/server.ts` `passthrough`, with tests.
4. Observability: stats fields in `src/proxy/stats.ts`, `/status` totals in `src/proxy/status.ts`, `docs/JSON-OUTPUT.md`, and tests.

## 7. Open questions

- Should 500 be retryable when listed, or should it be rejected in config as too likely to be a real bug?
- Should a 429 that `Retry-After` puts beyond the cap be relayed at once (as proposed) or after waiting the capped time?
- Should the defaults be tuned for local servers (short waits) or shared gateways (longer waits)?
- Should a client header (e.g. `x-kitzur-no-retry`) let an agent with its own retry logic opt out per request?
