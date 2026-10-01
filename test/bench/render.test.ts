import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '../../bench/scenarios/reference.js';
import { render, renderPieces, estTokens, PromptCounter, contentText } from '../../bench/lib/render.js';
import { checkPairing } from '../../bench/lib/pairing.js';
import { pyDumps, pyLen } from '../../bench/lib/pyjson.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import type { ChatMessage } from '../../src/types.js';
import { testTokenizerPath } from '../helpers.js';
import { benchFixture, Checker, sha256 } from './fixtures.js';

interface RenderStep {
  step: number;
  render_sha256: string;
  render_pylen: number;
  est_usage: number;
  body_dumps_default_sha256: string;
  body_dumps_default_len: number;
  est_nousage: number;
  est_nostream: number;
}
interface RenderGolden {
  variants: Record<string, { env: Record<string, string>; steps: RenderStep[] }>;
  edge: Array<{ body: Record<string, unknown>; render: string; est: number }>;
  pairing: Record<string, { messages: unknown[]; error: string | null }>;
}
const R = benchFixture<RenderGolden>('render.json.gz');

/** agent_client.py's history after each step (the scripted replies; exactly what the client appends). */
function* histories(opts: sc.ScenarioOptions, steps: number): Generator<{ step: number; history: ChatMessage[] }> {
  const history = sc.initialHistory();
  for (let step = 0; step < steps; step++) {
    yield { step, history };
    const m = sc.assistantMessage(step, opts);
    history.push(m);
    for (const call of m.tool_calls) history.push({ role: 'tool', tool_call_id: call.id, content: sc.toolOutput(step, opts) });
    const inj = sc.USER_INJECT.get(step);
    if (inj !== undefined) history.push({ role: 'user', content: inj });
  }
}

const body = (history: ChatMessage[], extra: Record<string, unknown> = { stream: true, stream_options: { include_usage: true } }) => ({
  model: 'local-model',
  messages: history,
  tools: sc.tools(),
  max_tokens: 32000,
  ...extra,
});

test('render / est / body dumps match scenario.py for 46 steps x 3 variants', () => {
  const c = new Checker();
  for (const [name, v] of Object.entries(R.variants)) {
    const opts = sc.scenarioOptionsFromEnv(v.env);
    const want = new Map(v.steps.map((r) => [r.step, r]));
    for (const { step, history } of histories(opts, 46)) {
      const r = want.get(step)!;
      const b = body(history);
      const rendered = render(b);
      c.eq(sha256(rendered), r.render_sha256, `${name} ${step} render sha`);
      c.eq(pyLen(rendered), r.render_pylen, `${name} ${step} render len`);
      c.eq(renderPieces(b).join(''), rendered, `${name} ${step} pieces join`);
      c.eq(estTokens(b), r.est_usage, `${name} ${step} est usage`);
      const d = pyDumps(b);
      c.eq(sha256(d), r.body_dumps_default_sha256, `${name} ${step} body dumps sha`);
      c.eq(pyLen(d), r.body_dumps_default_len, `${name} ${step} body dumps len`);
      c.eq(estTokens(body(history, { stream: true })), r.est_nousage, `${name} ${step} est nousage`);
      c.eq(estTokens(body(history, { stream: false })), r.est_nostream, `${name} ${step} est nostream`);
    }
  }
  for (const [i, e] of R.edge.entries()) {
    c.eq(render(e.body), e.render, `edge ${i} render`);
    c.eq(estTokens(e.body), e.est, `edge ${i} est`);
  }
  assert.equal(c.fails.length, 0, c.summary());
  assert.equal(c.checks, 3 * 46 * 8 + R.edge.length * 2);
  assert.equal(contentText([{ type: 'text', text: 'A' }, { type: 'image_url' }, 'x', { type: 'text', text: 'B' }]), 'A\n\nB');
});

test('check_pairing reproduces the mock error strings', () => {
  const names = Object.keys(R.pairing);
  assert.ok(names.length >= 9);
  for (const [k, cse] of Object.entries(R.pairing)) assert.equal(checkPairing(cse.messages), cse.error, k);
  // Python: sorted() over a None mixed with str ids raises TypeError (the mock handler crashes)
  assert.throws(
    () => checkPairing([{ role: 'assistant', tool_calls: [{ id: 'a' }, {}] }, { role: 'user', content: 'x' }]),
    TypeError,
  );
});

