// Port of how OpenCode (1.18.33 @03e6717) and Kilo (7.8.1 @7d977bc) classify provider errors, for the
// tests of generated bodies (reference implementation; upstream error handling):
//   HTTP errors  AI SDK message (error.message when the body matches the schema, else statusText)
//                -> OpenCode message() -> overflow if isContextOverflow(m) || status 413 ||
//                body.error.code === "context_length_exceeded"; otherwise retried when the message or
//                the body matches RETRYABLE (/429|500|502|503|504|524/ first) or status >= 500
//   in-stream    the patched SDK hands `chunk.error` to parseStreamError: JSON-parse its message when
//                possible; overflow iff body.type === "error" && body.error.code === "context_length_exceeded"
//                (Kilo normalises envelope-less frames first with frame())
import { STATUS_CODES } from 'node:http';

export const OC_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, /request_too_large/i, /input is too long for requested model/i, /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i, /maximum prompt length is \d+/i, /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i, /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, /exceeds the limit of \d+/i,
  /exceeds the available context size/i, /greater than the context length/i, /context window exceeds limit/i,
  /exceeded model token limit/i, /context[_ ]length[_ ]exceeded/i, /request entity too large/i, /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i, /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i, /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i, /too many tokens/i, /token limit exceeded/i,
];
const OC_EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i];
const KILO_EXCLUSIONS = [...OC_EXCLUSIONS, /(?:too many tokens|token limit exceeded).*(?:wait|try again|retry after)/i];

/** OpenCode's first retryable-message pattern (retry.ts:33): no word boundaries. */
export const OC_RETRY_RUNS = /429|500|502|503|504|524/i;

export type Client = 'opencode' | 'kilo';

const isContextOverflow = (client: Client, m: string): boolean =>
  !(client === 'kilo' ? KILO_EXCLUSIONS : OC_EXCLUSIONS).some((p) => p.test(m)) &&
  (OC_PATTERNS.some((p) => p.test(m)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(m));

function aiSdkMessage(statusText: string, body: string): string {
  if (body.trim() === '') return statusText;
  try {
    const j = JSON.parse(body) as { error?: unknown };
    const e = j?.error as Record<string, unknown> | undefined;
    const ok = e && typeof e === 'object' && !Array.isArray(e) && typeof e['message'] === 'string' &&
      (e['type'] == null || typeof e['type'] === 'string') && (e['code'] == null || typeof e['code'] === 'string' || typeof e['code'] === 'number');
    if (ok) return e['message'] as string;
  } catch {
    /* not JSON */
  }
  return statusText;
}

function ocMessage(status: number, msg: string, responseBody: string): string {
  if (msg === '') return responseBody ? responseBody.trim() : STATUS_CODES[status] ?? 'Unknown error';
  if (!responseBody || (status && msg !== STATUS_CODES[status])) return msg.trim();
  try {
    const body = JSON.parse(responseBody) as { message?: unknown; error?: unknown };
    const errMsg = body.message || body.error || (body.error as { message?: unknown } | undefined)?.message;
    if (errMsg && typeof errMsg === 'string') return `${msg}: ${errMsg}`.trim();
  } catch {
    /* not JSON */
  }
  if (/^\s*<!doctype|^\s*<html/i.test(responseBody)) return msg.trim();
  return `${msg}: ${responseBody}`.trim();
}

export interface HttpVerdict {
  overflow: boolean;
  /** not an overflow, and OpenCode would retry it (status >= 500, 408/409/429, or a retryable message/body) */
  retried: boolean;
  message: string;
}

/** How the client classifies an HTTP error response. */
export function classifyHttpError(client: Client, status: number, body: string): HttpVerdict {
  const m = ocMessage(status, aiSdkMessage(STATUS_CODES[status] ?? '', body), body);
  let parsed: { error?: { code?: unknown } } | undefined;
  try {
    parsed = JSON.parse(body) as { error?: { code?: unknown } };
  } catch {
    parsed = undefined;
  }
  const overflow = isContextOverflow(client, m) || status === 413 || parsed?.error?.code === 'context_length_exceeded';
  const retried = !overflow && (status === 408 || status === 409 || status === 429 || status >= 500 || OC_RETRY_RUNS.test(m) || OC_RETRY_RUNS.test(body));
  return { overflow, retried, message: m };
}

const jsonObj = (x: unknown): Record<string, unknown> | undefined => {
  if (typeof x === 'string') {
    try {
      const r = JSON.parse(x) as unknown;
      return r && typeof r === 'object' ? (r as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : undefined;
};

/** Kilo's frame(): normalises envelope-less stream error frames (kilocode/provider/error.ts). */
function kiloFrame(body: Record<string, unknown>): Record<string, unknown> {
  const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  const payloadOk = (p: unknown): boolean =>
    isRec(p) && (p['code'] == null || typeof p['code'] === 'string' || typeof p['code'] === 'number') && (p['message'] == null || typeof p['message'] === 'string');
  if (body['type'] === 'response.failed' && isRec(body['response']) && payloadOk((body['response'] as Record<string, unknown>)['error']))
    return { type: 'error', error: (body['response'] as Record<string, unknown>)['error'] };
  if (body['type'] === undefined && payloadOk(body['error'])) return { ...body, type: 'error' };
  if (body['type'] === undefined && (body['code'] === null || typeof body['code'] === 'string' || typeof body['code'] === 'number') && typeof body['message'] === 'string')
    return { ...body, type: 'error', error: body };
  return { ...body, error: isRec(body['error']) ? body['error'] : undefined };
}

/**
 * The stream-error verdict for one SSE data payload `{"error": {...}}`: the patched SDK passes
 * `chunk.error` to parseStreamError. Returns 'overflow', 'api_error' or 'unknown' (NamedError.Unknown).
 */
export function classifyStreamError(client: Client, dataPayload: string): 'overflow' | 'api_error' | 'unknown' {
  const chunk = jsonObj(dataPayload);
  const e = chunk?.['error'];
  const raw = jsonObj(e);
  if (!raw) return 'unknown';
  const original = typeof raw['message'] === 'string' ? (jsonObj(raw['message']) ?? raw) : raw;
  const body = client === 'kilo' ? kiloFrame(original) : original;
  if (body['type'] !== 'error') return 'unknown';
  const code = (body['error'] as Record<string, unknown> | undefined)?.['code'];
  return code === 'context_length_exceeded' ? 'overflow' : 'api_error';
}
