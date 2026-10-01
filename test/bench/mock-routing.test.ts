import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockServer } from '../../bench/mock/server.js';
import { baselineSummary, drawDist, FILLER_WORDS, keyedRng, TITLE_PLACEHOLDER } from '../../bench/mock/completion.js';
import { httpRequest, header } from '../../bench/client/http.js';
import { parseResponse } from '../../bench/client/sse.js';
import { SUMMARY_TEMPLATE } from '../../bench/client/opencode-strings.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { strictPairingDefects, defectsSubset } from '../../bench/lib/pairing-strict.js';
import { PyRandom } from '../../bench/lib/pyrandom.js';
import { pyDumps } from '../../bench/lib/pyjson.js';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { MockOptions, ScenarioSpec, SessionSpec } from '../../bench/scenarios/types.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';

const tokPath = testTokenizerPath();
const counter = tokPath ? new PromptCounter(loadTokenizer(tokPath)) : null;
const skip = counter ? false : 'no dev tokenizer.json';

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function miniSession(id: string, seed: number, marker: string, steps = 4): SessionSpec {
  return {
    id, seed, steps,
    system: () => `System prompt of ${id}.`,
    tools: () => [{ type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }],
    goal: (): ChatMessage => ({ role: 'user', content: `Goal ${marker}: migrate the specs of ${id}` }),
    assistantAt: (step: number): ChatMessage =>
      step === 1
        ? { role: 'assistant', content: `Reading two files for ${id}.`, reasoning_content: `RSN-${id}-${step} think first`, tool_calls: [call(`${id}_1_0`, 'read', { p: '/a' }), call(`${id}_1_1`, 'read', { p: '/b' })] }
        : { role: 'assistant', content: step === 2 ? `NOTE ${marker}-A noted` : null, tool_calls: [call(`${id}_${step}_0`, 'read', { p: `/f${step}` })] },
    toolResults: (step: number, calls: ToolCall[]): ChatMessage[] => calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: `output ${id} ${step} ${i}` })),
    userAfter: (step: number): ChatMessage[] => (step === 2 ? [{ role: 'user', content: `User adds ${marker}-U please` }] : []),
  };
}

const MINI: ScenarioSpec = {
  id: 'mini', family: 'F8', client: 'sim', capBytes: null, mock: {}, gates: [], expect: 'complete',
  sessions: [miniSession('s1', 1, 'MK1'), miniSession('s2', 2, 'MK2'), miniSession('s3', 3, 'MK3')],
  facts: [
    { id: 'g1', marker: 'MK1', channel: 'head', expect: 'survive', gate: true },
    { id: 'g2', marker: 'MK2', channel: 'head', expect: 'survive', gate: true },
    { id: 'cs1', marker: 'CS-ONLY-P4W7Q', channel: 'client-summary', expect: 'survive', gate: true },
    { id: 'cs2', marker: 'CS-ONLY-T9J2X', channel: 'client-summary', expect: 'survive', gate: true },
    { id: 'r1', marker: 'RSN-s1-1', channel: 'reasoning', expect: 'report-only', gate: false },
  ],
};

async function post(mock: MockServer, body: unknown, h: Record<string, string>): Promise<{ status: number; text: string; ctype: string }> {
  const r = await httpRequest({
    method: 'POST', url: `${mock.url}/v1/chat/completions`, body: Buffer.from(JSON.stringify(body)), closeWaitMs: 2000,
    headers: [['content-type', 'application/json'], ...Object.entries(h)],
  });
  return { status: r.status, text: r.body.toString('utf8'), ctype: header(r, 'content-type') ?? '' };
}

const hist = (s: SessionSpec): ChatMessage[] => [{ role: 'system', content: s.system() }, s.goal()];

