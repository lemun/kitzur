// OpenAI Chat Completions dialect (DESIGN.md "Dialect serialization", §3, §5.7, §9, ).
//
//  - parse: JSON.parse keeps the client's key order; every integer outside Number.isSafeInteger is
//    flagged (such a body is never rewritten). The check visits exactly the number values a JSON.parse
//    reviver would see, but as a walk of the parsed value after the parse: ~0.1 ms on a 300 KB body,
//    where a reviver (or a regex pre-scan of the text) costs several ms on the request path.
//  - serialize: JSON.stringify of the (rewritten) request. An unchanged request is forwarded as the
//    client's original bytes by the caller, never re-serialized.
//  - usage/finish tap for JSON bodies and SSE chunks.
//  - client-facing error bodies in the OpenAI shape, including the one in-stream overflow shape that
//    OpenCode and Kilo recognise (). Numbers in generated text use formatK (§5.7).
import type { ChatMessage, ChatRequest, Usage } from '../types.js';
import { canonicalJSON } from '../tokenize/canonical.js';
import type { Dialect, ParseResult, ResponseTap } from './dialect.js';

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

// ---------------------------------------------------------------- routing

/** Any path ending in /chat/completions (any prefix, trailing slashes ignored), method POST. */
export function isChatCompletionsPath(method: string, pathname: string): boolean {
  if (method !== 'POST') return false;
  let p = pathname;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.endsWith('/chat/completions');
}

// ---------------------------------------------------------------- parse / serialize

/** true when any number in the parsed value is an integer outside Number.isSafeInteger, or non-finite (1e400 parses
 *  to Infinity and would re-serialize as null) (). */
export function hasUnsafeInteger(v: unknown): boolean {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || (Number.isInteger(x) && !Number.isSafeInteger(x))) return true;
    } else if (typeof x === 'object' && x !== null) {
      if (Array.isArray(x)) for (let i = 0; i < x.length; i++) stack.push(x[i]);
      else for (const k in x) stack.push((x as Json)[k]);
    }
  }
  return false;
}

/**
 * Parses a Chat Completions body. Fails (the caller forwards the bytes unchanged) unless the body is a
 * JSON object whose `messages` is an array of objects.
 */
export function parseChatRequest(raw: Buffer): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const unsafeInteger = hasUnsafeInteger(value);
  if (!isObj(value)) return { ok: false, reason: 'not_an_object' };
  const msgs = value['messages'];
  if (!Array.isArray(msgs)) return { ok: false, reason: 'no_messages' };
  for (const m of msgs) if (!isObj(m)) return { ok: false, reason: 'message_not_an_object' };
  return { ok: true, value: { req: value as unknown as ChatRequest, raw, unsafeInteger } };
}

/** A changed request is serialized with JSON.stringify, keeping key order (). */
export function serializeChatRequest(req: ChatRequest): Buffer {
  return Buffer.from(JSON.stringify(req), 'utf8');
}

export const openAiChatDialect: Dialect = {
  name: 'openai-chat',
  matches: isChatCompletionsPath,
  parse: parseChatRequest,
  serialize: serializeChatRequest,
};

// ---------------------------------------------------------------- request fields

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** T_req (§3): the max of the defined, positive max_tokens / max_completion_tokens; else the default. */
export function requestMaxTokens(req: ChatRequest, defaultMaxTokens: number): number {
  const a = positive(req.max_tokens) ? req.max_tokens : 0;
  const b = positive(req.max_completion_tokens) ? req.max_completion_tokens : 0;
  const m = Math.max(a, b);
  return m > 0 ? m : defaultMaxTokens;
}

/** The max-tokens fields the client sent (numbers only; null counts as not sent). */
export function maxTokensFieldsSent(req: ChatRequest): MaxTokensField[] {
  const f: MaxTokensField[] = [];
  if (typeof req.max_tokens === 'number') f.push('max_tokens');
  if (typeof req.max_completion_tokens === 'number') f.push('max_completion_tokens');
  return f;
}

