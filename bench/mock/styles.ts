// Error styles of the bench mock (bench/README.md§7.2).
//
// Two families share one registry (ERROR_STYLES, keyed by registry name):
//  - the 4 byte-exact Python styles of mock_server.py, under their Python `--error-style` names `vllm`, `llamacpp`,
//    `gateway502`, `tgi422` (ErrorStyleId `python-*`). Their bodies are serialized with Python json.dumps by the
//    server and are unchanged, so the cross-check (benchmark contract ) is unaffected;
//  - the §7 styles, with bodies in the exact formats of the samples of reference implementation
//    (upstream reference: compact JSON as the servers write it, nginx HTML pages).
//    Three of them share a Python name, so they are registered as `llamacpp-main`, `tgi422-router`,
//    `gateway502-nginx`; `resolveErrorStyle()` maps an ErrorStyleId to its registry key.
//
// A style answers ONE rejected request. Which requests are rejected is decided by the server from the limit mode
// (STYLE_LIMIT_MODE gives each style's default, benchmark contract ) and `maxBodyBytes` (413). A style may return an
// in-stream variant (`inStream`: the full SSE text after an HTTP 200), used when MockOptions.inStreamErrors is set
// and always by `sse-inline`.
//
// Numbers printed follow each server's source (reference implementation):
//  - vLLM ≥0.18 truncates tokenization at max_input+1, so its overflow text reports "at least {L−M+1}" input
//    tokens, never the real prompt (a lower bound; kitzur must not calibrate from it);
//  - vLLM ≤0.10 and SGLang print the exact prompt; P ≥ L gets their prompt-only message;
//  - llama.cpp (main) checks prompt ≥ n_ctx only and reports n_prompt_tokens / n_ctx;
//  - TGI checks prompt + min(max_tokens, 1024) and prints the capped number;
//  - LiteLLM wraps the vLLM text (the sample's exact-prompt wording) with a string `code`.

import type { ErrorStyleId, MockOptions } from '../scenarios/types.js';
import type { RenderBody } from '../lib/render.js';

export type LimitMode = MockOptions['limitMode'];

export interface LengthErrorContext {
  /** the server's prompt count (hidden overhead included) */
  prompt: number;
  /** max_tokens or max_completion_tokens as the Python mock reads it (0 when absent) */
  maxTokens: number;
  /** the server's real limit (W − limitSkewTokens) */
  limit: number;
  body: RenderBody;
  /** the request asked for a stream */
  stream?: boolean;
}

export interface ErrorResponse {
  status: number;
  /** a JSON value serialized with Python json.dumps (the Python styles) */
  body: unknown;
  /** exact body text; wins over `body` */
  raw?: string;
  /** default application/json */
  contentType?: string;
  /** SSE text sent after an HTTP 200 instead of the status (in-stream error); null = the style has none */
  inStream?: string | null;
  /** the status carried inside an in-stream error */
  inStreamStatus?: number;
}

export type ErrorStyle = (ctx: LengthErrorContext) => ErrorResponse;

// ---------------------------------------------------------------- the 4 Python styles (mock_server.context_error)

/** mock_server.context_error, one entry per --error-style (plus the §7 styles registered below). */
export const ERROR_STYLES = new Map<string, ErrorStyle>([
  [
    'vllm',
    ({ prompt, maxTokens, limit }) => ({
      status: 400,
      body: {
        object: 'error', type: 'BadRequestError', param: null, code: 400,
        message:
          `This model's maximum context length is ${limit} tokens. However, you ` +
          `requested ${prompt + maxTokens} tokens (${prompt} in the messages, ${maxTokens} in the ` +
          `completion). Please reduce the length of the messages or completion.`,
      },
    }),
  ],
  [
    'llamacpp',
    ({ prompt, limit }) => ({
      status: 400,
      body: {
        error: {
          code: 400, type: 'exceed_context_size_error',
          message: 'the request exceeds the available context size, try increasing it',
          n_prompt_tokens: prompt, n_ctx: limit,
        },
      },
    }),
  ],
  ['gateway502', () => ({ status: 502, body: { error: { type: 'upstream_error', message: 'Upstream model server returned an error' } } })],
  [
    'tgi422',
    ({ prompt, maxTokens, limit }) => ({
      status: 422,
      body: {
        error_type: 'validation',
        error:
          'Input validation error: `inputs` tokens + `max_new_tokens` must be <= ' +
          `${limit}. Given: ${prompt} \`inputs\` tokens and ${maxTokens} \`max_new_tokens\``,
      },
    }),
  ],
]);

export function registerErrorStyle(name: string, style: ErrorStyle, limitMode: LimitMode = 'strict_total'): void {
  ERROR_STYLES.set(name, style);
  STYLE_LIMIT_MODE.set(name, limitMode);
}

// ---------------------------------------------------------------- §7 styles

