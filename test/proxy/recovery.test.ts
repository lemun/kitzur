import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../../src/config/schema.js';
import type { ChatMessage, ChatRequest, EngineResult, LearnedEntry, ProcessOptions } from '../../src/types.js';
import { ErrorClassifier, type Classification } from '../../src/proxy/errors.js';
import {
  applyTighten, learnFrom413, learnFromOverflow, mandatoryImageBytes, maxTokensRetryValue, notePendingSuccess, runChat, strictlySmaller,
  type AttemptOutcome, type AttemptSize, type ChatResult, type LadderIO, type OutgoingAttempt,
} from '../../src/proxy/recovery.js';
import { freshLearnedEntry } from '../../src/proxy/state.js';
import { corrected, serverFits, serverLimits } from '../../src/proxy/budget.js';
import { parseChatRequest, requestBytes, requestMaxTokens } from '../../src/dialect/openai-chat.js';
import { charCounter, testConfig } from './harness.js';
import { FakeEngine, result, shrinkingEngine } from './fake-engine.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const cfg100 = testConfig();

test(' size order: raw first, then max_tokens; bytes never larger (strictly smaller for a 413)', () => {
  const a = (raw: number, bytes: number, maxTokens: number): AttemptSize => ({ raw, bytes, maxTokens });
  assert.ok(strictlySmaller(a(9, 10, 5), a(10, 10, 5)));
  assert.ok(strictlySmaller(a(10, 10, 4), a(10, 10, 5)));
  assert.ok(!strictlySmaller(a(10, 10, 5), a(10, 10, 5)), 'identical resend is not smaller (1% quantisation trap)');
  assert.ok(!strictlySmaller(a(9, 11, 5), a(10, 10, 5)), 'more bytes');
  assert.ok(!strictlySmaller(a(11, 9, 1), a(10, 10, 5)), 'more tokens with a smaller M');
  assert.ok(!strictlySmaller(a(9, 10, 5), a(10, 10, 5), 'payload_too_large'), '413: bytes must shrink');
  assert.ok(strictlySmaller(a(9, 9, 5), a(10, 10, 5), 'payload_too_large'));
});

test('overflow_unknown tighten: idempotent, capped, logged once per change', () => {
  const e0 = freshLearnedEntry(100_000, 'c');
  // budget0 = 100000 - 32000 - 1000 = 67000; want = ceil256(67000 - floor(0.95 * 66000)) = ceil256(4300) = 4352
  const t1 = applyTighten(e0, 66_000, cfg100, 'openai.code', NOW);
  assert.equal(t1.entry.tighten, 4352);
  assert.equal(t1.entry.tightenLog.length, 1);
  assert.deepEqual(t1.entry.tightenLog[0], { rule: 'openai.code', at: NOW.toISOString(), rejectedRaw: 66_000 });
  const t2 = applyTighten(t1.entry, 66_000, cfg100, 'openai.code', NOW);
  assert.equal(t2.changed, false, 'a repeat rejection at the same size changes nothing');
  assert.equal(applyTighten(t1.entry, 68_000, cfg100, 'x', NOW).changed, false, 'a larger rejected request teaches less');
  const capped = applyTighten(e0, 1_000, cfg100, 'x', NOW);
  assert.equal(capped.entry.tighten, Math.floor(0.2 * 67_000), 'capped at maxTightenFraction · budget0');
  assert.equal(e0.tighten, 0, 'input not mutated');
});

const cls = (p: Partial<Classification>): Classification => ({ kind: 'overflow_total', status: 400, inStream: false, numbersInMessage: true, ruleId: 'vllm.legacy.total', ...p });

