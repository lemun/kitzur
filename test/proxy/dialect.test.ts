import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_RETRY_RUNS, clientWantsUsage, contextLengthExceededBody, errorBody, extractErrorMessage, formatK, inStreamErrorStatus,
  inStreamOverflowEvents, inspectChunk, isChatCompletionsPath, maxTokensFieldsSent, parseChatRequest, requestBytes, requestMaxTokens,
  serializeChatRequest, tapJsonBody, upstreamUnavailableBody, withIncludeUsage, withMaxTokens,
} from '../../src/dialect/openai-chat.js';
import { overflowMessage, refuseMessage } from '../../src/proxy/recovery.js';
import { classifyHttpError, classifyStreamError, OC_RETRY_RUNS, type Client } from './opencode-port.js';
import type { ChatRequest } from '../../src/types.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

test('chat path: any prefix, trailing slash, POST only', () => {
  assert.ok(isChatCompletionsPath('POST', '/v1/chat/completions'));
  assert.ok(isChatCompletionsPath('POST', '/api/openai/v1/chat/completions/'));
  assert.ok(isChatCompletionsPath('POST', '/chat/completions'));
  assert.ok(!isChatCompletionsPath('GET', '/v1/chat/completions'));
  assert.ok(!isChatCompletionsPath('POST', '/v1/completions'));
  assert.ok(!isChatCompletionsPath('POST', '/v1/chat/completions/extra'));
});

test('parse keeps key order; serialize is JSON.stringify of the same order', () => {
  const text = '{"model":"m","zeta":1,"messages":[{"role":"user","content":"hi","b":1,"a":2}],"alpha":{"y":1,"x":2}}';
  const r = parseChatRequest(buf(text));
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value.req), ['model', 'zeta', 'messages', 'alpha']);
  assert.deepEqual(Object.keys(r.value.req.messages[0]!), ['role', 'content', 'b', 'a']);
  assert.equal(serializeChatRequest(r.value.req).toString('utf8'), text);
  assert.equal(r.value.unsafeInteger, false);
  assert.equal(r.value.raw.toString('utf8'), text);
});

test('unsafe integers are flagged (reviver), safe ones and digit strings are not', () => {
  const flag = (t: string): boolean | null => {
    const r = parseChatRequest(buf(t));
    return r.ok ? r.value.unsafeInteger : null;
  };
  assert.equal(flag('{"messages":[],"seed":12345678901234567890}'), true);
  assert.equal(flag('{"messages":[],"seed":9007199254740993}'), true);
  assert.equal(flag('{"messages":[],"seed":-9007199254740993}'), true);
  assert.equal(flag('{"messages":[],"x":1e20}'), true);
  assert.equal(flag('{"messages":[],"seed":9007199254740991}'), false);
  assert.equal(flag('{"messages":[{"role":"user","content":"id 12345678901234567890 and 3e8a"}]}'), false);
  assert.equal(flag('{"messages":[],"t":1.5e-7}'), false);
  assert.equal(flag('{"messages":[],"t":0.1}'), false);
});

test('parse fails open on non-chat bodies', () => {
  for (const [t, reason] of [
    ['not json', 'invalid_json'], ['[1,2]', 'not_an_object'], ['{"model":"m"}', 'no_messages'], ['{"messages":{}}', 'no_messages'],
    ['{"messages":[1]}', 'message_not_an_object'], ['{"messages":[null]}', 'message_not_an_object'], ['{"messages":[[]]}', 'message_not_an_object'],
  ] as const) {
    const r = parseChatRequest(buf(t));
    assert.equal(r.ok, false, t);
    if (!r.ok) assert.equal(r.reason, reason);
  }
  // a lone surrogate escape parses (JS strings allow it) and re-serializes as the same escape
  const r = parseChatRequest(buf('{"messages":[{"role":"user","content":"\\ud800"}]}'));
  assert.ok(r.ok);
  assert.equal(serializeChatRequest(r.value.req).toString(), '{"messages":[{"role":"user","content":"\\ud800"}]}');
});

