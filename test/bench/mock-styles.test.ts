import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MockServer, ERROR_STYLES, type MockRecord } from '../../bench/mock/server.js';
import { PAYLOAD_TOO_LARGE, resolveErrorStyle, STYLE_KEY, UNKNOWN_400_BODY, type LengthErrorContext } from '../../bench/mock/styles.js';
import { httpRequest, header } from '../../bench/client/http.js';
import { PromptCounter, type RenderBody } from '../../bench/lib/render.js';
import { pyDumps } from '../../bench/lib/pyjson.js';
import type { ErrorStyleId, MockOptions } from '../../bench/scenarios/types.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { ROOT, testTokenizerPath } from '../helpers.js';

interface MapEntry { id: string; status: Array<number | null>; match: string; flags?: string }
const FIX = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'bench', 'server-errors.json'), 'utf8')) as {
  map: { entries: MapEntry[]; exclusions: Array<{ match: string; flags?: string }> };
  samples: Array<[string | null, number, string]>;
};
const S = FIX.samples;

/** reference implementation classification (as upstream reference runs it). */
function classify(status: number, body: string, stream: boolean): { id: string; groups: Record<string, string> } | null {
  if (FIX.map.exclusions.some((x) => new RegExp(x.match, x.flags ?? '').test(body))) return null;
  for (const e of FIX.map.entries) {
    const ok = e.status.includes(stream ? null : status) || (e.status.includes(null) && stream);
    if (!ok) continue;
    const m = new RegExp(e.match, e.flags ?? '').exec(body);
    if (m) return { id: e.id, groups: Object.fromEntries(Object.entries(m.groups ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string> };
  }
  return null;
}

const ctx = (prompt: number, maxTokens: number, limit = 100_000, body: RenderBody = {}): LengthErrorContext => ({ prompt, maxTokens, limit, body });
const style = (id: ErrorStyleId) => ERROR_STYLES.get(resolveErrorStyle(id))!;

test('§7 style bodies are byte-exact to the server_error_map samples', () => {
  assert.equal(style('vllm-018')(ctx(95_000, 32_000)).raw, S[0]![2]); // "at least" lower bound
  assert.equal(style('vllm-018')(ctx(95_000, 200_000, 100_000, { max_tokens: 200_000 })).raw, S[9]![2]);
  assert.equal(style('vllm-018')(ctx(100_001, 0)).raw, S[10]![2]); // no max_tokens: the engine check
  assert.equal(style('vllm-legacy')(ctx(95_000, 32_000)).raw, S[7]![2]);
  assert.equal(style('vllm-legacy')(ctx(100_500, 32_000)).raw, S[8]![2]);
  assert.equal(style('sglang')(ctx(95_000, 32_000)).raw, S[11]![2]);
  assert.equal(style('sglang')(ctx(100_500, 32_000)).raw, S[12]![2]);
  assert.equal(style('sglang')(ctx(8391, 32_000, 8192)).inStream, S[13]![2] + '\n\ndata: [DONE]\n\n');
  assert.equal(style('llamacpp')(ctx(100_500, 32_000)).raw, S[15]![2]);
  assert.equal(style('llamacpp')(ctx(100_500, 32_000)).inStream, `data: ${S[15]![2]}\n\n`); // llama.cpp main: no [DONE]
  assert.equal(style('tgi422')(ctx(99_500, 32_000)).raw, S[19]![2]); // max_new_tokens printed as min(M, 1024)
  assert.equal(style('tgi422')(ctx(99_500, 32_000)).inStream, S[20]![2] + '\n\ndata: [DONE]\n\n');
  assert.equal(style('tgi422')(ctx(100_000, 0)).raw, '{"error":"Input validation error: `inputs` must have less than 99999 tokens. Given: 100000","error_type":"validation"}');
  assert.equal(style('litellm')(ctx(95_000, 32_000)).raw, S[24]![2]);
  assert.equal(PAYLOAD_TOO_LARGE.raw, S[26]![2]);
  assert.equal(style('gateway502')(ctx(1, 1)).raw, S[27]![2]);
  assert.equal(style('unknown400')(ctx(1, 1)).raw, UNKNOWN_400_BODY);
  // every ErrorStyleId resolves; the python-* ids keep the Python registry keys (the cross-check's styles)
  assert.deepEqual(['python-vllm', 'python-llamacpp', 'python-gateway502', 'python-tgi422'].map((k) => STYLE_KEY[k as ErrorStyleId]), ['vllm', 'llamacpp', 'gateway502', 'tgi422']);
  for (const k of Object.values(STYLE_KEY)) assert.ok(ERROR_STYLES.get(k), k);
  // the samples themselves classify as the map says (the fixture is intact)
  for (const [want, status, body] of S) assert.equal(classify(status, body, status === 200)?.id ?? null, want, body.slice(0, 60));
});

const tokPath = testTokenizerPath();
const counter = tokPath ? new PromptCounter(loadTokenizer(tokPath)) : null;
const MSGS = [{ role: 'system', content: 'You are a BROWSER agent.' }, { role: 'user', content: 'Run the checkout specs on staging and report.' }];

async function post(mock: MockServer, body: unknown, headers: Array<[string, string]> = []): Promise<{ status: number; ctype: string; text: string; ms: number }> {
  const t = performance.now();
  const r = await httpRequest({
    method: 'POST', url: `${mock.url}/v1/chat/completions`, body: Buffer.from(JSON.stringify(body)), closeWaitMs: 2000,
    headers: [['content-type', 'application/json'], ['x-sim-step', '3'], ...headers],
  });
  return { status: r.status, ctype: header(r, 'content-type') ?? '', text: r.body.toString('utf8'), ms: performance.now() - t };
}

async function withMock<T>(spec: Partial<MockOptions>, fn: (m: MockServer) => Promise<T>, limit = 2000): Promise<T> {
  const m = new MockServer({ counter: counter!, limit, spec });
  await m.start(0);
  try {
    return await fn(m);
  } finally {
    await m.stop();
  }
}

test('every §7 style overflows at the real limit (W − skew), with its status, framing and parseable numbers', { skip: counter ? false : 'no dev tokenizer.json' }, async () => {
  const P = counter!.countBody({ messages: MSGS });
  const W = 2000;
  const skew = 300;
  const L = W - skew;
  const cases: Array<{ id: ErrorStyleId; stream?: boolean; M: number; ok: number; status: number; mapId: string | null; inStream?: boolean; groups?: Record<string, string> }> = [
    { id: 'vllm-legacy', M: L - P + 1, ok: L - P, status: 400, mapId: 'vllm.legacy.total', groups: { window: String(L), prompt: String(P), completion: String(L - P + 1) } },
    { id: 'vllm-018', M: L - P + 1, ok: L - P, status: 400, mapId: 'vllm.v018.total', groups: { window: String(L), atLeast: 'at least ', prompt: String(P) } },
    { id: 'sglang', M: L - P + 1, ok: L - P, status: 400, mapId: 'sglang.total', groups: { window: String(L), prompt: String(P) } },
    { id: 'litellm', M: L - P + 1, ok: L - P, status: 400, mapId: 'vllm.v018.total', groups: { window: String(L), prompt: String(P) } },
    { id: 'gateway502', M: L - P + 1, ok: L - P, status: 502, mapId: 'gateway.5xx' },
    { id: 'http413', M: L - P + 1, ok: L - P, status: 400, mapId: 'vllm.v018.total' },
    { id: 'unknown400', M: L - P + 1, ok: L - P, status: 400, mapId: null },
    { id: 'sse-inline', stream: true, M: L - P + 1, ok: L - P, status: 200, mapId: 'vllm.v018.total', inStream: true },
    { id: 'sse-inline', stream: false, M: L - P + 1, ok: L - P, status: 400, mapId: 'vllm.v018.total' },
    { id: 'python-vllm', M: L - P + 1, ok: L - P, status: 400, mapId: 'vllm.legacy.total' },
  ];
  for (const c of cases) {
    await withMock({ errorStyle: c.id, limitSkewTokens: skew }, async (m) => {
      assert.equal(m.limit, L);
      const bad = await post(m, { messages: MSGS, max_tokens: c.M, stream: c.stream ?? false });
      assert.equal(bad.status, c.status, `${c.id}: status`);
      const got = classify(bad.status, bad.text, bad.status === 200);
      assert.equal(got?.id ?? null, c.mapId, `${c.id}: ${bad.text.slice(0, 120)}`);
      for (const [k, v] of Object.entries(c.groups ?? {})) assert.equal(got?.groups[k], v, `${c.id}: ${k}`);
      if (c.inStream) {
        assert.match(bad.ctype, /event-stream/);
        assert.ok(bad.text.startsWith('data: {"error":{') && bad.text.endsWith('data: [DONE]\n\n'), bad.text);
      }
      if (c.id === 'unknown400') assert.equal(bad.text, UNKNOWN_400_BODY);
      if (c.id === 'gateway502') assert.match(bad.ctype, /text\/html/);
      const good = await post(m, { messages: MSGS, max_tokens: c.ok, stream: c.stream ?? false });
      assert.equal(good.status, 200, `${c.id}: P + M = real limit is accepted`);
      const [r0, r1] = m.records as [MockRecord, MockRecord];
      assert.equal(r0.rejected_for_length, true);
      assert.equal(r0.reject_reason, 'tokens');
      if (c.inStream) assert.equal(r0.stream_error, true);
      assert.equal(r1.rejected_for_length, undefined);
      assert.equal(r0.prompt_tokens, P);
    }, W);
  }
});

test('limit modes: prompt_only (llama.cpp), tgi, silent_truncate; generation capped at the window', { skip: counter ? false : 'no dev tokenizer.json' }, async () => {
  const P = counter!.countBody({ messages: MSGS });
  // llama.cpp: only prompt >= n_ctx is rejected; max_tokens is not checked, generation stops at the window
  await withMock({ errorStyle: 'llamacpp' }, async (m) => {
    const bad = await post(m, { messages: MSGS, max_tokens: 1 });
    assert.equal(bad.status, 400);
    assert.deepEqual(classify(400, bad.text, false)?.groups, { prompt: String(P), window: String(P) });
    assert.equal(JSON.parse(bad.text).error.n_ctx, P);
  }, P);
  await withMock({ errorStyle: 'llamacpp' }, async (m) => {
    const ok = await post(m, { messages: MSGS, max_tokens: 32_000 });
    assert.equal(ok.status, 200);
    const j = JSON.parse(ok.text);
    assert.equal(j.choices[0].finish_reason, 'length'); // 5 tokens of room: the scripted tool call does not fit
    assert.deepEqual(j.choices[0].message.tool_calls, []);
    assert.ok(j.usage.completion_tokens <= 5, JSON.stringify(j.usage));
    assert.equal(m.records[0]!.finish_reason, 'length');
  }, P + 5);
  // TGI: prompt + min(max_tokens, 1024) <= max_total_tokens
  await withMock({ errorStyle: 'tgi422' }, async (m) => {
    // 32,000 requested, but only min(32000, 1024) counts against max_total_tokens
    assert.equal((await post(m, { messages: MSGS, max_tokens: 32_000 })).status, 200);
    assert.equal(m.records[0]!.rejected_for_length, undefined);
  }, P + 1024);
  await withMock({ errorStyle: 'tgi422' }, async (m) => {
    const bad = await post(m, { messages: MSGS, max_tokens: 32_000 });
    assert.equal(bad.status, 422);
    assert.deepEqual(classify(422, bad.text, false)?.groups, { window: String(P + 1023), prompt: String(P), completion: '1024' });
  }, P + 1023);
  // Ollama: never rejects, drops the oldest messages; usage reports the truncated prompt
  const long = [MSGS[0]!, ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'lorem ipsum '.repeat(80) }))];
  const full = counter!.countBody({ messages: long });
  assert.ok(full > 1500);
  await withMock({ limitMode: 'silent_truncate' }, async (m) => {
    const r = await post(m, { messages: long, max_tokens: 100 });
    assert.equal(r.status, 200);
    const rec = m.records[0]!;
    assert.equal(rec.prompt_tokens, full);
    assert.ok(rec.server_prompt_tokens! <= 1500 && rec.truncated_messages! >= 1, JSON.stringify(rec));
    assert.equal(JSON.parse(r.text).usage.prompt_tokens, rec.server_prompt_tokens);
  }, 1500);
});