test('learnFromOverflow: validated window (min), exact correction (capped), refused window -> overflow_unknown + tighten', () => {
  const e0 = freshLearnedEntry(100_000, 'c');
  const a = learnFromOverflow(e0, cls({ window: 89_000, promptTokens: 60_600, completionTokens: 32_000 }), 60_000, cfg100, 'exact', NOW);
  assert.deepEqual([a.entry.window, a.entry.correction, a.entry.tighten, a.kind], [89_000, 1.01, 0, 'overflow_total']);
  const b = learnFromOverflow(a.entry, cls({ window: 95_000, promptTokens: 60_000 }), 60_000, cfg100, 'exact', NOW);
  assert.equal(b.entry.window, 89_000, 'window only ever goes down');
  const capped = learnFromOverflow(e0, cls({ window: 89_000, promptTokens: 74_000 }), 60_000, cfg100, 'exact', NOW);
  assert.equal(capped.entry.correction, 1.05, 'exact-mode cap');
  const est = learnFromOverflow(e0, cls({ window: 89_000, promptTokens: 74_000 }), 60_000, cfg100, 'estimate', NOW);
  assert.equal(est.entry.correction, 1.24);
  const refused = learnFromOverflow(e0, cls({ window: 100_000, promptTokens: 60_000 }), 60_000, cfg100, 'exact', NOW);
  assert.equal(refused.kind, 'overflow_unknown');
  assert.equal(refused.entry.window, null);
  assert.ok(refused.entry.tighten > 0, 'no usable limit: the tighten rule applies');
  const lb = learnFromOverflow(e0, cls({ window: 89_000, promptTokens: 57_001, promptIsLowerBound: true }), 60_000, cfg100, 'exact', NOW);
  assert.deepEqual([lb.entry.window, lb.entry.correction], [89_000, 1], 'a lower bound below our count raises nothing');
  const sg = learnFromOverflow(e0, cls({ kind: 'overflow_prompt', ruleId: 'sglang.sched', promptTokens: 61_000, maxInput: 60_000 }), 61_000, cfg100, 'exact', NOW);
  assert.deepEqual([sg.entry.maxPrompt, sg.entry.window, sg.entry.tighten], [60_000, null, 0]);
});

test('413 learns a byte limit only; mandatory image bytes', () => {
  const e0 = freshLearnedEntry(100_000, 'c');
  const a = learnFrom413(e0, 1_000_000, NOW);
  assert.deepEqual([a.entry.maxBodyBytes, a.entry.tighten], [900_000, 0]);
  assert.equal(learnFrom413(a.entry, 2_000_000, NOW).changed, false);
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1000) } };
  const req: ChatRequest = {
    messages: [
      { role: 'user', content: [img, { type: 'text', text: 'old' }] },
      { role: 'assistant', content: 'x' },
      { role: 'tool', content: 'r', tool_call_id: '1' },
      { role: 'user', content: [{ type: 'text', text: 'see' }, img] },
    ],
  };
  assert.equal(mandatoryImageBytes(req), Buffer.byteLength(JSON.stringify(img)));
  assert.equal(mandatoryImageBytes({ messages: [{ role: 'user', content: [img] }] }), 0, 'no assistant: head only');
});

test('pending tighten of ambiguous errors: persisted only after two distinct chains within 24 h ()', () => {
  const e0 = freshLearnedEntry(100_000, 'c');
  const a = notePendingSuccess(e0, 'chainA', 62_000, 'gateway.5xx', cfg100, NOW);
  assert.deepEqual([a.persisted, a.entry.tighten, a.entry.pendingTighten.length], [false, 0, 1]);
  const again = notePendingSuccess(a.entry, 'chainA', 61_000, 'gateway.5xx', cfg100, NOW);
  assert.deepEqual([again.persisted, again.entry.pendingTighten.length], [false, 1], 'OpenCode retrying the same request is one chain');
  const late = notePendingSuccess(a.entry, 'chainB', 61_000, 'gateway.5xx', cfg100, new Date(NOW.getTime() + 25 * 3600e3));
  assert.equal(late.persisted, false, 'the first success expired');
  const b = notePendingSuccess(a.entry, 'chainB', 61_000, 'gateway.5xx', cfg100, new Date(NOW.getTime() + 3600e3));
  assert.equal(b.persisted, true);
  assert.equal(b.entry.tighten, applyTighten(e0, 61_000, cfg100, 'x', NOW).entry.tighten, 'the smaller rejected raw count');
  assert.equal(b.entry.pendingTighten.length, 0);
});

test('max_tokens_too_large retry value: W - margin - tighten - ceil(raw * correction)', () => {
  const e = { ...freshLearnedEntry(100_000, 'c'), tighten: 256, correction: 1.02 };
  assert.equal(maxTokensRetryValue(cfg100, e, 100, 60_000), 100_000 - 1000 - 356 - 61_200);
});