test('T_req and the max_tokens field rule (§3)', () => {
  const base: ChatRequest = { model: 'm', messages: [] };
  assert.equal(requestMaxTokens(base, 32000), 32000);
  assert.equal(requestMaxTokens({ ...base, max_tokens: 1000 }, 32000), 1000);
  assert.equal(requestMaxTokens({ ...base, max_tokens: 1000, max_completion_tokens: 2000 }, 32000), 2000);
  assert.equal(requestMaxTokens({ ...base, max_tokens: 0, max_completion_tokens: null }, 32000), 32000);
  assert.equal(requestMaxTokens({ ...base, max_tokens: -5 }, 7), 7);
  // every field the client sent is set, none added; with none, max_tokens is added
  assert.deepEqual(withMaxTokens({ ...base, max_tokens: 5 }, 9), { ...base, max_tokens: 9 });
  assert.deepEqual(withMaxTokens({ ...base, max_completion_tokens: 5 }, 9), { ...base, max_completion_tokens: 9 });
  assert.deepEqual(withMaxTokens({ ...base, max_tokens: 1, max_completion_tokens: 5 }, 9), { ...base, max_tokens: 9, max_completion_tokens: 9 });
  const added = withMaxTokens(base, 9);
  assert.deepEqual(Object.keys(added), ['model', 'messages', 'max_tokens']);
  assert.deepEqual(maxTokensFieldsSent({ ...base, max_tokens: null, max_completion_tokens: 3 }), ['max_completion_tokens']);
  // key position is kept when the field exists
  assert.deepEqual(Object.keys(withMaxTokens({ max_tokens: 1, model: 'm', messages: [] }, 2)), ['max_tokens', 'model', 'messages']);
});

test('include_usage injection keeps other stream_options keys', () => {
  const r: ChatRequest = { model: 'm', messages: [], stream: true, stream_options: { foo: 1 } };
  assert.equal(clientWantsUsage(r), false);
  const w = withIncludeUsage(r);
  assert.deepEqual(w.stream_options, { foo: 1, include_usage: true });
  assert.equal(clientWantsUsage(w), true);
  assert.deepEqual(r.stream_options, { foo: 1 }, 'input untouched');
});

test('requestBytes = bytes(JSON messages) + bytes(canonical tools) + 512', () => {
  const req: ChatRequest = { messages: [{ role: 'user', content: 'héllo' }], tools: [{ b: 1, a: 2 }], max_tokens: 5 };
  assert.equal(requestBytes(req), Buffer.byteLength(JSON.stringify(req.messages)) + Buffer.byteLength('[{"a":2,"b":1}]') + 512);
  assert.equal(requestBytes({ ...req, max_tokens: 99999 }), requestBytes(req), 'max_tokens is not part of bytes()');
});

test('usage/finish tap and chunk inspection', () => {
  const t = tapJsonBody(JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7 } }));
  assert.deepEqual(t, { usage: { prompt_tokens: 7 }, finishReason: 'tool_calls' });
  assert.deepEqual(tapJsonBody('nope'), { usage: null, finishReason: null });
  const u = inspectChunk({ choices: [], usage: { prompt_tokens: 3 } });
  assert.equal(u.usageOnly, true);
  assert.equal(inspectChunk({ choices: [{ delta: {} }], usage: { prompt_tokens: 3 } }).usageOnly, false);
  assert.equal(inspectChunk({ choices: [], usage: null }).usageOnly, false);
  assert.equal(inspectChunk({ error: { message: 'x' } }).error, true);
  assert.equal(inspectChunk({ error: null }).error, false);
  assert.equal(inStreamErrorStatus({ error: { code: 400 } }, 200), 400);
  assert.equal(inStreamErrorStatus({ error: { code: '400' } }, 200), 400);
  assert.equal(inStreamErrorStatus({ error: { message: 'x', http_status_code: 422 } }, 200), 422);
  assert.equal(inStreamErrorStatus({ code: 400, message: 'x' }, 200), 400);
  assert.equal(inStreamErrorStatus({ error: { code: 'context_length_exceeded' } }, 200), 200);
  assert.equal(extractErrorMessage({ error: { message: 'a' } }), 'a');
  assert.equal(extractErrorMessage({ error: 'b' }), 'b');
  assert.equal(extractErrorMessage({ object: 'error', message: 'c' }), 'c');
  assert.equal(extractErrorMessage({ foo: 1 }), undefined);
});

test('formatK: one-decimal thousands, never a client retry run (§5.7)', () => {
  assert.equal(formatK(26_000), '26.0k');
  assert.equal(formatK(24_300), '24.3k');
  assert.equal(formatK(32_768), '32.8k');
  assert.equal(formatK(500_000), '499.9k');
  assert.equal(formatK(429_500), '428.9k');
  assert.equal(formatK(1_502_000), '1501.9k');
  assert.equal(formatK(1_500_300), '1499.9k');
  assert.equal(formatK(0), '0.0k');
  // property: over a wide range the printed text never matches, and is at most 0.05k above the value
  let x = 1;
  for (let i = 0; i < 20000; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const n = x % 5_000_000;
    const s = formatK(n);
    assert.ok(!CLIENT_RETRY_RUNS.test(s), `${n} -> ${s}`);
    assert.ok(Number(s.slice(0, -1)) <= n / 1000 + 0.05 + 1e-9, `${n} -> ${s}`);
  }
});