/**
 * A copy of `req` whose max-tokens value is `value`: every field the client sent is set and none is
 * added; with neither sent, max_tokens is added (§3 "Forwarded max_tokens"). Key order is kept.
 */
export function withMaxTokens(req: ChatRequest, value: number, fields?: readonly MaxTokensField[]): ChatRequest {
  let fs = fields && fields.length ? fields : maxTokensFieldsSent(req);
  if (!fs.length) fs = ['max_tokens'];
  const out: ChatRequest = { ...req };
  for (const f of fs) out[f] = value;
  return out;
}

/** true when the request streams (`stream === true`; include_usage is injected only then, §9). */
export const isStreaming = (req: ChatRequest): boolean => req.stream === true;

/** true when the client itself asked for the stream usage chunk. */
export const clientWantsUsage = (req: ChatRequest): boolean =>
  isObj(req.stream_options) && req.stream_options['include_usage'] === true;

/** A copy with stream_options.include_usage = true (other stream_options keys kept, key order kept). */
export function withIncludeUsage(req: ChatRequest): ChatRequest {
  const so = isObj(req.stream_options) ? req.stream_options : {};
  return { ...req, stream_options: { ...so, include_usage: true } };
}

/**
 * bytes(x) of §3: bytes(JSON.stringify(messages)) + fixedBytes, fixedBytes = bytes(canonical tools) + 512.
 * The max_tokens fields are not part of it, so a max_tokens rewrite never makes a request larger.
 */
export function requestBytes(req: ChatRequest): number {
  const tools = req.tools === undefined ? 0 : Buffer.byteLength(canonicalJSON(req.tools), 'utf8');
  return Buffer.byteLength(JSON.stringify(req.messages), 'utf8') + tools + 512;
}

// ---------------------------------------------------------------- responses: usage, finish, errors

/** error.message ?? error-as-string ?? message ( `on: 'message'`,  (i)). */
export function extractErrorMessage(json: unknown): string | undefined {
  if (!isObj(json)) return undefined;
  const e = json['error'];
  if (isObj(e) && typeof e['message'] === 'string') return e['message'];
  if (typeof e === 'string') return e;
  if (typeof json['message'] === 'string') return json['message'];
  return undefined;
}

/** The last non-null finish_reason among `choices`. */
function finishOf(json: Json): string | null {
  const ch = json['choices'];
  if (!Array.isArray(ch)) return null;
  let fr: string | null = null;
  for (const c of ch) if (isObj(c) && typeof c['finish_reason'] === 'string') fr = c['finish_reason'];
  return fr;
}

/** Usage and finish reason of a complete non-stream response body (null fields when absent). */
export function tapJsonBody(text: string): ResponseTap {
  try {
    const j = JSON.parse(text) as unknown;
    if (!isObj(j)) return { usage: null, finishReason: null };
    return { usage: isObj(j['usage']) ? (j['usage'] as Usage) : null, finishReason: finishOf(j) };
  } catch {
    return { usage: null, finishReason: null };
  }
}

/** What one SSE data payload (a chunk object) carries. */
export interface ChunkInfo {
  usage: Usage | null;
  finishReason: string | null;
  /** `choices: []` plus a usage object: the extra chunk include_usage produces (stripped when injected) */
  usageOnly: boolean;
  /** a top-level `error` key: an in-stream error (§9) */
  error: boolean;
}

export function inspectChunk(json: unknown): ChunkInfo {
  if (!isObj(json)) return { usage: null, finishReason: null, usageOnly: false, error: false };
  const usage = isObj(json['usage']) ? (json['usage'] as Usage) : null;
  const ch = json['choices'];
  return {
    usage,
    finishReason: finishOf(json),
    usageOnly: usage !== null && Array.isArray(ch) && ch.length === 0,
    error: 'error' in json && json['error'] !== null && json['error'] !== undefined,
  };
}

/**
 * HTTP status an in-stream error carries: error.code (number or numeric string), then
 * error.http_status_code (TGI), then top-level code (llama.cpp `error:` frames), else the HTTP status.
 */
