import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { BUILTIN_RULES, ErrorClassifier, getPath, overshootOf, validateNumbers, type Classification } from '../../src/proxy/errors.js';
import { SseParser, eventError } from '../../src/proxy/sse.js';
import { inStreamErrorStatus } from '../../src/dialect/openai-chat.js';
import { ERROR_STYLES } from '../../bench/mock/server.js';
import type { ErrorKind } from '../../src/types.js';

const C = new ErrorClassifier(DEFAULT_CONFIG.errors);
const L = 100000, P = 95000, M = 32000, I = L - M;

/** HTTP error, or an SSE frame (status 200) run through the parser like the relay does. */
function classify(status: number, body: string): Classification {
  if (status === 200) {
    const p = new SseParser();
    const evs = p.push(Buffer.from(body + '\n\n'));
    const err = eventError(evs[0]!);
    assert.ok(err, `no in-stream error found in ${body}`);
    return C.classify({ status: inStreamErrorStatus(err.json, 200), body: err.payload, inStream: true });
  }
  return C.classify({ status, body, inStream: false });
}

interface Expect {
  id: string | null;
  kind: ErrorKind;
  window?: number;
  prompt?: number;
  completion?: number;
  lower?: boolean;
  maxInput?: number;
  inMsg?: boolean;
}