const tokPath = testTokenizerPath();

test('mock counter: exact counts, additivity over added-token segments, LCP', { skip: tokPath ? false : 'no dev tokenizer.json' }, () => {
  const tok = loadTokenizer(tokPath!);
  const counter = new PromptCounter(tok);
  // 1) completion / tool output token counts (count_text) from scenario_golden, 4 variants x 80 steps
  const G = benchFixture<{ variants: Record<string, { env: Record<string, string>; steps: Array<{ step: number; completion_tokens?: number; tool_output_tokens?: number }> }> }>('scenario.json.gz');
  const c = new Checker();
  for (const [name, v] of Object.entries(G.variants)) {
    const opts = sc.scenarioOptionsFromEnv(v.env);
    for (const r of v.steps) {
      if (r.completion_tokens === undefined) continue;
      const m = sc.assistantMessage(r.step, opts);
      c.eq(counter.countText((m.content ?? '') + pyDumps(m.tool_calls)), r.completion_tokens, `${name} ${r.step} completion`);
      c.eq(counter.countText(sc.toolOutput(r.step, opts)), r.tool_output_tokens, `${name} ${r.step} tool output tokens`);
    }
  }
  assert.ok(c.checks >= 4 * 80 * 2, c.summary());
  // 2) per-step orig_qwen_tokens / orig_est_tokens of the whole client body (orig_totals.py, full re-count)
  const counts = benchFixture<Record<string, { env: Record<string, string | null>; steps: number; per_step: number[]; per_step_est: number[] }>>('counts.json.gz');
  assert.ok(Object.keys(counts).length >= 4);
  for (const [name, v] of Object.entries(counts)) {
    const env = Object.fromEntries(Object.entries(v.env).filter((e): e is [string, string] => e[1] !== null));
    const opts = sc.scenarioOptionsFromEnv(env);
    for (const { step, history } of histories(opts, v.steps)) {
      const b = body(history);
      c.eq(counter.countBody(b), v.per_step[step], `${name} ${step} orig_qwen`);
      c.eq(estTokens(b), v.per_step_est[step], `${name} ${step} orig_est`);
    }
  }
  assert.equal(c.fails.length, 0, c.summary());
  // 3) additivity: the segment-split count equals the tokenizer on the whole rendered prompt
  let last: ChatMessage[] = [];
  for (const { history } of histories({ capBytes: 51200 }, 46)) last = history;
  const full = render(body(last));
  assert.equal(counter.countText(full), tok.count(full));
  // the complete 46-step cap51200 history: 95 messages, 316,604 tokens [reference implementation, Python]
  assert.equal(last.length, 95);
  assert.equal(tok.count(full), 316614);
  // 4) token LCP against brute force on consecutive requests, a compaction-like rewrite, and NFC twins
  const lcpBrute = (a: string, b: string): number => {
    const x = tok.encode(a);
    const y = tok.encode(b);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  const hs: ChatMessage[][] = [];
  for (const { history } of histories({ capBytes: 51200 }, 8)) hs.push(structuredClone(history));
  const cases: Array<[string, string]> = [];
  for (let i = 1; i < hs.length; i++) cases.push([render(body(hs[i - 1]!)), render(body(hs[i]!))]);
  const rewritten = structuredClone(hs[7]!);
  rewritten.splice(2, 4, { role: 'user', content: sc.SUMMARY_HEADER + '\n\nsummary text' });
  cases.push([render(body(hs[7]!)), render(body(rewritten))]);
  cases.push(['<|im_start|>user\ncafé ok<|im_end|>', '<|im_start|>user\ncafé ok<|im_end|>']); // NFC-equal text
  cases.push(['<|im_start|>assistant\n', '<|im_start|>assistant\n\n<tool_call>\n{}']);
  cases.push(['abc', '']);
  for (const [a, b] of cases) {
    const sa = counter.segments(a);
    const sb = counter.segments(b);
    assert.equal(counter.lcp(sa, sb), lcpBrute(a, b));
    assert.equal(counter.lcp(sb, sa), lcpBrute(b, a));
    assert.equal(counter.lcp(sa, sa), tok.count(a));
  }
});