test('generated error bodies: exact shapes', () => {
  assert.equal(errorBody('m', 't', 'c').toString(), '{"error":{"message":"m","type":"t","param":null,"code":"c"}}');
  assert.equal(upstreamUnavailableBody().toString(), '{"error":{"message":"kitzur: upstream unavailable","type":"api_error","code":"upstream_unavailable"}}');
  // the  in-stream shape, byte for byte as in DESIGN.md
  assert.equal(
    inStreamOverflowEvents('kitzur: …').toString(),
    'data: {"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"code\\":\\"context_length_exceeded\\",\\"message\\":\\"kitzur: …\\"}}","type":"invalid_request_error","param":null,"code":"context_length_exceeded"}}\n\ndata: [DONE]\n\n',
  );
});

const CLIENTS: Client[] = ['opencode', 'kilo'];

test('translated overflow bodies are overflows for OpenCode and Kilo, and never retried', () => {
  const numbers = [0, 999, 26_000, 67_000, 100_000, 128_000, 429_000, 500_000, 502_400, 524_999, 1_500_000];
  for (const count of numbers) {
    for (const w of [32_000, 64_000, 100_000, 500_000]) {
      for (const msg of [overflowMessage(count, w), overflowMessage(null, w), refuseMessage(count, w - 9000, w, 8000), refuseMessage(NaN, w - 9000, w, 8000)]) {
        assert.ok(!/NaN|undefined|Infinity/.test(msg), msg);
        const body = contextLengthExceededBody(msg).toString('utf8');
        assert.ok(!OC_RETRY_RUNS.test(body), body);
        for (const c of CLIENTS) {
          const v = classifyHttpError(c, 400, body);
          assert.equal(v.overflow, true, `${c}: ${body}`);
        }
      }
    }
  }
});

test('the  in-stream shape is a context overflow for both clients (parseStreamError)', () => {
  const ev = inStreamOverflowEvents(overflowMessage(70_000, 100_000)).toString('utf8');
  const first = ev.split('\n\n')[0]!;
  assert.ok(first.startsWith('data: '));
  const payload = first.slice(6);
  for (const c of CLIENTS) assert.equal(classifyStreamError(c, payload), 'overflow', c);
  assert.ok(!OC_RETRY_RUNS.test(ev));
  // a plain vLLM-style in-stream overflow is NOT recognised (why  exists)
  const vllm = JSON.stringify({ error: { message: "This model's maximum context length is 100000 tokens.", type: 'BadRequestError', code: 400 } });
  assert.equal(classifyStreamError('opencode', vllm), 'unknown');
  assert.notEqual(classifyStreamError('kilo', vllm), 'overflow');
});

test('the OpenCode port agrees with the measured errsim table (reference implementation)', () => {
  const rows: Array<[string, number, string, boolean, boolean]> = [
    ['vllm mock', 400, JSON.stringify({ object: 'error', type: 'BadRequestError', param: null, code: 400, message: "This model's maximum context length is 100000 tokens. However, you requested 115000 tokens (83000 in the messages, 32000 in the completion). Please reduce the length of the messages or completion." }), true, true],
    ['llama.cpp mock', 400, JSON.stringify({ error: { code: 400, type: 'exceed_context_size_error', message: 'the request exceeds the available context size, try increasing it', n_prompt_tokens: 83000, n_ctx: 100000 } }), true, true],
    ['gateway 502', 502, JSON.stringify({ error: { type: 'upstream_error', message: 'Upstream model server returned an error' } }), false, false],
    ['tgi 422', 422, JSON.stringify({ error_type: 'validation', error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 100000. Given: 83000 `inputs` tokens and 32000 `max_new_tokens`' }), false, false],
    ['lmstudio', 400, JSON.stringify({ error: 'Trying to keep the first 83000 tokens when context the overflows. However, the model is loaded with context length of only 100000 tokens, which is not enough.' }), false, false],
    ['413 html', 413, '<html><head><title>413 Request Entity Too Large</title></head><body></body></html>', true, true],
    ['400 empty', 400, '', false, false],
    ['429 too many tokens', 429, JSON.stringify({ error: { message: 'Too many tokens, please wait before trying again.', type: 'rate_limit', code: 429 } }), true, false],
  ];
  for (const [name, status, body, oc, kilo] of rows) {
    assert.equal(classifyHttpError('opencode', status, body).overflow, oc, `opencode ${name}`);
    assert.equal(classifyHttpError('kilo', status, body).overflow, kilo, `kilo ${name}`);
  }
  assert.equal(classifyHttpError('opencode', 502, rows[2]![2]).retried, true, 'a 502 is retried, not compacted');
});