// ---------------------------------------------------------------- the ladder with a fake I/O layer

type Style = 'vllm' | 'vllm018' | 'llamacpp' | 'tgi' | 'gateway' | 'unknown' | 'sse' | '413' | 'mtl' | 'excluded';
const STYLES: Style[] = ['vllm', 'vllm018', 'llamacpp', 'tgi', 'gateway', 'unknown', 'sse', '413', 'mtl', 'excluded'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sent {
  a: OutgoingAttempt;
  size: AttemptSize;
  bodyIsOriginal: boolean;
}

function errorFor(style: Style, prompt: number, M: number, limit: number): AttemptOutcome {
  const base = { type: 'error' as const, httpStatus: 400, statusMessage: 'Bad Request', headers: [], inStream: false, committed: false, upstreamMs: 1 };
  const J = (o: unknown) => Buffer.from(JSON.stringify(o));
  switch (style) {
    case 'vllm':
      return { ...base, status: 400, body: J({ object: 'error', message: `This model's maximum context length is ${limit} tokens. However, you requested ${prompt + M} tokens (${prompt} in the messages, ${M} in the completion). Please reduce the length of the messages or completion.`, code: 400 }) };
    case 'vllm018':
      return { ...base, status: 400, body: J({ error: { message: `This model's maximum context length is ${limit} tokens. However, you requested ${M} output tokens and your prompt contains at least ${limit - M + 1} input tokens, for a total of at least ${limit + 1} tokens.`, code: 400 } }) };
    case 'llamacpp':
      return { ...base, status: 400, body: J({ error: { code: 400, type: 'exceed_context_size_error', message: 'the request exceeds the available context size, try increasing it', n_prompt_tokens: prompt, n_ctx: limit } }) };
    case 'tgi':
      return { ...base, status: 422, httpStatus: 422, body: J({ error_type: 'validation', error: `Input validation error: \`inputs\` tokens + \`max_new_tokens\` must be <= ${limit}. Given: ${prompt} \`inputs\` tokens and ${Math.min(M, 1024)} \`max_new_tokens\`` }) };
    case 'gateway':
      return { ...base, status: 502, httpStatus: 502, body: J({ error: { type: 'upstream_error', message: 'Upstream model server returned an error' } }) };
    case 'unknown':
      return { ...base, status: 400, body: Buffer.from('E_UPSTREAM_7: request refused') };
    case 'sse':
      return { ...base, status: 400, httpStatus: 200, inStream: true, body: J({ error: { message: `The input (${prompt} tokens) is longer than the model's context length (${limit} tokens).`, code: 400 } }) };
    case '413':
      return { ...base, status: 413, httpStatus: 413, body: Buffer.from('<html><title>413 Request Entity Too Large</title></html>') };
    case 'mtl':
      return { ...base, status: 400, body: J({ error: { message: `max_tokens=${M} cannot be greater than max_model_len=${limit}.`, code: 400 } }) };
    case 'excluded':
      return { ...base, status: 429, httpStatus: 429, body: J({ error: { message: 'Rate limit exceeded' } }) };
  }
}

function makeHistory(r: () => number): ChatRequest {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'S'.repeat(200) }, { role: 'user', content: 'goal '.repeat(40) }];
  const n = 2 + Math.floor(r() * 20);
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: 'a'.repeat(Math.floor(r() * 2000)), tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 't'.repeat(Math.floor(r() * 30_000)) });
  }
  return { model: 'm', messages: msgs, max_tokens: r() < 0.5 ? 2000 : 8000, stream: r() < 0.5 };
}

interface Trial {
  res: ChatResult;
  sent: Sent[];
  original: AttemptSize;
  originalFitsAtStart: boolean;
  cfg: Config;
  style: string;
}