export function inStreamErrorStatus(json: unknown, httpStatus: number): number {
  const asStatus = (x: unknown): number | null => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d{3}$/.test(x.trim()) ? Number(x) : NaN;
    return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
  };
  if (isObj(json)) {
    const e = json['error'];
    if (isObj(e)) return asStatus(e['code']) ?? asStatus(e['http_status_code']) ?? httpStatus;
    return asStatus(json['code']) ?? httpStatus;
  }
  return httpStatus;
}

// ---------------------------------------------------------------- generated errors

/** OpenCode retries any error whose message or body contains one of these runs (retry.ts:33). */
export const CLIENT_RETRY_RUNS = /429|500|502|503|504|524/;

const FORMATK_MAX = 999_999_999_999_000;

/**
 * One-decimal thousands for generated text (§5.7): 26,000 -> "26.0k". When the integer part contains a
 * run that OpenCode's retry pattern matches, the largest lower one-decimal value whose integer part
 * does not is printed instead (500,000 -> "499.9k"): the numbers are "about" anyway.
 */
export function formatK(n: number): string {
  // clamped so the integer part stays a safe integer printed without an exponent (a client may send
  // max_tokens: 1e300; "1e+297.1.16e+282k" is not a number)
  let tenths = Math.round(Math.min(FORMATK_MAX, Math.max(0, Number.isFinite(n) ? n : 0)) / 100);
  let int = Math.floor(tenths / 10);
  while (CLIENT_RETRY_RUNS.test(String(int))) {
    int -= 1;
    tenths = int * 10 + 9;
  }
  return `${int}.${tenths - int * 10}k`;
}

/** An OpenAI-shaped error body. */
export function errorBody(message: string, type: string, code: string | null, param: string | null = null): Buffer {
  return Buffer.from(JSON.stringify({ error: { message, type, param, code } }), 'utf8');
}

/** The 400 body both clients treat as a context overflow (they compact and start a new chain). */
export function contextLengthExceededBody(message: string): Buffer {
  return errorBody(message, 'invalid_request_error', 'context_length_exceeded');
}

/**
 * The in-stream overflow report for an already committed 200 (): the only shape OpenCode's
 * parseStreamError and Kilo's frame() recognise (a JSON `{type:"error", error:{code}}` inside
 * error.message), followed by `data: [DONE]`.
 */
export function inStreamOverflowEvents(message: string): Buffer {
  const inner = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'context_length_exceeded', message } });
  const outer = JSON.stringify({ error: { message: inner, type: 'invalid_request_error', param: null, code: 'context_length_exceeded' } });
  return Buffer.from(`data: ${outer}\n\ndata: [DONE]\n\n`, 'utf8');
}

/** §9: upstream unavailable before any response header (HTTP 502). */
export function upstreamUnavailableBody(): Buffer {
  return Buffer.from('{"error":{"message":"kitzur: upstream unavailable","type":"api_error","code":"upstream_unavailable"}}', 'utf8');
}

/**
 * An in-stream error event for an upstream HTTP error that arrived after the client's 200 was
 * committed (a retry's error): `data: {"error":{message,type,code}}` then `data: [DONE]`.
 */
export function inStreamErrorEvents(status: number, message: string): Buffer {
  const ev = JSON.stringify({ error: { message, type: status >= 500 ? 'api_error' : 'invalid_request_error', param: null, code: status } });
  return Buffer.from(`data: ${ev}\n\ndata: [DONE]\n\n`, 'utf8');
}

// ---------------------------------------------------------------- misc helpers

/** Image parts of a message's content (the §5.4 R4 / §8 413 rule counts their bytes). */
export function imageParts(m: ChatMessage): unknown[] {
  const c = m.content;
  if (!Array.isArray(c)) return [];
  return c.filter((p) => isObj(p) && (p['type'] === 'image_url' || p['type'] === 'input_image' || p['type'] === 'image'));
}
