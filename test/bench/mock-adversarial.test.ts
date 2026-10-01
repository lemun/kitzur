// Adversarial checks of the bench mock (bench/README.md§6.4, §7): record sequences with rejections and client
// compactions, style bodies classified as intended (server_error_map.json, the strict client, OpenCode), and edge cases
// of the placeholders and limit modes. Written by the regression verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer, type MockRecord, type MockServerOptions } from '../../bench/mock/server.js';
import { resolveErrorStyle, STYLE_KEY } from '../../bench/mock/styles.js';
import { runAgent } from '../../bench/client/agent.js';
import { classifyHttpError, classifyStreamError, processedTotals, runOpenCode } from '../../bench/client/opencode.js';
import { clientErrorKind, parseResponse } from '../../bench/client/sse.js';
import { httpRequest, header } from '../../bench/client/http.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { referenceScenario, REFERENCE_FACTS } from '../../bench/lib/ref-spec.js';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { ErrorStyleId, FactSpec, MockOptions, ScenarioSpec, SessionSpec } from '../../bench/scenarios/types.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { ROOT, testTokenizerPath } from '../helpers.js';

const tokPath = testTokenizerPath();
const counter = tokPath ? new PromptCounter(loadTokenizer(tokPath)) : null;
const skip = counter ? false : 'no dev tokenizer.json';

