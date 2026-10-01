// Error bodies the engine generates (DESIGN.md/(c), §5.8 guard_reject; ).
//
// Numbers print as one-decimal thousands ("26.0k"). OpenCode retries any error whose message or body
// contains 429/500/502/503/504/524 as a substring (retry.ts:33, 88-98), so a printed number whose
// integer part contains such a run is lowered to the largest one-decimal value whose integer part does
// not (500.0k -> 499.9k, 429.5k -> 428.9k). The fixed-prompt text avoids every OpenCode overflow
// pattern (reference implementation), so neither client starts a compaction loop on it.

/** OpenCode's retry trigger (retry.ts:33): a generated body must never match it. */
export const OPENCODE_RETRY_RE = /429|500|502|503|504|524/;

/** One-decimal thousands, avoiding OPENCODE_RETRY_RE runs in the integer part. */
export function fmtK(n: number): string {
  let t = Math.max(0, Math.round(n / 100)); // tenths of a thousand
  for (;;) {
    const ip = Math.floor(t / 10);
    if (!OPENCODE_RETRY_RE.test(String(ip))) break;
    t = ip * 10 - 1; // the largest value below with a smaller integer part: (ip-1).9
  }
  return `${Math.floor(t / 10)}.${t % 10}k`;
}

export interface ErrorBody {
  error: { message: string; type: string; param: null; code: string };
}

const body = (message: string, code: string): ErrorBody => ({
  error: { message, type: 'invalid_request_error', param: null, code },
});

const reserving = (reserve: number): string => (reserve > 0 ? ` after reserving ${fmtK(reserve)} for the reply` : '');

/**
 * §5.7 (b): system prompt + tools alone do not fit the server limit. `need` = their count, `fit` = the
 * most that fits (W − margin − tighten − reserve), `reserve` = the reply reservation used in the test.
 */
export function fixedPromptTooLarge(need: number, fit: number, window: number, reserve: number): ErrorBody {
  return body(
    `kitzur: the system prompt and tool definitions alone need about ${fmtK(need)} tokens, but at most ${fmtK(Math.max(0, fit))} ` +
      `fit in this model's window (${fmtK(window)})${reserving(reserve)}. Remove tools or MCP servers, or shorten the system prompt.`,
    'kitzur_fixed_prompt_too_large',
  );
}

/**
 * §5.7 (c) and the guard's reject (§5.8): the request cannot be made to fit; the client should compact
 * (OpenCode and Kilo recognise the context_length_exceeded code).
 */
export function contextLengthExceeded(need: number, fit: number, window: number, reserve: number): ErrorBody {
  return body(
    `kitzur: this conversation needs about ${fmtK(need)} tokens even after compaction, but at most ${fmtK(Math.max(0, fit))} ` +
      `fit in this model's window (${fmtK(window)})${reserving(reserve)}. The conversation must be compacted.`,
    'context_length_exceeded',
  );
}