// reference implementation (the 32 bodies of tmp/server-quirks/errmap/test_errmap.mjs), with the numbers each must yield
const SAMPLES: Array<[Expect, number, string]> = [
  [{ id: 'vllm.v018.total', kind: 'overflow_total', window: L, prompt: I + 1, completion: M, lower: true }, 400, JSON.stringify({ error: { message: `This model's maximum context length is ${L} tokens. However, you requested ${M} output tokens and your prompt contains at least ${I + 1} input tokens, for a total of at least ${I + 1 + M} tokens. Please reduce the length of the input prompt or the number of requested output tokens.`, type: 'BadRequestError', param: 'input_tokens', code: 400 } })],
  [{ id: 'vllm.v018.total', kind: 'overflow_total', window: L, prompt: P, completion: M, lower: false }, 400, JSON.stringify({ error: { message: `This model's maximum context length is ${L} tokens. However, you requested ${M} output tokens and your prompt contains ${P} input tokens, for a total of ${P + M} tokens (${P} + ${M} = ${P + M} > ${L}). Please reduce the length of the input prompt or the number of requested output tokens.`, type: 'BadRequestError', param: 'max_tokens', code: 400 } })],
  [{ id: 'vllm.v018.chars', kind: 'overflow_total', window: L, completion: M, maxInput: I }, 400, `{"error":{"message":"This model's maximum context length is ${L} tokens. However, you requested ${M} output tokens and your prompt contains 99999999 characters (more than 12345678 characters, which is the upper bound for ${I} input tokens). Please reduce the length of the input prompt or the number of requested output tokens.","type":"BadRequestError","param":"input_text","code":400}}`],
  [{ id: 'vllm.v016.tokens', kind: 'overflow_total', window: L, prompt: I + 1, completion: M, lower: true, maxInput: I }, 400, `{"error":{"message":"You passed ${I + 1} input tokens and requested ${M} output tokens. However, the model's context length is only ${L} tokens, resulting in a maximum input length of ${I} tokens. Please reduce the length of the input prompt.","type":"BadRequestError","param":"input_tokens","code":400}}`],
  [{ id: 'vllm.v016.chars', kind: 'overflow_total', window: L, completion: M }, 400, `{"error":{"message":"You passed 99999999 input characters and requested ${M} output tokens. However, the model's context length is only ${L} tokens, resulting in a maximum input length of ${I} tokens (at most 12345678 characters). Please reduce the length of the input prompt.","type":"BadRequestError","param":"input_text","code":400}}`],
  [{ id: 'vllm.v011.total', kind: 'overflow_total', window: L, prompt: P, completion: M }, 400, `{"error":{"message":"'max_tokens' or 'max_completion_tokens' is too large: ${M}. This model's maximum context length is ${L} tokens and your request has ${P} input tokens (${M} > ${L} - ${P}).","type":"BadRequestError","param":null,"code":400}}`],
  [{ id: 'vllm.v011.prompt', kind: 'overflow_prompt', window: L, prompt: 100500 }, 400, `{"error":{"message":"This model's maximum context length is ${L} tokens. However, your request has 100500 input tokens. Please reduce the length of the input messages.","type":"BadRequestError","param":null,"code":400}}`],
  [{ id: 'vllm.legacy.total', kind: 'overflow_total', window: L, prompt: P, completion: M }, 400, `{"object":"error","message":"This model's maximum context length is ${L} tokens. However, you requested ${P + M} tokens (${P} in the messages, ${M} in the completion). Please reduce the length of the messages or completion.","type":"BadRequestError","param":null,"code":400}`],
  [{ id: 'vllm.legacy.prompt', kind: 'overflow_prompt', window: L, prompt: 100500 }, 400, `{"object":"error","message":"This model's maximum context length is ${L} tokens. However, you requested 100500 tokens in the messages, Please reduce the length of the messages.","type":"BadRequestError","param":null,"code":400}`],
  [{ id: 'vllm.max_tokens_gt_window', kind: 'max_tokens_too_large', window: L, completion: 200000 }, 400, `{"error":{"message":"max_tokens=200000 cannot be greater than max_model_len=${L}. Please request fewer output tokens.","type":"BadRequestError","param":"max_tokens","code":400}}`],
  [{ id: 'vllm.engine.prompt', kind: 'overflow_prompt', window: L, prompt: 100001 }, 400, `{"error":{"message":"The decoder prompt (length 100001) is longer than the maximum model length of ${L}. Make sure that \`max_model_len\` is no smaller than the number of text tokens.","type":"BadRequestError","param":null,"code":400}}`],
  [{ id: 'sglang.total', kind: 'overflow_total', window: L, prompt: P, completion: M }, 400, `{"object":"error","message":"Requested token count exceeds the model's maximum context length of ${L} tokens. You requested a total of ${P + M} tokens: ${P} tokens from the input messages and ${M} tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.","type":"BadRequestError","param":null,"code":400}`],
  [{ id: 'sglang.prompt', kind: 'overflow_prompt', window: L, prompt: 100500 }, 400, `{"object":"error","message":"The input (100500 tokens) is longer than the model's context length (${L} tokens).","type":"BadRequestError","param":null,"code":400}`],
  [{ id: 'sglang.prompt', kind: 'overflow_prompt', window: 8192, prompt: 8391 }, 200, `data: {"error": {"object": "error", "message": "The input (8391 tokens) is longer than the model's context length (8192 tokens).", "type": "BadRequestError", "param": null, "code": 400}}`],
  [{ id: 'sglang.sched', kind: 'overflow_prompt', prompt: 100500, maxInput: 99999 }, 400, `{"object":"error","message":"Input length (100500 tokens) exceeds the maximum allowed length (99999 tokens). Use a shorter input or enable --allow-auto-truncate.","type":"BadRequestError","param":null,"code":400}`],
  [{ id: 'llamacpp.new', kind: 'overflow_prompt', window: L, prompt: 100500 }, 400, `{"error":{"code":400,"message":"request (100500 tokens) exceeds the available context size (${L} tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":100500,"n_ctx":${L}}}`],
  [{ id: 'llamacpp.new.nosplit', kind: 'overflow_prompt', window: L, prompt: 100500 }, 400, `{"error":{"code":400,"message":"input (100500 tokens) is larger than the max context size (${L} tokens). skipping","type":"exceed_context_size_error","n_prompt_tokens":100500,"n_ctx":${L}}}`],
  [{ id: 'llamacpp.old', kind: 'overflow_prompt', window: L, prompt: 100500, inMsg: true }, 400, `{"error":{"code":400,"type":"exceed_context_size_error","message":"the request exceeds the available context size, try increasing it","n_prompt_tokens":100500,"n_ctx":${L}}}`],
  [{ id: 'llamacpp.old', kind: 'overflow_prompt' }, 200, `error: {"code":400,"message":"the request exceeds the available context size. try increasing the context size or enable context shift","type":"invalid_request_error"}`],
  [{ id: 'tgi.total', kind: 'overflow_total', window: L, prompt: 99500, completion: 1024 }, 422, '{"error":"Input validation error: `inputs` tokens + `max_new_tokens` must be <= 100000. Given: 99500 `inputs` tokens and 1024 `max_new_tokens`","error_type":"validation"}'],
  [{ id: 'tgi.total', kind: 'overflow_total', window: L, prompt: 99500, completion: 1024 }, 200, 'data: {"error":{"message":"Input validation error: `inputs` tokens + `max_new_tokens` must be <= 100000. Given: 99500 `inputs` tokens and 1024 `max_new_tokens`","http_status_code":422}}'],
  [{ id: 'tgi.prompt', kind: 'overflow_prompt', prompt: 100500, maxInput: 99999 }, 422, '{"error":"Input validation error: `inputs` must have less than 99999 tokens. Given: 100500","error_type":"validation"}'],
  [{ id: 'lmstudio.keep', kind: 'overflow_prompt', window: 45217, prompt: 50785, lower: true }, 400, `{"error":"Trying to keep the first 50785 tokens when context the overflows. However, the model is loaded with context length of only 45217 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input"}`],
  [{ id: 'ollama.prompt', kind: 'overflow_prompt' }, 400, `{"error":{"message":"the prompt is longer than the context length currently available to the model; shorten the prompt, adjust the context length in settings, or use a model with a longer context length","type":"invalid_request_error","param":null,"code":null}}`],
  [{ id: 'vllm.v018.total', kind: 'overflow_total', window: L, prompt: P, completion: M }, 400, `{"error":{"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: Hosted_vllmException - This model's maximum context length is ${L} tokens. However, you requested ${M} output tokens and your prompt contains ${P} input tokens, for a total of ${P + M} tokens. Please reduce the length of the input prompt or the number of requested output tokens.","type":"invalid_request_error","param":null,"code":"400"}}`],
  [{ id: 'litellm.cwe', kind: 'overflow_unknown' }, 400, `{"error":{"message":"litellm.ContextWindowExceededError: litellm._pre_call_checks: Context Window exceeded for given call. No models have context window large enough for this call.","type":"invalid_request_error","param":null,"code":"400"}}`],
  [{ id: 'http.413', kind: 'payload_too_large' }, 413, '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n'],
  [{ id: 'gateway.5xx', kind: 'gateway_error' }, 502, '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n'],
  [{ id: 'gateway.5xx', kind: 'gateway_error' }, 504, '<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n'],
  // must NOT be overflows
  [{ id: 'stream_options', kind: 'excluded' }, 400, `{"error":{"message":"Stream options can only be defined when \`stream=True\`.","type":"BadRequestError","param":"stream_options","code":400}}`],
  [{ id: 'rate_limit', kind: 'excluded' }, 429, `{"error":{"message":"Rate limit exceeded","type":"rate_limit_error","param":null,"code":"429"}}`],
  [{ id: null, kind: 'unmatched' }, 400, `{"error":{"message":"max_tokens must be at least 1, got 0.","type":"BadRequestError","param":"max_tokens","code":400}}`],
];