async function trial(seed: number): Promise<Trial> {
  const r = rng(seed);
  const window = [8000, 16_000, 32_000][Math.floor(r() * 3)]!;
  const cfg = testConfig({
    budget: { window, defaultMaxTokens: 2000, planMaxTokens: 2000 },
    errors: { maxRetries: Math.floor(r() * 4) },
    stream: { injectIncludeUsage: r() < 0.3 },
    calibration: { minSamples: 1 },
  });
  const counter = charCounter();
  const req = makeHistory(r);
  const raw = Buffer.from(JSON.stringify(req));
  const parsed = parseChatRequest(raw);
  assert.ok(parsed.ok);
  const style = STYLES[Math.floor(r() * STYLES.length)]!;
  const mixed = r() < 0.25;
  const hiddenLimit = Math.floor(window * (0.55 + r() * 0.5)); // the server's real limit, maybe below the config's
  const byteLimit = 20_000 + Math.floor(r() * 200_000);
  const engine = r() < 0.15 ? new FakeEngine(() => { throw new Error('boom'); }) : shrinkingEngine(cfg, counter);
  const store = new Map<string, LearnedEntry>();
  const key = 'k';
  const sent: Sent[] = [];
  const io: LadderIO = {
    async send(a) {
      const size = { raw: counter.countRequest(a.req), bytes: requestBytes(a.req), maxTokens: requestMaxTokens(a.req, cfg.budget.defaultMaxTokens) };
      sent.push({ a, size, bodyIsOriginal: a.body.equals(raw) });
      const st = mixed ? STYLES[Math.floor(r() * STYLES.length)]! : style;
      if (st === '413') return size.bytes > byteLimit ? errorFor(st, size.raw, size.maxTokens, hiddenLimit) : { type: 'ok', status: 200, tap: { usage: null, finishReason: 'stop' }, complete: true, upstreamMs: 1 };
      if (st === 'excluded' && r() < 0.5) return errorFor(st, 0, 0, 0);
      if (size.raw + size.maxTokens > hiddenLimit) return errorFor(st, size.raw, size.maxTokens, hiddenLimit);
      if (st === 'unknown' && r() < 0.3) return errorFor(st, 0, 0, 0);
      return { type: 'ok', status: 200, tap: { usage: null, finishReason: 'stop' }, complete: true, upstreamMs: 1 };
    },
    aborted: () => false,
    count: (q) => counter.countRequest(q),
    learned: () => store.get(key) ?? freshLearnedEntry(cfg.budget.window, counter.id),
    saveLearned: (e) => void store.set(key, e),
    process: (q: ChatRequest, o: ProcessOptions): EngineResult => engine.process(q, o),
    now: () => NOW,
  };
  const e0 = io.learned();
  const origRaw = counter.countRequest(req);
  const original = { raw: origRaw, bytes: requestBytes(req), maxTokens: requestMaxTokens(req, 2000) };
  const originalFitsAtStart = serverFits(corrected(origRaw, e0.correction), original.maxTokens, serverLimits(cfg, e0));
  const res = await runChat({ cfg, parsed: parsed.value, classifier: new ErrorClassifier(cfg.errors), counterMode: 'estimate', shadow: false }, io);
  return { res, sent, original, originalFitsAtStart, cfg, style: mixed ? 'mixed' : style };
}