test('routing: x-sim-scenario / x-sim-session / x-sim-step pick assistantAt; records carry the scenario facts', { skip }, async () => {
  const mock = new MockServer({ counter: counter!, scenarios: [MINI] });
  await mock.start(0);
  try {
    const s2 = MINI.sessions[1]!;
    const r = await post(mock, { messages: hist(s2), tools: s2.tools(), max_tokens: 1000, stream: true, stream_options: { include_usage: true } },
      { 'x-sim-scenario': 'mini', 'x-sim-session': 's2', 'x-sim-step': '1', 'x-sim-kind': 'main' });
    assert.equal(r.status, 200);
    const p = parseResponse(r.ctype, r.text);
    assert.deepEqual(p.toolCalls.map((c) => c.id), ['s2_1_0', 's2_1_1']); // parallel calls, merged by index
    assert.equal(p.reasoning, 'RSN-s2-1 think first');
    assert.equal(p.content, 'Reading two files for s2.');
    assert.equal(p.finishReason, 'tool_calls');
    const rec = mock.records[0]!;
    assert.equal(rec.session, 's2');
    assert.equal(rec.kind, 'main');
    assert.equal(rec.scenario, 'mini');
    assert.deepEqual(Object.keys(rec.facts), ['MK1', 'MK2', 'CS-ONLY-P4W7Q', 'CS-ONLY-T9J2X', 'RSN-s1-1']); // never the hard-coded 7
    assert.deepEqual(rec.facts, { MK1: false, MK2: true, 'CS-ONLY-P4W7Q': false, 'CS-ONLY-T9J2X': false, 'RSN-s1-1': false });
    assert.deepEqual(rec.pairing_strict, []);
    assert.equal(rec.finish_reason, 'tool_calls');
    assert.equal(rec.reasoning_tokens, counter!.countText('RSN-s2-1 think first'));
    // unknown scenario / session: a 400 naming the problem
    const u = await post(mock, { messages: hist(s2) }, { 'x-sim-scenario': 'nope', 'x-sim-step': '0' });
    assert.equal(u.status, 400);
    assert.match(u.text, /unknown scenario 'nope'/);
    const v = await post(mock, { messages: hist(s2) }, { 'x-sim-scenario': 'mini', 'x-sim-session': 'zz', 'x-sim-step': '0' });
    assert.match(v.text, /has no session 'zz'/);
    // without x-sim-scenario: the Python reference reply and the 7 reference facts (Python-mode record)
    await post(mock, { messages: hist(s2), max_tokens: 10 }, { 'x-sim-step': '2' });
    const last = mock.records.at(-1)!;
    assert.equal(Object.keys(last.facts).length, 7);
    assert.equal(last.kind, undefined);
  } finally {
    await mock.stop();
  }
});

test('strict pairing defects: positional, keyed by id and position, subset check', () => {
  const a = { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] };
  const t = (id: string | null): unknown => ({ role: 'tool', tool_call_id: id, content: 'x' });
  assert.deepEqual(strictPairingDefects([{ role: 'user' }, a, t('a'), t('b')]), []);
  assert.deepEqual(strictPairingDefects([{ role: 'user' }, a, t('b'), t('a')]), ['mismatch:a#0', 'mismatch:b#1']);
  assert.deepEqual(strictPairingDefects([{ role: 'user' }, a, t('a')]), ['unanswered:b#1']);
  assert.deepEqual(strictPairingDefects([{ role: 'user' }, a, t('a'), t('b'), t('c')]), ['orphan:c#2']);
  assert.deepEqual(strictPairingDefects([t('z'), { role: 'user' }]), ['orphan:z#0']);
  assert.deepEqual(strictPairingDefects([{ role: 'assistant', tool_calls: [{ id: 'd' }, { id: 'd' }] }, t('d'), t('d')]), ['dup-call:d#1']);
  assert.deepEqual(strictPairingDefects([{ role: 'assistant', tool_calls: [{}] }, t(null)]), []);
  assert.equal(defectsSubset(['orphan:z#0'], ['orphan:z#0', 'mismatch:a#0']), true);
  assert.equal(defectsSubset(['unanswered:b#1'], []), false);
});