interface MapEntry { id: string; status: Array<number | null>; match: string; flags?: string }
const FIX = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'bench', 'server-errors.json'), 'utf8')) as {
  map: { entries: MapEntry[]; exclusions: Array<{ match: string; flags?: string }> };
};
/** server_error_map.json, matched against the body (or each SSE payload for a 200). */
function mapId(status: number, text: string): { id: string; groups: Record<string, string> } | null {
  const payloads = status === 200 ? text.split('\n').filter((l) => /^(data|error):/.test(l)).map((l) => l.replace(/^(data|error):\s?/, '')) : [text];
  for (const body of payloads) {
    if (FIX.map.exclusions.some((x) => new RegExp(x.match, x.flags ?? '').test(body))) continue;
    for (const e of FIX.map.entries) {
      if (!e.status.includes(status === 200 ? null : status)) continue;
      const m = new RegExp(e.match, e.flags ?? '').exec(body);
      if (m) return { id: e.id, groups: Object.fromEntries(Object.entries(m.groups ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string> };
    }
  }
  return null;
}

async function withMock<T>(o: Omit<MockServerOptions, 'counter'>, fn: (m: MockServer, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-mockadv-'));
  const m = new MockServer({ counter: counter!, outDir: dir, ...o });
  await m.start(0);
  try {
    return await fn(m, dir);
  } finally {
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const CS: FactSpec[] = [
  { id: 'cs-40', marker: 'CS-ONLY-P4W7Q', channel: 'client-summary', expect: 'survive', gate: true },
  { id: 'cs-90', marker: 'CS-ONLY-T9J2X', channel: 'client-summary', expect: 'survive', gate: true },
];

test('F10: a scenario with its own client summary gets its CS-ONLY markers only from that compaction on, even when the client compacted earlier', { skip }, async () => {
  // the reference overflows a 100k/32k server at step 10, so the OpenCode client compacts (overflow) at 10, before
  // the scripted client compaction at 12; the step-10 placeholder must not carry the markers of the step-12 summary
  const summaryText = '## Objective\n- keep going\n\n## Important Details\n- CS-ONLY-P4W7Q promo flags\n- CS-ONLY-T9J2X review selectors';
  const base = referenceScenario({ capBytes: 51_200 }, { id: 'cc-early', facts: [...REFERENCE_FACTS, ...CS], steps: 16, events: [{ atStep: 12, kind: 'client-compact' }] });
  const spec = { ...base, clientCompact: { atStep: 12, trigger: 'manual', summaryText, summaryTokens: 30 } } as ScenarioSpec;
  await withMock({ limit: 100_000, scenarios: [spec], spec: {} }, async (m, dir) => {
    const r = await runOpenCode({ base: m.url, counter: counter!, spec, context: 100_000, output: 32_000 });
    assert.deepEqual(r.compactions.map((c) => [c.step, c.reason]), [[10, 'overflow'], [12, 'manual']]);
    assert.equal(m.records.filter((x) => x.kind === 'summarizer').length, 2);
    // the step-10 summary is a generated placeholder: the reference markers it saw, no CS-ONLY marker
    const main11 = JSON.parse(readFileSync(join(dir, m.records.find((x) => x.kind === 'main' && x.step === 11)!.body_file!), 'utf8')) as { messages: ChatMessage[] };
    const first = main11.messages[2]!.content as string;
    assert.ok(first.startsWith('## Objective') && first.includes('GOAL-CHK-7F3A'), first.slice(0, 200));
    assert.ok(!first.includes('CS-ONLY'), 'a generated placeholder must not plant the scenario\'s own client-summary markers');
    for (const x of m.records.filter((y) => y.kind === 'main')) {
      const want = x.step >= 12;
      assert.equal(x.facts['CS-ONLY-P4W7Q'], want, `step ${x.step} (${x.status})`);
      assert.equal(x.facts['CS-ONLY-T9J2X'], want, `step ${x.step} (${x.status})`);
    }
    // the step-12 summary is the scenario's text, byte for byte
    const main12 = JSON.parse(readFileSync(join(dir, m.records.find((x) => x.kind === 'main' && x.step === 12)!.body_file!), 'utf8')) as { messages: ChatMessage[] };
    assert.equal(main12.messages[2]!.content, summaryText);
  });
  // without an own summary text the generated placeholder still plants the client-summary markers (40% / 90%)
  const plain = referenceScenario({ capBytes: 51_200 }, { id: 'cc-plain', facts: [...REFERENCE_FACTS, ...CS], steps: 12 });
  await withMock({ limit: 100_000, scenarios: [plain], spec: {} }, async (m) => {
    const r = await runOpenCode({ base: m.url, counter: counter!, spec: plain, context: 100_000, output: 32_000 });
    assert.deepEqual(r.compactions.map((c) => c.step), [10]);
    assert.ok(m.records.filter((x) => x.kind === 'main' && x.step >= 10 && x.status === 200).every((x) => x.facts['CS-ONLY-P4W7Q'] && x.facts['CS-ONLY-T9J2X']));
  });
});

test('record sequence of an OpenCode run against a §7 style: rejection → summarizer → accepted re-send, per-kind LCP state', { skip }, async () => {
  // vllm-018 with the §7.1 skew at 100k/32k: the real limit is 89,000
  const spec = referenceScenario({ capBytes: 51_200 }, { id: 'seq', steps: 14 });
  await withMock({ limit: 100_000, scenarios: [spec], spec: { errorStyle: 'vllm-018', limitSkewTokens: 11_000 } }, async (m) => {
    assert.equal(m.limit, 89_000);
    const r = await runOpenCode({ base: m.url, counter: counter!, spec, context: 100_000, output: 32_000, title: false });
    assert.equal(r.stepsCompleted, 14);
    const recs = m.records;
    const i = recs.findIndex((x) => x.rejected_for_length);
    assert.ok(i > 0);
    const [rej, summ, again] = [recs[i]!, recs[i + 1]!, recs[i + 2]!];
    assert.deepEqual([rej.kind, rej.status, rej.reject_reason, rej.step], ['main', 400, 'tokens', again.step]);
    assert.ok(rej.prompt_tokens + rej.max_tokens > 89_000);
    assert.deepEqual([summ.kind, summ.status, summ.finish_reason, summ.step], ['summarizer', 200, 'stop', rej.step]);
    assert.equal(summ.lcp_tokens, 0, 'the first summarizer request has no predecessor of its kind');
    assert.deepEqual([again.kind, again.status, again.finish_reason], ['main', 200, 'tool_calls']);
    assert.ok(again.prompt_tokens < rej.prompt_tokens);
    // LCP of the re-send is against the last ACCEPTED main request (not the rejected one, not the summarizer)
    const lastOk = recs.slice(0, i).filter((x) => x.kind === 'main' && x.status === 200).at(-1)!;
    assert.ok(again.lcp_ok_tokens! > 0 && again.lcp_ok_tokens! < lastOk.prompt_tokens);
    assert.ok(again.lcp_tokens! >= again.lcp_ok_tokens!, 'the rejected request shares the old prefix too');
    // OpenCode recognised the vLLM ≥0.18 text as an overflow; one client record per HTTP request
    assert.equal(r.requests.filter((q) => q.status === 400).every((q) => q.overflow && q.client_error_kind === 'http_400'), true);
    assert.equal(r.requests.length, recs.length);
    const t = processedTotals(recs);
    assert.equal(t.total, recs.reduce((a, x) => a + x.prompt_tokens, 0));
    assert.equal(t.rejections, recs.filter((x) => x.rejected_for_length).length);
    assert.equal(t.summarizerRequests, r.compactions.length);
  });
});

test('every §7 style: its rejection is classified as intended by the error map, the strict client and OpenCode', { skip }, async () => {
  const P = counter!.countBody({ messages: [{ role: 'user', content: 'hello' }] });
  const W = 3000;
  const skew = 500;
  const L = W - skew;
  // style → [HTTP status, map id, strict client kind, OpenCode overflow?, OpenCode retried?] (reference implementation)
  const want: Record<ErrorStyleId, [number, string | null, string, boolean, boolean]> = {
    'vllm-legacy': [400, 'vllm.legacy.total', 'http_400', true, false],
    'vllm-018': [400, 'vllm.v018.total', 'http_400', true, false],
    sglang: [400, 'sglang.total', 'http_400', true, false],
    llamacpp: [400, 'llamacpp.new', 'http_400', true, false],
    tgi422: [422, 'tgi.total', 'http_422', false, false],
    litellm: [400, 'vllm.v018.total', 'http_400', true, false],
    http413: [400, 'vllm.v018.total', 'http_400', true, false],
    gateway502: [502, 'gateway.5xx', 'http_502', false, true],
    'sse-inline': [200, 'vllm.v018.total', 'stream_error', false, false],
    late400: [400, 'vllm.v018.total', 'http_400', true, false],
    unknown400: [400, null, 'http_400', false, false],
    'python-vllm': [400, 'vllm.legacy.total', 'http_400', true, false],
    'python-llamacpp': [400, 'llamacpp.old', 'http_400', true, false],
    'python-gateway502': [502, 'gateway.5xx', 'http_502', false, true],
    'python-tgi422': [422, 'tgi.total', 'http_422', false, false],
  };
  assert.deepEqual(Object.keys(want).sort(), Object.keys(STYLE_KEY).sort(), 'every ErrorStyleId');
  for (const [id, [status, map, kind, overflow, retried]] of Object.entries(want) as Array<[ErrorStyleId, (typeof want)[ErrorStyleId]]>) {
    const spec: Partial<MockOptions> = { errorStyle: id, limitSkewTokens: skew, headerDelayMs: id === 'late400' ? 30 : 0 };
    await withMock({ limit: W, spec }, async (m) => {
      // prompt_only (llama.cpp main) rejects on the prompt alone; TGI on prompt + min(max_tokens, 1024); the others
      // on prompt + max_tokens (the python-* styles keep the Python mock's check)
      const fill = m.styleName === 'llamacpp-main' ? L : m.styleName === 'tgi422-router' ? L - 600 : 0;
      const msgs = [{ role: 'user', content: 'hello' + ' hello'.repeat(fill) }];
      const r = await httpRequest({
        method: 'POST', url: `${m.url}/v1/chat/completions`, closeWaitMs: 2000,
        body: Buffer.from(JSON.stringify({ messages: msgs, max_tokens: L - P + 1, stream: true })),
        headers: [['content-type', 'application/json'], ['x-sim-step', '0']],
      });
      const text = r.body.toString('utf8');
      assert.equal(r.status, status, `${id}: status`);
      const got = mapId(r.status, text);
      assert.equal(got?.id ?? null, map, `${id}: ${text.slice(0, 160)}`);
      if (got?.groups['window']) assert.equal(got.groups['window'], String(L), `${id}: the body reports the REAL limit`);
      const parsed = r.status === 200 ? parseResponse(header(r, 'content-type') ?? '', r.body) : null;
      assert.equal(clientErrorKind(r.status, parsed), kind, `${id}: strict kind`);
      const cls = r.status === 200 ? classifyStreamError(parsed!.errors[0]!) : classifyHttpError(r.status, r.reason, text);
      assert.equal(cls.overflow, overflow, `${id}: OpenCode overflow (${cls.message.slice(0, 100)})`);
      if (!overflow && id !== 'sse-inline') assert.equal(cls.retryable, retried, `${id}: OpenCode retry`);
      const rec = m.records[0]!;
      assert.equal(rec.rejected_for_length, true, id);
      assert.equal(rec.reject_reason, 'tokens', id);
      assert.equal(rec.stream_error === true, r.status === 200, id);
    });
  }
});

test('silent_truncate with the qwen3 render: a candidate the Jinja template cannot render is still counted (never 0 tokens)', { skip }, async () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'goal ' + 'x '.repeat(50) }];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'f', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'lorem ipsum '.repeat(60) });
  }
  const served: Record<string, number> = {};
  for (const render of ['sim', 'qwen3'] as const) {
    await withMock({ limit: 600, spec: { limitMode: 'silent_truncate', render } }, async (m) => {
      const r = await httpRequest({
        method: 'POST', url: `${m.url}/v1/chat/completions`, closeWaitMs: 2000, body: Buffer.from(JSON.stringify({ messages: msgs, max_tokens: 50 })),
        headers: [['content-type', 'application/json'], ['x-sim-step', '0']],
      });
      assert.equal(r.status, 200);
      const rec = m.records[0]!;
      const usage = (JSON.parse(r.body.toString('utf8')) as { usage: { prompt_tokens: number } }).usage;
      assert.ok(rec.prompt_tokens > 600, `${render}: the full prompt is over the limit`);
      assert.ok(rec.server_prompt_tokens! > 0 && rec.server_prompt_tokens! <= 600, `${render}: served ${rec.server_prompt_tokens}`);
      assert.equal(usage.prompt_tokens, rec.server_prompt_tokens);
      assert.ok(rec.truncated_messages! >= 1 && rec.truncated_messages! < msgs.length - 1, `${render}: dropped ${rec.truncated_messages}`);
      served[render] = rec.truncated_messages!;
    });
  }
  assert.equal(served['qwen3'], served['sim'], 'the same suffix fits under both renders here');
});