export const NGINX_413 =
  '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
export const NGINX_502 =
  '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
export const UNKNOWN_400_BODY = 'E_UPSTREAM_7: request refused';

const HTML = 'text/html';
const sse = (payload: string, done: boolean): string => `data: ${payload}\n\n` + (done ? 'data: [DONE]\n\n' : '');
const json = (v: unknown): string => JSON.stringify(v);

/** The field name vLLM puts in its max-tokens messages. */
const maxParam = (body: RenderBody): string =>
  body['max_completion_tokens'] !== undefined && body['max_completion_tokens'] !== null ? 'max_completion_tokens' : 'max_tokens';

/** vLLM ≥0.18 (renderers/params.py): the text of an overflow rejection. */
export function vllm018Message({ prompt, maxTokens, limit, body }: LengthErrorContext): { message: string; param: string | null } {
  if (maxTokens > limit)
    return { message: `${maxParam(body)}=${maxTokens} cannot be greater than max_model_len=${limit}. Please request fewer output tokens.`, param: maxParam(body) };
  if (maxTokens <= 0) {
    // no max_tokens: the default is "all remaining context"; the engine rejects a prompt that fills the window
    const plus = prompt === limit ? ' plus the number of requested output tokens (at least 1)' : '';
    return {
      message: `The decoder prompt (length ${prompt})${plus} is longer than the maximum model length of ${limit}. Make sure that \`max_model_len\` is no smaller than the number of text tokens.`,
      param: null,
    };
  }
  const maxInput = limit - maxTokens;
  // tokenization stops at max_input + 1, so the printed prompt is a lower bound
  const shown = Math.min(prompt, maxInput + 1);
  const q = shown === maxInput + 1 ? 'at least ' : '';
  return {
    message:
      `This model's maximum context length is ${limit} tokens. However, you requested ${maxTokens} output tokens and your prompt contains ` +
      `${q}${shown} input tokens, for a total of ${q}${shown + maxTokens} tokens. Please reduce the length of the input prompt or the number of requested output tokens.`,
    param: 'input_tokens',
  };
}

const vllm018: ErrorStyle = (ctx) => {
  const { message, param } = vllm018Message(ctx);
  const err = { message, type: 'BadRequestError', param, code: 400 };
  return { status: 400, body: null, raw: json({ error: err }), inStream: sse(json({ error: err }), true), inStreamStatus: 400 };
};

const vllmLegacy: ErrorStyle = ({ prompt, maxTokens, limit }) => {
  const message =
    prompt >= limit
      ? `This model's maximum context length is ${limit} tokens. However, you requested ${prompt} tokens in the messages, Please reduce the length of the messages.`
      : `This model's maximum context length is ${limit} tokens. However, you requested ${prompt + maxTokens} tokens (${prompt} in the messages, ${maxTokens} in the completion). Please reduce the length of the messages or completion.`;
  const err = { object: 'error', message, type: 'BadRequestError', param: null, code: 400 };
  return { status: 400, body: null, raw: json(err), inStream: sse(json({ error: err }), true), inStreamStatus: 400 };
};

const sglang: ErrorStyle = ({ prompt, maxTokens, limit }) => {
  const message =
    prompt >= limit
      ? `The input (${prompt} tokens) is longer than the model's context length (${limit} tokens).`
      : `Requested token count exceeds the model's maximum context length of ${limit} tokens. You requested a total of ${prompt + maxTokens} tokens: ${prompt} tokens from the input messages and ${maxTokens} tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.`;
  const err = { object: 'error', message, type: 'BadRequestError', param: null, code: 400 };
  // before PR #21900 SGLang streamed the error with Python json.dumps separators (the in-stream sample)
  const spaced = `{"error": {"object": "error", "message": ${JSON.stringify(message)}, "type": "BadRequestError", "param": null, "code": 400}}`;
  return { status: 400, body: null, raw: json(err), inStream: sse(spaced, true), inStreamStatus: 400 };
};

const llamacppMain: ErrorStyle = ({ prompt, limit }) => {
  const err = {
    code: 400, message: `request (${prompt} tokens) exceeds the available context size (${limit} tokens), try increasing it`,
    type: 'exceed_context_size_error', n_prompt_tokens: prompt, n_ctx: limit,
  };
  // llama.cpp main ends the stream after the error event: no [DONE]
  return { status: 400, body: null, raw: json({ error: err }), inStream: sse(json({ error: err }), false), inStreamStatus: 400 };
};

/** TGI's validation text (router/src/validation.rs): total check first, then the input-length check. */
export function tgiMessage({ prompt, maxTokens, limit }: LengthErrorContext): string {
  const m = maxTokens > 0 ? Math.min(maxTokens, 1024) : 0;
  if (prompt + m > limit)
    return `Input validation error: \`inputs\` tokens + \`max_new_tokens\` must be <= ${limit}. Given: ${prompt} \`inputs\` tokens and ${m} \`max_new_tokens\``;
  return `Input validation error: \`inputs\` must have less than ${limit - 1} tokens. Given: ${prompt}`;
}