test('property: the ladder never grows, never resends the original on a retry, and stays within maxRetries + 1', async () => {
  let recoveries = 0;
  let multi = 0;
  const statsByStyle: Record<string, Record<string, number>> = {};
  for (let seed = 1; seed <= 400; seed++) {
    const { res, sent, original, originalFitsAtStart, cfg, style } = await trial(seed);
    const bucket = (statsByStyle[style] ??= {});
    const outcome = `${res.final.type}:${sent.length}`;
    bucket[outcome] = (bucket[outcome] ?? 0) + 1;
    if (res.originalResent) bucket['originalResend'] = (bucket['originalResend'] ?? 0) + 1;
    const tag = `seed ${seed}`;
    // attempts (the include_usage retry repeats its attempt number and is not counted)
    const attemptNos = new Set(sent.map((s) => s.a.n));
    assert.ok(attemptNos.size <= cfg.errors.maxRetries + 1, `${tag}: ${attemptNos.size} attempts`);
    assert.ok(sent.length <= cfg.errors.maxRetries + 2, `${tag}: at most one extra include_usage retry`);
    for (let i = 0; i < sent.length; i++) {
      const s = sent[i]!;
      // never larger than the client's request (I7)
      assert.ok(s.size.raw <= original.raw && s.size.bytes <= original.bytes, `${tag}: attempt ${s.a.n} larger than the original`);
      if (s.a.n === 1 && s.a.original && !s.a.result) {
        // the original on attempt 1 without an engine result: the engine threw; only if it fits
        assert.ok(originalFitsAtStart, `${tag}: original forwarded although it does not fit`);
      }
      if (i === 0) continue;
      const p = sent[i - 1]!;
      if (s.a.n === p.a.n) continue; // include_usage retry of the same attempt
      const isC25 = s.a.original && res.originalResent;
      if (isC25) {
        assert.ok(p.a.original === false, `${tag}:  resend after a rewritten attempt only`);
        continue;
      }
      assert.equal(s.a.original, false, `${tag}: attempt ${s.a.n} is the original`);
      assert.equal(s.bodyIsOriginal, false, `${tag}: attempt ${s.a.n} has the original bytes`);
      const kind = res.attempts[i - 1]?.kind;
      assert.ok(strictlySmaller(s.size, p.size, kind === 'payload_too_large' ? kind : undefined), `${tag}: attempt ${s.a.n} not smaller than ${p.a.n} after ${kind}`);
    }
    if (res.originalResent) assert.equal(sent.filter((s) => s.a.original && s.a.n > 1).length, 1, `${tag}:  resend at most once`);
    if (sent.length > 1) multi++;
    if (sent.length > 1 && res.final.type === 'relayed') recoveries++;
    // the client never gets an untranslated overflow
    if (res.final.type === 'relay') {
      const k = res.attempts[res.attempts.length - 1]!.kind;
      assert.ok(!['overflow_prompt', 'overflow_total', 'overflow_unknown', 'max_tokens_too_large'].includes(k), `${tag}: overflow relayed untranslated`);
    }
  }
  if (process.env['KITZUR_TEST_VERBOSE']) console.log({ multi, recoveries, styles: statsByStyle });
  assert.ok(multi > 80, `coverage: ${multi} multi-attempt trials`);
  assert.ok(recoveries > 40, `coverage: ${recoveries} recoveries`);
  assert.ok(Object.keys(statsByStyle['413'] ?? {}).some((k) => /:[2-9]$/.test(k)), 'coverage: a 413 retry');
});

test('ladder: engine exception forwards the original only when it fits; otherwise the §5.7 400 without an upstream call', async () => {
  const cfg = testConfig({ budget: { window: 8000, defaultMaxTokens: 1000 } });
  const counter = charCounter();
  for (const [size, fits] of [[1000, true], [40_000, false]] as const) {
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(size) }], max_tokens: 1000 };
    const raw = Buffer.from(JSON.stringify(req));
    const parsed = parseChatRequest(raw);
    assert.ok(parsed.ok);
    const sends: OutgoingAttempt[] = [];
    const io: LadderIO = {
      send: async (a) => (sends.push(a), { type: 'ok', status: 200, tap: { usage: null, finishReason: 'stop' }, complete: true, upstreamMs: 1 }),
      aborted: () => false, count: (q) => counter.countRequest(q), learned: () => freshLearnedEntry(8000, counter.id), saveLearned: () => undefined,
      process: () => { throw new TypeError('engine bug'); }, now: () => NOW,
    };
    const res = await runChat({ cfg, parsed: parsed.value, classifier: new ErrorClassifier(cfg.errors), counterMode: 'estimate', shadow: false }, io);
    assert.equal(res.guard, 'engine:TypeError');
    if (fits) {
      assert.equal(res.action, 'guard_fallback');
      assert.equal(sends.length, 1);
      assert.ok(sends[0]!.body.equals(raw), 'the original bytes');
    } else {
      assert.equal(res.action, 'guard_reject');
      assert.equal(sends.length, 0);
      assert.equal(res.final.type, 'generated');
      if (res.final.type === 'generated') {
        assert.equal(res.final.status, 400);
        assert.equal(JSON.parse(res.final.body.toString()).error.code, 'context_length_exceeded');
      }
    }
  }
});