test('strict client on the mock: truncated streams and in-stream errors from the streamError hook; Python-mode records stay Python-shaped', { skip }, async () => {
  const one: SessionSpec = {
    id: 'solo', seed: 0, steps: 2,
    system: () => 'S', tools: () => [], goal: () => ({ role: 'user', content: 'go' }),
    assistantAt: (): ChatMessage => ({ role: 'assistant', content: 'done', tool_calls: [] as ToolCall[] }),
    toolResults: () => [], userAfter: () => [],
  };
  const sc: ScenarioSpec = { id: 'solo', family: 'F1', sessions: [one], facts: [], client: 'sim', capBytes: null, mock: {}, gates: [], expect: 'complete' };
  const cases: Array<[MockServerOptions['streamError'], string]> = [
    [() => ({ event: { id: 'x', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] } }), 'truncated_stream'],
    [() => ({ event: { error: { message: 'boom', code: 500 } }, done: true }), 'stream_error'],
    [() => ({ event: { id: 'x', choices: [{ index: 0, delta: { content: 'cut' }, finish_reason: 'length' }] }, done: true }), 'length_no_tool'],
  ];
  for (const [hook, kind] of cases) {
    await withMock({ scenarios: [sc], spec: {}, streamError: hook }, async (m) => {
      const res = await runAgent({ base: m.url, counter: counter!, spec: sc, strict: true });
      assert.equal(res.errors!.length, 1);
      assert.equal(res.errors![0]!.kind, kind);
      assert.equal(res.records[0]!.client_error_kind, kind);
      assert.equal(m.records[0]!.stream_error, true);
    });
  }
  // a scenario with no facts gets `facts: {}` (never the reference 7) and an empty strict defect set
  await withMock({ scenarios: [sc], spec: {} }, async (m) => {
    await runAgent({ base: m.url, counter: counter!, spec: sc, strict: true });
    assert.deepEqual(m.records.map((r) => [r.facts, r.pairing_strict, r.finish_reason]), [[{}, [], 'stop'], [{}, [], 'stop']]);
  });
  // Python mode without x-sim headers: no SPEC keys at all (the cross-check's mock.jsonl shape)
  await withMock({}, async (m) => {
    await runAgent({ base: m.url, counter: counter!, steps: 2, scenario: { capBytes: 51_200 } });
    const keys = Object.keys(m.records[0]!);
    assert.deepEqual(keys, ['seq', 'step', 'ts', 'prompt_tokens', 'max_tokens', 'n_messages', 'has_summary', 'facts', 'body_chars', 'pairing_error', 'status', 'completion_tokens', 'session', 'lcp_tokens', 'lcp_ok_tokens', 'body_bytes', 'body_file']);
  });
});