test('all 32 bodies of reference implementation classify to the expected entry, kind and numbers', () => {
  assert.equal(SAMPLES.length, 32);
  for (const [want, status, body] of SAMPLES) {
    const c = classify(status, body);
    const tag = `${want.id} (${status})`;
    assert.equal(c.ruleId ?? null, want.id, tag);
    assert.equal(c.kind, want.kind, tag);
    assert.equal(c.window, want.window, `${tag} window`);
    assert.equal(c.promptTokens, want.prompt, `${tag} prompt`);
    if (want.completion !== undefined) assert.equal(c.completionTokens, want.completion, `${tag} completion`);
    if (want.maxInput !== undefined) assert.equal(c.maxInput, want.maxInput, `${tag} maxInput`);
    if (want.prompt !== undefined) assert.equal(c.promptIsLowerBound, want.lower ?? false, `${tag} lower bound`);
    if (want.window !== undefined || want.prompt !== undefined) assert.equal(c.numbersInMessage, true, `${tag} numbers in message`);
    assert.equal(c.inStream, status === 200);
  }
});

test('the bench mock error styles (vllm, llamacpp, tgi422, gateway502) classify with their numbers', () => {
  const ctx = { prompt: 83_000, maxTokens: 32_000, limit: 100_000, body: { messages: [] } };
  const want: Record<string, Partial<Classification> & { kind: ErrorKind }> = {
    vllm: { kind: 'overflow_total', ruleId: 'vllm.legacy.total', window: 100_000, promptTokens: 83_000, completionTokens: 32_000, total: 115_000 },
    llamacpp: { kind: 'overflow_prompt', ruleId: 'llamacpp.old', window: 100_000, promptTokens: 83_000 },
    tgi422: { kind: 'overflow_total', ruleId: 'tgi.total', window: 100_000, promptTokens: 83_000, completionTokens: 32_000 },
    gateway502: { kind: 'gateway_error', ruleId: 'gateway.5xx' },
  };
  for (const [name, style] of ERROR_STYLES) {
    const w = want[name];
    if (!w) continue;
    const e = style(ctx as never);
    const c = C.classify({ status: e.status, body: JSON.stringify(e.body), inStream: false });
    for (const [k, v] of Object.entries(w)) assert.equal((c as unknown as Record<string, unknown>)[k], v, `${name}.${k}`);
  }
  assert.ok(['vllm', 'llamacpp', 'tgi422', 'gateway502'].every((n) => ERROR_STYLES.has(n)));
});