const tgiRouter: ErrorStyle = (ctx) => {
  const message = tgiMessage(ctx);
  return {
    status: 422, body: null, raw: json({ error: message, error_type: 'validation' }),
    inStream: sse(json({ error: { message, http_status_code: 422 } }), true), inStreamStatus: 422,
  };
};

const litellm: ErrorStyle = ({ prompt, maxTokens, limit }) => {
  const err = {
    message:
      'litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: Hosted_vllmException - ' +
      `This model's maximum context length is ${limit} tokens. However, you requested ${maxTokens} output tokens and your prompt contains ${prompt} input tokens, for a total of ${prompt + maxTokens} tokens. Please reduce the length of the input prompt or the number of requested output tokens.`,
    type: 'invalid_request_error', param: null, code: '400',
  };
  return { status: 400, body: null, raw: json({ error: err }), inStream: sse(json({ error: err }), true), inStreamStatus: 400 };
};

const gatewayNginx: ErrorStyle = () => ({ status: 502, body: null, raw: NGINX_502, contentType: HTML, inStream: null });
const unknown400: ErrorStyle = () => ({ status: 400, body: null, raw: UNKNOWN_400_BODY, contentType: 'text/plain; charset=utf-8', inStream: null });
/** A token overflow under the http413 style (bytes over maxBodyBytes get NGINX_413 from the server). */
const http413Tokens: ErrorStyle = (ctx) => ({ ...vllm018(ctx), inStream: null });
const late400: ErrorStyle = (ctx) => ({ ...vllm018(ctx), inStream: null });
/** HTTP 200 whose first event is the vLLM error (stream requests); a plain vLLM 400 otherwise. */
const sseInline: ErrorStyle = (ctx) => vllm018(ctx);

/** The response to a body over maxBodyBytes (any style): nginx's 413 page. */
export const PAYLOAD_TOO_LARGE: ErrorResponse = { status: 413, body: null, raw: NGINX_413, contentType: HTML, inStream: null };

/** Default limit mode per registry key (§7.2); the Python styles keep the Python mock's strict check. */
export const STYLE_LIMIT_MODE = new Map<string, LimitMode>([
  ['vllm', 'strict_total'], ['llamacpp', 'strict_total'], ['gateway502', 'strict_total'], ['tgi422', 'strict_total'],
]);

for (const [key, style, mode] of [
  ['vllm-legacy', vllmLegacy, 'strict_total'],
  ['vllm-018', vllm018, 'strict_total'],
  ['sglang', sglang, 'strict_total'],
  ['llamacpp-main', llamacppMain, 'prompt_only'],
  ['tgi422-router', tgiRouter, 'tgi'],
  ['litellm', litellm, 'strict_total'],
  ['http413', http413Tokens, 'strict_total'],
  ['gateway502-nginx', gatewayNginx, 'strict_total'],
  ['sse-inline', sseInline, 'strict_total'],
  ['late400', late400, 'strict_total'],
  ['unknown400', unknown400, 'strict_total'],
] as Array<[string, ErrorStyle, LimitMode]>)
  registerErrorStyle(key, style, mode);

/** ErrorStyleId → registry key. */
export const STYLE_KEY: Readonly<Record<ErrorStyleId, string>> = {
  'python-vllm': 'vllm', 'python-llamacpp': 'llamacpp', 'python-gateway502': 'gateway502', 'python-tgi422': 'tgi422',
  'vllm-legacy': 'vllm-legacy', 'vllm-018': 'vllm-018', sglang: 'sglang', llamacpp: 'llamacpp-main', tgi422: 'tgi422-router',
  litellm: 'litellm', http413: 'http413', gateway502: 'gateway502-nginx', 'sse-inline': 'sse-inline', late400: 'late400',
  unknown400: 'unknown400',
};

export const resolveErrorStyle = (id: ErrorStyleId): string => STYLE_KEY[id];

/** Styles that always answer a stream request in-stream (not only with MockOptions.inStreamErrors). */
export const ALWAYS_IN_STREAM: ReadonlySet<string> = new Set(['sse-inline']);
/** Styles whose rejections are delayed by 20 s unless MockOptions.headerDelayMs says otherwise (). */
export const DEFAULT_HEADER_DELAY_MS: ReadonlyMap<string, number> = new Map([['late400', 20_000]]);
/** Python styles: their limit check stays `prompt + max_tokens > limit` exactly (no M = 0 refinement). */
export const PYTHON_STYLES: ReadonlySet<string> = new Set(['vllm', 'llamacpp', 'gateway502', 'tgi422']);