test('hidden overhead (number and percent) counts in the limit check, the record and usage', { skip: counter ? false : 'no dev tokenizer.json' }, async () => {
  const P = counter!.countBody({ messages: MSGS });
  const oh = Math.ceil((P * 3) / 100);
  await withMock({ hiddenOverheadTokens: '3%' }, async (m) => {
    const r = await post(m, { messages: MSGS, max_tokens: 10 });
    assert.equal(JSON.parse(r.text).usage.prompt_tokens, P + oh);
    assert.equal(m.records[0]!.prompt_tokens, P + oh);
    assert.equal(m.records[0]!.hidden_overhead, oh);
    // fits without the overhead, not with it
    assert.equal((await post(m, { messages: MSGS, max_tokens: 1000 - P })).status, 400);
    assert.equal((await post(m, { messages: MSGS, max_tokens: 1000 - P - oh })).status, 200);
  }, 1000);
  await withMock({ hiddenOverheadTokens: 250 }, async (m) => {
    await post(m, { messages: MSGS, max_tokens: 10, stream: true, stream_options: { include_usage: true } });
    assert.equal(m.records[0]!.prompt_tokens, P + 250);
  }, 5000);
});

test('inStreamErrors, late status (headerDelayMs), 413 by maxBodyBytes, usage modes', { skip: counter ? false : 'no dev tokenizer.json' }, async () => {
  const P = counter!.countBody({ messages: MSGS });
  await withMock({ errorStyle: 'vllm-018', inStreamErrors: true }, async (m) => {
    const s = await post(m, { messages: MSGS, max_tokens: 1000, stream: true });
    assert.equal(s.status, 200);
    assert.match(s.text, /^data: \{"error":\{"message":"This model's maximum context length is 1000 tokens/);
    assert.ok(s.text.endsWith('data: [DONE]\n\n'));
    assert.equal(m.records[0]!.error_status, 400);
    assert.equal((await post(m, { messages: MSGS, max_tokens: 1000 })).status, 400); // non-stream: a status
  }, 1000);
  await withMock({ errorStyle: 'llamacpp', inStreamErrors: true }, async (m) => {
    const s = await post(m, { messages: MSGS, max_tokens: 1, stream: true });
    assert.equal(s.status, 200);
    assert.ok(!s.text.includes('[DONE]'), 'llama.cpp ends the stream after the error');
  }, P);
  await withMock({ errorStyle: 'late400', headerDelayMs: 150 }, async (m) => {
    const bad = await post(m, { messages: MSGS, max_tokens: 1000 });
    assert.equal(bad.status, 400);
    assert.ok(bad.ms >= 140, `late status after ${bad.ms} ms`);
    const ok = await post(m, { messages: MSGS, max_tokens: 10 });
    assert.equal(ok.status, 200);
    assert.ok(ok.ms < 140, 'accepted requests are not delayed');
  }, 1000);
  await withMock({ errorStyle: 'http413', maxBodyBytes: 400 }, async (m) => {
    const big = await post(m, { messages: [...MSGS, { role: 'user', content: 'x'.repeat(400) }], max_tokens: 10 });
    assert.equal(big.status, 413);
    assert.equal(big.text, S[26]![2]);
    assert.equal(m.records[0]!.reject_reason, 'bytes');
    assert.equal((await post(m, { messages: MSGS, max_tokens: 10 })).status, 200);
  }, 5000);
  for (const [usage, stream, withOpt, want] of [
    ['never', true, true, false], ['never', false, false, false], ['always', true, false, true], ['client', true, false, false], ['client', true, true, true],
  ] as Array<[MockOptions['usage'], boolean, boolean, boolean]>) {
    await withMock({ usage }, async (m) => {
      const r = await post(m, { messages: MSGS, max_tokens: 10, stream, ...(withOpt ? { stream_options: { include_usage: true } } : {}) });
      assert.equal(r.text.includes('"usage"'), want, `${usage} stream=${stream} include_usage=${withOpt}`);
    }, 5000);
  }
  // Python mode is untouched: the python-* registry keys still produce the Python json.dumps body
  const py = ERROR_STYLES.get('vllm')!({ prompt: 5, maxTokens: 7, limit: 10, body: {} });
  assert.equal(pyDumps(py.body), '{"object": "error", "type": "BadRequestError", "param": null, "code": 400, "message": "This model\'s maximum context length is 10 tokens. However, you requested 12 tokens (5 in the messages, 7 in the completion). Please reduce the length of the messages or completion."}');
});