test(': specific texts match any status; generic entries stay status-gated', () => {
  const vllm = `{"error":{"message":"This model's maximum context length is 32768 tokens. However, your request has 40000 input tokens.","code":500}}`;
  assert.equal(C.classify({ status: 500, body: vllm, inStream: false }).ruleId, 'vllm.v011.prompt');
  assert.equal(C.classify({ status: 502, body: vllm, inStream: false }).ruleId, 'vllm.v011.prompt');
  const vague = '{"error":{"message":"context length problem"}}';
  assert.equal(C.classify({ status: 400, body: vague, inStream: false }).kind, 'overflow_suspect');
  assert.equal(C.classify({ status: 500, body: vague, inStream: false }).kind, 'unmatched');
  assert.equal(C.classify({ status: 200, body: vague, inStream: true }).kind, 'unmatched', 'generic entries never match in-stream');
  assert.equal(C.classify({ status: 503, body: 'upstream connect error', inStream: false }).kind, 'gateway_error');
  assert.equal(C.classify({ status: 413, body: '', inStream: false }).kind, 'payload_too_large');
  assert.equal(C.classify({ status: 500, body: 'Internal Server Error', inStream: false }).kind, 'unmatched');
  assert.equal(C.classify({ status: 400, body: '', inStream: false }).kind, 'unmatched');
});

test('exclusions are checked before every rule', () => {
  const body = `{"error":{"message":"rate limit: This model's maximum context length is 100000 tokens. However, your request has 5 input tokens."}}`;
  const c = C.classify({ status: 400, body, inStream: false });
  assert.equal(c.kind, 'excluded');
  assert.equal(c.ruleId, 'rate_limit');
  const custom = new ErrorClassifier({ ...DEFAULT_CONFIG.errors, exclusions: [{ id: 'mine', match: 'E_QUOTA' }] });
  assert.equal(custom.classify({ status: 413, body: 'E_QUOTA', inStream: false }).ruleId, 'mine');
});

test('custom entries run before built-ins; on:"message", json paths, lowerBoundIf, flags', () => {
  const cls = new ErrorClassifier({
    ...DEFAULT_CONFIG.errors,
    custom: [
      { id: 'gw.msg', server: 'gw', status: [400], kind: 'overflow_prompt', on: 'message', match: 'too long: (?<prompt>\\d+) > (?<window>\\d+)' },
      { id: 'gw.json', server: 'gw', status: [418], kind: 'overflow_total', match: 'E_CTX', json: { window: 'detail.limit', prompt: 'detail.got' } },
      { id: 'gw.sse', server: 'gw', status: [null], kind: 'overflow_unknown', match: 'e_ctx', flags: 'i' },
      { id: 'gw.lb', server: 'gw', status: [409], kind: 'overflow_prompt', match: '(?<atLeast>>=)?(?<prompt>\\d+) tok', lowerBoundIf: 'atLeast' },
    ],
  });
  const m = cls.classify({ status: 400, body: '{"error":{"message":"too long: 70000 > 64000"}}', inStream: false });
  assert.deepEqual([m.ruleId, m.promptTokens, m.window, m.numbersInMessage], ['gw.msg', 70000, 64000, true]);
  // on: message does not see echoed text outside the message
  const echo = cls.classify({ status: 400, body: '{"error":{"message":"bad"},"echo":"too long: 1 > 2"}', inStream: false });
  assert.equal(echo.ruleId, undefined);
  const j = cls.classify({ status: 418, body: '{"code":"E_CTX","detail":{"limit":50000,"got":61000}}', inStream: false });
  assert.deepEqual([j.ruleId, j.window, j.promptTokens, j.numbersInMessage], ['gw.json', 50000, 61000, true]);
  assert.equal(cls.classify({ status: 200, body: '{"error":{"message":"E_CTX!"}}', inStream: true }).ruleId, 'gw.sse');
  assert.equal(cls.classify({ status: 400, body: '{"error":{"message":"E_CTX!"}}', inStream: false }).ruleId, undefined, 'gw.sse is in-stream only');
  assert.equal(cls.classify({ status: 409, body: '>=500 tok', inStream: false }).promptIsLowerBound, true);
  assert.equal(cls.classify({ status: 409, body: '500 tok', inStream: false }).promptIsLowerBound, false);
  assert.throws(() => new ErrorClassifier({ ...DEFAULT_CONFIG.errors, custom: [{ id: 'bad', server: 'x', kind: 'overflow_unknown', match: '(' }] }), /bad/);
  const noBuiltin = new ErrorClassifier({ ...DEFAULT_CONFIG.errors, useBuiltin: false });
  assert.equal(noBuiltin.classify({ status: 413, body: '', inStream: false }).kind, 'unmatched');
});