test('ladder: counting failure on an engine exception forwards the original (I7 "counting itself failed")', async () => {
  const cfg = testConfig({ budget: { window: 8000, defaultMaxTokens: 1000 } });
  const counter = charCounter();
  const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'COUNT-FAIL' }, { role: 'user', content: 'x'.repeat(90_000) }] };
  const parsed = parseChatRequest(Buffer.from(JSON.stringify(req)));
  assert.ok(parsed.ok);
  let sends = 0;
  const res = await runChat({ cfg, parsed: parsed.value, classifier: new ErrorClassifier(cfg.errors), counterMode: 'estimate', shadow: false }, {
    send: async () => (sends++, { type: 'ok', status: 200, tap: { usage: null, finishReason: 'stop' }, complete: true, upstreamMs: 1 }),
    aborted: () => false, count: (q) => counter.countRequest(q), learned: () => freshLearnedEntry(8000, counter.id), saveLearned: () => undefined,
    process: () => { throw new Error('x'); }, now: () => NOW,
  });
  assert.deepEqual([res.action, sends], ['guard_fallback', 1]);
});

test('ladder: an engine guard_fallback for an original that does not fit becomes guard_reject (I7)', async () => {
  const cfg = testConfig({ budget: { window: 8000, defaultMaxTokens: 1000 } });
  const counter = charCounter();
  const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(40_000) }] };
  const parsed = parseChatRequest(Buffer.from(JSON.stringify(req)));
  assert.ok(parsed.ok);
  let sends = 0;
  const res = await runChat({ cfg, parsed: parsed.value, classifier: new ErrorClassifier(cfg.errors), counterMode: 'estimate', shadow: false }, {
    send: async () => (sends++, { type: 'ok', status: 200, tap: { usage: null, finishReason: 'stop' }, complete: true, upstreamMs: 1 }),
    aborted: () => false, count: (q) => counter.countRequest(q), learned: () => freshLearnedEntry(8000, counter.id), saveLearned: () => undefined,
    process: (q) => result(q, q, false, { action: 'guard_fallback', guard: 'guard:head' }), now: () => NOW,
  });
  assert.deepEqual([res.action, sends, res.final.type], ['guard_reject', 0, 'generated']);
});

test('ladder: guard_reject / impossible never call upstream; guard_fallback forwards the original bytes', async () => {
  const cfg = testConfig();
  const counter = charCounter();
  const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const raw = Buffer.from('{"model":"m",  "messages":[{"role":"user","content":"hi"}]}');
  const parsed = parseChatRequest(raw);
  assert.ok(parsed.ok);
  const errBody = { error: { message: 'kitzur: the system prompt and tool definitions alone need about 26.0k tokens', type: 'invalid_request_error', param: null, code: 'kitzur_fixed_prompt_too_large' } };
  for (const action of ['impossible', 'guard_reject', 'guard_fallback'] as const) {
    const eng = new FakeEngine((q) => result(q, action === 'guard_fallback' ? q : null, false, { action, error: action === 'guard_fallback' ? undefined : { status: 400, body: errBody }, guard: 'guard:pairing' }));
    const sends: OutgoingAttempt[] = [];
    const res = await runChat({ cfg, parsed: parsed.value, classifier: new ErrorClassifier(cfg.errors), counterMode: 'exact', shadow: false }, {
      send: async (a) => (sends.push(a), { type: 'ok', status: 200, tap: { usage: null, finishReason: 'stop' }, complete: true, upstreamMs: 1 }),
      aborted: () => false, count: (q) => counter.countRequest(q), learned: () => freshLearnedEntry(100_000, counter.id), saveLearned: () => undefined,
      process: (q, o) => eng.process(q, o), now: () => NOW,
    });
    assert.equal(res.action, action);
    if (action === 'guard_fallback') {
      assert.equal(sends.length, 1);
      assert.ok(sends[0]!.body.equals(raw), 'byte-identical original');
      assert.equal(res.guard, 'guard:pairing');
    } else {
      assert.equal(sends.length, 0);
      assert.equal(res.final.type, 'generated');
      if (res.final.type === 'generated') assert.deepEqual(JSON.parse(res.final.body.toString()), errBody);
    }
  }
  void req;
});