test('distribution completion model: generation never exceeds max_tokens, and the reported completion matches the emitted text', { skip }, async () => {
  const spec = referenceScenario({ capBytes: 51_200 }, { id: 'dist', steps: 4 });
  const cm = { reasoning: { kind: 'lognormal' as const, median: 300, p95: 1200 }, text: { kind: 'lognormal' as const, median: 60, p95: 200 }, seed: 3 };
  for (const maxTokens of [20, 150, 400, 5000]) {
    await withMock({ limit: 100_000, scenarios: [spec], spec: { completionModel: cm } }, async (m) => {
      const res = await runAgent({ base: m.url, counter: counter!, spec, maxTokens, strict: false });
      (m.records as MockRecord[]).forEach((r, i) => {
        assert.ok(r.completion_tokens! <= maxTokens, `max_tokens ${maxTokens}: completion ${r.completion_tokens}`);
        assert.ok(r.reasoning_tokens === undefined || r.reasoning_tokens <= r.completion_tokens!);
        assert.ok(['length', 'tool_calls'].includes(r.finish_reason!));
        assert.equal((res.records[i]!.usage as { completion_tokens: number }).completion_tokens, r.completion_tokens, 'usage = record');
        assert.equal(res.records[i]!.finish_reason, r.finish_reason);
        if (r.finish_reason === 'length') assert.deepEqual(res.histories!['main']!.filter((x) => x.role === 'assistant')[i]!.tool_calls, [], 'a cut turn has no tool call');
      });
      if (maxTokens >= 5000) assert.ok(m.records.every((r) => r.finish_reason === 'tool_calls'), 'uncut turns keep their tool calls');
      if (maxTokens <= 20) assert.ok(m.records.every((r) => r.finish_reason === 'length'), 'every turn is cut');
    });
  }
  // resolveErrorStyle is total over the ids the scenarios use
  for (const id of Object.keys(STYLE_KEY) as ErrorStyleId[]) assert.equal(typeof resolveErrorStyle(id), 'string');
});