test('numbers only count as "in the message" when the regex matches the extracted message ( (i))', () => {
  // the vLLM text appears only in echoed input, not in error.message
  const body = JSON.stringify({ error: { message: 'Invalid request', type: 'BadRequestError' }, input: "This model's maximum context length is 4096 tokens" });
  const c = C.classify({ status: 400, body, inStream: false });
  assert.equal(c.ruleId, 'vllm.any');
  assert.equal(c.window, 4096);
  assert.equal(c.numbersInMessage, false);
  const v = validateNumbers(c, { configuredWindow: 8000, rejectedRaw: 7000 });
  assert.equal(v.window, null);
  assert.match(v.refused ?? '', /not in the error message/);
});

test('validateNumbers: window range (ii), prompt band (iii), server prompt limits only from non-window bodies', () => {
  const base: Classification = { kind: 'overflow_total', status: 400, inStream: false, numbersInMessage: true, ruleId: 'x' };
  const W = 100_000;
  assert.equal(validateNumbers({ ...base, window: 89_000 }, { configuredWindow: W, rejectedRaw: 90_000 }).window, 89_000);
  assert.equal(validateNumbers({ ...base, window: 100_000 }, { configuredWindow: W, rejectedRaw: 90_000 }).window, null, 'not below configured');
  assert.equal(validateNumbers({ ...base, window: 49_999 }, { configuredWindow: W, rejectedRaw: 90_000 }).window, null, 'below 0.5 W');
  const band = validateNumbers({ ...base, window: 89_000, promptTokens: 60_000, promptIsLowerBound: false }, { configuredWindow: W, rejectedRaw: 90_000 });
  assert.equal(band.window, null, 'prompt 60k vs our 90k is outside [0.8, 1.25]');
  const ok = validateNumbers({ ...base, window: 89_000, promptTokens: 91_000, promptIsLowerBound: false }, { configuredWindow: W, rejectedRaw: 90_000 });
  assert.deepEqual([ok.window, ok.promptExact], [89_000, 91_000]);
  const lb = validateNumbers({ ...base, window: 89_000, promptTokens: 20_000, promptIsLowerBound: true }, { configuredWindow: W, rejectedRaw: 90_000 });
  assert.deepEqual([lb.window, lb.promptLowerBound, lb.promptExact], [89_000, 20_000, null], 'a lower bound is not band-checked');
  assert.equal(validateNumbers({ ...base, ruleId: 'sglang.sched', kind: 'overflow_prompt', maxInput: 60_000 }, { configuredWindow: W, rejectedRaw: 62_000 }).maxPrompt, 60_000);
  assert.equal(validateNumbers({ ...base, ruleId: 'tgi.prompt', kind: 'overflow_prompt', maxInput: 60_000 }, { configuredWindow: W, rejectedRaw: 62_000 }).maxPrompt, 59_999);
  assert.equal(validateNumbers({ ...base, window: 89_000, maxInput: 57_000 }, { configuredWindow: W, rejectedRaw: 62_000 }).maxPrompt, null, "never vLLM's L - M");
});

test('overshoot per body type (§8)', () => {
  const b: Classification = { kind: 'overflow_total', status: 400, inStream: false, numbersInMessage: true, window: 100, promptTokens: 90, completionTokens: 20 };
  assert.equal(overshootOf(b), 10);
  assert.equal(overshootOf({ ...b, kind: 'overflow_prompt' }), -10);
  assert.equal(overshootOf({ ...b, promptIsLowerBound: true }), -10);
  assert.equal(overshootOf({ ...b, window: undefined }), undefined);
});

test('built-in map: specific entries have no status, generic ones do; getPath', () => {
  const generic = new Set(['http.413', 'gateway.5xx', 'generic.suspect']);
  for (const r of BUILTIN_RULES) assert.equal(r.status !== undefined, generic.has(r.id), r.id);
  assert.equal(getPath({ a: { b: [0, { c: 5 }] } }, 'a.b.1.c'), 5);
  assert.equal(getPath({ a: 1 }, 'a.b'), undefined);
});