test('summarizer and title placeholders: template shape, visible markers, planted client-summary markers', { skip }, async () => {
  const mock = new MockServer({ counter: counter!, scenarios: [MINI], summaryTokens: 1500, spec: {} });
  await mock.start(0);
  try {
    const s1 = MINI.sessions[0]!;
    const h = { 'x-sim-scenario': 'mini', 'x-sim-session': 's1', 'x-sim-step': '3' };
    await post(mock, { messages: hist(s1), max_tokens: 32000 }, { ...h, 'x-sim-kind': 'main' });
    const summ = await post(mock, { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'conversation mentions MK1 only' }], max_tokens: 32000, stream: true },
      { ...h, 'x-sim-kind': 'summarizer' });
    const p = parseResponse(summ.ctype, summ.text);
    assert.deepEqual(p.toolCalls, []);
    assert.equal(p.finishReason, 'stop');
    const text = p.content;
    for (const heading of SUMMARY_TEMPLATE.split('\n').filter((l) => /^#{2,3} /.test(l))) assert.ok(text.includes(heading + '\n'), heading);
    assert.ok(text.startsWith('## Objective\n'));
    assert.ok(text.includes('MK1') && !text.includes('MK2'), 'visible markers only (baseline.py semantics)');
    const n = counter!.countText(text);
    assert.ok(n <= 1500 && n >= 1450, `summary tokens ${n}`);
    const at = (m: string): number => text.indexOf(m) / text.length;
    assert.ok(Math.abs(at('CS-ONLY-P4W7Q') - 0.4) < 0.05, `CS-ONLY-P4W7Q at ${at('CS-ONLY-P4W7Q')}`);
    assert.ok(Math.abs(at('CS-ONLY-T9J2X') - 0.9) < 0.05, `CS-ONLY-T9J2X at ${at('CS-ONLY-T9J2X')}`);
    // a later summarizer sees the prior summary: markers stay (sticky), planted ones are not duplicated
    const again = parseResponse('text/event-stream', (await post(mock, { messages: [{ role: 'user', content: text }], stream: true }, { ...h, 'x-sim-kind': 'summarizer' })).text).content;
    assert.equal(again.split('CS-ONLY-P4W7Q').length, 2);
    assert.ok(again.includes('MK1'));
    // baseline style (x-sim-summary: baseline) is baseline.py's filler + sorted visible markers
    const base = parseResponse('text/event-stream', (await post(mock, { messages: [{ role: 'user', content: 'MK2 and MK1' }], stream: true }, { ...h, 'x-sim-kind': 'summarizer', 'x-sim-summary': 'baseline' })).text).content;
    const plantless = baselineSummary(1500, ['MK2', 'MK1']);
    assert.equal(plantless, ('- ' + 'summary bullet '.repeat(6) + '\n').repeat(107) + '\nMK1 MK2');
    assert.ok(base.includes('CS-ONLY-P4W7Q') && base.replace(/- CS-ONLY-\w+\n/g, '') === plantless, base.slice(-200));
    const title = await post(mock, { messages: [{ role: 'user', content: 'Generate a title' }], stream: false }, { ...h, 'x-sim-kind': 'title' });
    assert.equal(JSON.parse(title.text).choices[0].message.content, TITLE_PLACEHOLDER);
    // records: kinds; the main-class LCP state is not touched by summarizer/title requests
    assert.deepEqual(mock.records.map((r) => r.kind), ['main', 'summarizer', 'summarizer', 'summarizer', 'title']);
    await post(mock, { messages: hist(s1), max_tokens: 32000 }, { ...h, 'x-sim-kind': 'main' });
    assert.equal(mock.records.at(-1)!.lcp_ok_tokens, mock.records[0]!.prompt_tokens);
  } finally {
    await mock.stop();
  }
});

test('completion model: seeded sizes, reasoning emitted, deterministic per (session, step), capped at max_tokens', { skip }, async () => {
  const spec: Partial<MockOptions> = { completionModel: { reasoning: { kind: 'fixed', value: 40 }, text: { kind: 'fixed', value: 30 }, seed: 5 } };
  const mock = new MockServer({ counter: counter!, scenarios: [MINI], spec });
  await mock.start(0);
  try {
    const s1 = MINI.sessions[0]!;
    const h = (step: number): Record<string, string> => ({ 'x-sim-scenario': 'mini', 'x-sim-session': 's1', 'x-sim-step': String(step) });
    const body = { messages: hist(s1), max_tokens: 1000, stream: true };
    const a = parseResponse('text/event-stream', (await post(mock, body, h(3))).text);
    const b = parseResponse('text/event-stream', (await post(mock, body, h(3))).text);
    const c = parseResponse('text/event-stream', (await post(mock, body, h(0))).text);
    assert.equal(counter!.countText(a.reasoning), 40);
    assert.ok(a.reasoning.startsWith('Reasoning: '));
    assert.equal(counter!.countText(a.content), 30); // the scripted step-3 text is null: padded from "Note:"
    assert.deepEqual([a.reasoning, a.content], [b.reasoning, b.content], 'same (session, step) => same turn');
    assert.notEqual(a.reasoning, c.reasoning);
    assert.deepEqual(a.toolCalls.map((x) => x.id), ['s1_3_0']);
    const rec = mock.records[0]!;
    assert.equal(rec.reasoning_tokens, 40);
    assert.equal(rec.completion_tokens, 40 + counter!.countText(a.content + pyDumps(a.toolCalls))); // the Python formula
    // capped at the forwarded max_tokens: reasoning first, no tool call, finish_reason length
    const cut = parseResponse('text/event-stream', (await post(mock, { ...body, max_tokens: 25 }, h(3))).text);
    assert.equal(cut.finishReason, 'length');
    assert.deepEqual(cut.toolCalls, []);
    assert.equal(cut.content, '');
    assert.equal(mock.records.at(-1)!.completion_tokens, 25);
    const cut2 = parseResponse('text/event-stream', (await post(mock, { ...body, max_tokens: 50 }, h(3))).text);
    assert.equal(cut2.finishReason, 'length');
    assert.ok(cut2.content.length > 0 && counter!.countText(cut2.content) <= 10);
  } finally {
    await mock.stop();
  }
  // lognormal(median 1500, p95 6000): seeded, the sample median and p95 match
  const rng = new PyRandom(11);
  const xs = Array.from({ length: 6000 }, () => drawDist({ kind: 'lognormal', median: 1500, p95: 6000 }, rng)).sort((x, y) => x - y);
  assert.ok(Math.abs(xs[3000]! / 1500 - 1) < 0.05, `median ${xs[3000]}`);
  assert.ok(Math.abs(xs[5700]! / 6000 - 1) < 0.1, `p95 ${xs[5700]}`);
  assert.equal(keyedRng(1, 'a', 2).random(), keyedRng(1, 'a', 2).random());
  for (const w of FILLER_WORDS) assert.equal(counter!.countText(' ' + w), 1, w);
});

test('mock render qwen3: counts the real template; template errors are vLLM 400s', { skip }, async () => {
  const mock = new MockServer({ counter: counter!, spec: { render: 'qwen3' } });
  await mock.start(0);
  try {
    const ok = await post(mock, { model: 'qwen', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], max_tokens: 10 }, { 'x-sim-step': '3' });
    assert.equal(ok.status, 200);
    assert.equal(mock.records[0]!.prompt_tokens, 17); // jinja2 golden 'minimal system+user'
    const bad = await post(mock, { messages: [{ role: 'user', content: 'U' }, { role: 'system', content: 'S' }], max_tokens: 10 }, { 'x-sim-step': '3' });
    assert.equal(bad.status, 400);
    assert.deepEqual(JSON.parse(bad.text), { error: { message: 'System message must be at the beginning.', type: 'BadRequestError', param: null, code: 400 } });
    assert.equal(mock.records[1]!.template_error, 'System message must be at the beginning.');
  } finally {
    await mock.stop();
  }
});
