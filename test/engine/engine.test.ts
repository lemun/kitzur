import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatRequest, TokenCounter } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { createEngine, LeanEngine } from '../../src/engine/engine.js';
import { SUMMARY_HEADER } from '../../src/engine/contracts.js';
import { digestOf } from '../../src/engine/canonical.js';
import { MemoryPlanStore } from '../../src/engine/store.js';
import { estimateCounter, exactCounter, presetConfig, referenceRequests, StubRules, StubSummarizer, testConfig } from './stubs.js';

const mk = (cfg: Config, counter: TokenCounter = estimateCounter(cfg.tokenizer.template.name), extra: Partial<ConstructorParameters<typeof LeanEngine>[0]> = {}) =>
  createEngine(cfg, { counter, summarizer: new StubSummarizer(cfg, counter), rules: new StubRules(cfg), faults: null, ...extra });

const sys: ChatMessage = { role: 'system', content: 'You are a coding agent.' };
const user = (t: string): ChatMessage => ({ role: 'user', content: t });
const words = (n: number, seed = 1): string => {
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'][x % 8] + (i % 12 === 11 ? '.\n' : ' ');
  }
  return s;
};
/** a session of k tool steps with results of `chars` characters each */
function session(k: number, chars: number): ChatMessage[] {
  const h: ChatMessage[] = [sys, user('Task GOAL-1: do the thing.')];
  for (let i = 0; i < k; i++) {
    h.push({ role: 'assistant', content: `Step ${i}.`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: `{"filePath":"/f${i}.ts"}` } }] });
    h.push({ role: 'tool', tool_call_id: `c${i}`, content: words(Math.ceil(chars / 6), i + 1) });
  }
  return h;
}
const req = (messages: ChatMessage[], extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'm', messages, ...extra });

test("the engine refuses a 'remote' counter ()", () => {
  const c = estimateCounter();
  const remote = { ...c, mode: 'remote' as const, id: c.id, countText: c.countText, measure: c.measure, countRequest: c.countRequest };
  assert.throws(() => mk(testConfig(), remote), /remote/);
});

test('passthrough: a small request is returned as the same object', () => {
  const e = mk(testConfig());
  const r = req(session(1, 500), { max_tokens: 1000 });
  const res = e.process(r, { attempt: 1 });
  assert.equal(res.action, 'passthrough');
  assert.equal(res.request, r);
  assert.equal(res.changed, false);
  assert.equal(res.maxTokens, null);
  assert.equal(res.plan?.compactions, 0);
  assert.equal(res.stats.tokensIn, res.stats.tokensOut);
});

test('forwarded max_tokens fit (): every field the client sent, else max_tokens added', () => {
  const e = mk(presetConfig('32k'));
  const base = session(1, 500);
  const a = e.process(req(base, { max_tokens: 32_000 }), { attempt: 1 });
  const lim = 32_000 - 512;
  assert.equal(a.maxTokens?.value, lim - a.stats.tokensOut);
  assert.deepEqual(a.maxTokens?.fields, ['max_tokens']);
  assert.equal(a.request?.max_tokens, a.maxTokens?.value);
  assert.equal(a.changed, true);
  assert.equal(a.request?.messages, base, 'messages untouched');
  const b = e.process(req(base, { max_tokens: 32_000, max_completion_tokens: 32_000 }), { attempt: 1 });
  assert.deepEqual(b.maxTokens?.fields, ['max_tokens', 'max_completion_tokens']);
  const c = e.process(req(base), { attempt: 1 }); // T_req = defaultMaxTokens = T_plan: no fit needed
  assert.equal(c.maxTokens, null);
  const pOnly = mk(presetConfig('32k', { server: { type: 'llamacpp' } })).process(req(base, { max_tokens: 32_000 }), { attempt: 1 });
  assert.equal(pOnly.maxTokens, null, 'prompt_only forwards T_req unchanged');
});

test('restore (Kilo): a shrunken max_tokens is raised to T_plan', () => {
  const e = mk(testConfig({ budget: { maxTokensRestore: { enabled: true, toTokens: null } } }));
  const res = e.process(req(session(1, 500), { max_tokens: 1024 }), { attempt: 1 });
  assert.equal(res.action, 'restore');
  assert.equal(res.maxTokens?.value, 32_000);
});

test('compaction on the reference session keeps pairing, the head and the budget', () => {
  const counter = exactCounter('sim') ?? estimateCounter('sim');
  const cfg = presetConfig('100k', { tokenizer: { template: { name: 'sim' } } });
  const e = mk(cfg, counter);
  const r = referenceRequests(11)[10]!; // step 10: 74,445 tokens uncompacted
  const res = e.process(r, { attempt: 1 });
  assert.equal(res.action, 'compact');
  const out = res.request!.messages;
  assert.ok(res.stats.tokensOut <= 61_000);
  assert.equal(out[0], r.messages[0]);
  assert.equal(out[1], r.messages[1]);
  assert.ok(String(out[2]!.content).startsWith(SUMMARY_HEADER));
  assert.ok(res.plan!.cut > res.plan!.hEnd);
  assert.equal(res.plan!.compactions, 1);
  assert.equal(res.stats.messagesOut, out.length);
  assert.ok(out.length < r.messages.length);
  assert.equal(out[out.length - 1], r.messages[r.messages.length - 1], 'the newest user rule is verbatim in the tail');
  // the same request again: memo hit at the live boundary, identical output, no step
  const again = e.process(r, { attempt: 1 });
  assert.equal(e.lastTrace?.steps, 0);
  assert.deepEqual(again.request!.messages.map(digestOf), out.map(digestOf));
  assert.equal(again.action, 'compact');
});

test('admission (§5.5a): a new oversized result is rewritten once, stage admission', () => {
  const counter = exactCounter('sim') ?? estimateCounter('sim');
  const cfg = presetConfig('32k', { tokenizer: { template: { name: 'sim' } } });
  const e = mk(cfg, counter);
  const reqs = referenceRequests(5, { capBytes: 51_200 }, 8000);
  for (const r of reqs.slice(0, 3)) e.process(r, { attempt: 1 });
  const res = e.process(reqs[3]!, { attempt: 1 }); // step 3: the todo result + step 2's 30-60k-char snapshot
  assert.equal(res.action, 'admit');
  const rw = Object.entries(res.plan!.rewrites);
  assert.ok(rw.length >= 1);
  for (const [, r] of rw) assert.equal(r.stage, 'admission');
  assert.equal(res.plan!.compactions, 0);
  const next = e.process(reqs[4]!, { attempt: 1 });
  // I6: the admitted message is forwarded identically in the next request
  const a = res.request!.messages.map(digestOf);
  assert.deepEqual(next.request!.messages.slice(0, a.length).map(digestOf), a);
});

test('head truncation (§5.7, ): an oversized first user message, stored in headRewrites', () => {
  const cfg = presetConfig('32k');
  const e = mk(cfg);
  const huge = 'Here is the conversation so far:\n\n<conversation>\n' + words(40_000) + '\n</conversation>';
  const r = req([sys, user(huge)]);
  const res = e.process(r, { attempt: 1 });
  assert.equal(res.action, 'compact');
  assert.ok(res.plan!.headRewrites[1]);
  const m = String(res.request!.messages[1]!.content);
  assert.match(m, /\[kitzur: this output was truncated to fit the model's context window/);
  assert.ok(m.startsWith('Here is the conversation so far:'));
  assert.ok(res.stats.tokensOut <= res.stats.budget.headRoom);
  assert.equal(res.request!.messages[0], sys);
});

test('§5.7 (b) impossible: tools alone do not fit (kitzur_fixed_prompt_too_large, no request)', () => {
  const cfg = presetConfig('32k');
  const tools = [{ type: 'function', function: { name: 'huge', description: words(30_000), parameters: {} } }];
  const res = mk(cfg).process(req(session(1, 200), { tools }), { attempt: 1 });
  assert.equal(res.action, 'impossible');
  assert.equal(res.impossibleKind, 'fixed');
  assert.equal(res.request, null);
  assert.equal(res.error?.status, 400);
  assert.equal((res.error?.body as { error: { code: string } }).error.code, 'kitzur_fixed_prompt_too_large');
});

test('§5.7 (c) impossible: headPolicy error and a head over the server limit', () => {
  const cfg = presetConfig('32k', { oversize: { headPolicy: 'error' } });
  const res = mk(cfg).process(req([sys, user(words(40_000))]), { attempt: 1 });
  assert.equal(res.action, 'impossible');
  assert.equal(res.impossibleKind, 'content');
  assert.equal((res.error?.body as { error: { code: string } }).error.code, 'context_length_exceeded');
});

test('§5.7 (a) truncate: prompt_only serves a head over the budget but within n_ctx', () => {
  const counter = estimateCounter();
  const cfg = testConfig({ server: { type: 'llamacpp' }, budget: { window: 32_768, defaultMaxTokens: 8000 }, oversize: { headPolicy: 'error' } });
  let n = 1000;
  // grow the goal until it is between the budget (24,256) and the server limit (32,256)
  let r = req([sys, user(words(n))]);
  while (counter.countRequest(r) < 27_000) r = req([sys, user(words((n = Math.ceil(n * 1.2))))]);
  const res = mk(cfg, counter).process(r, { attempt: 1 });
  assert.equal(res.action, 'truncate');
  assert.equal(res.plan?.fit, 'over_budget');
  assert.equal(res.maxTokens, null);
  assert.ok(res.stats.tokensOut > res.stats.budget.budget);
});

test('clamp (): reachable with a declared-large client window; M = min(T_req, W − margin − c)', () => {
  const cfg = testConfig({
    budget: { maxTokensClamp: { enabled: true, floorTokens: 8192 } }, client: { compactionPointTokens: 100_000 },
    oversize: { admission: false },
  });
  const e = mk(cfg);
  const h = session(4, 90_000);
  const res = e.process(req(h, { max_tokens: 32_000 }), { attempt: 1 });
  assert.ok(res.stats.tokensOut > 67_000, `count ${res.stats.tokensOut}`);
  assert.equal(res.action, 'clamp');
  assert.equal(res.maxTokens?.value, Math.min(32_000, 99_000 - res.stats.tokensOut));
  assert.equal(res.plan?.compactions, 0);
  // noClamp re-plans without the clamp clause: a compaction instead
  const nc = e.process(req(h, { max_tokens: 32_000 }), { attempt: 2, noClamp: true });
  assert.equal(nc.action, 'compact');
  assert.ok(nc.stats.tokensOut <= 67_000);
});

test('I7 fallback under injected faults: original only on attempt 1 and only if it fits ()', () => {
  const cfg = presetConfig('32k');
  const e = mk(cfg, estimateCounter(), { faults: 'engine-throw:1' });
  const small = req(session(1, 500));
  const a1 = e.process(small, { attempt: 1 });
  assert.equal(a1.action, 'guard_fallback');
  assert.equal(a1.request, small);
  assert.equal(a1.reason, 'engine:fault');
  const a2 = e.process(small, { attempt: 2 });
  assert.equal(a2.action, 'guard_reject');
  assert.equal(a2.request, null);
  assert.equal(a2.error?.status, 400);
  const big = req(session(6, 30_000));
  const b1 = e.process(big, { attempt: 1 });
  assert.equal(b1.action, 'guard_reject', 'a known-over-limit original is never forwarded');
});

test('counting failure (template error) forwards the original on attempt 1 only', () => {
  const cfg = testConfig({ tokenizer: { template: { name: 'qwen3' } } });
  const e = mk(cfg, estimateCounter('qwen3'));
  const bad = req([user('hi'), sys, user('x')]); // qwen3: system must be first
  const r1 = e.process(bad, { attempt: 1 });
  assert.equal(r1.action, 'guard_fallback');
  assert.equal(r1.reason, 'counting_failed');
  assert.equal(r1.request, bad);
  assert.equal(e.process(bad, { attempt: 2 }).action, 'guard_reject');
});

test('shadow mode computes but forwards the original; dryRun stores nothing', () => {
  const cfg = presetConfig('32k', { shadow: true });
  const store = new MemoryPlanStore({ maxPlans: 100, maxBytes: 1e9 });
  const e = mk(cfg, estimateCounter(), { store });
  const r = req(session(8, 20_000));
  const res = e.process(r, { attempt: 1 });
  assert.equal(res.action, 'shadow');
  assert.equal(res.request, r);
  assert.match(res.reason ?? '', /^shadow:(compact|reuse)$/);
  assert.ok(res.plan!.compactions >= 1);
  // shadow never blocks: a failing engine on an over-limit request still forwards the original
  const sf = mk(cfg, estimateCounter(), { faults: 'engine-throw:1' });
  const big = req(session(6, 30_000));
  const sr = sf.process(big, { attempt: 1 });
  assert.equal(sr.action, 'shadow');
  assert.equal(sr.request, big);
  assert.equal(sr.reason, 'shadow:guard_reject');
  const d = mk(presetConfig('32k'), estimateCounter(), { store: new MemoryPlanStore({ maxPlans: 100, maxBytes: 1e9 }) });
  d.process(req(session(8, 20_000)), { attempt: 1, dryRun: true });
  assert.equal(d.store.size(), 0);
});

test('merge-into-first-user: the summary is appended to the goal, no extra message', () => {
  const cfg = presetConfig('32k', { compaction: { summaryRole: 'merge-into-first-user' } });
  const r = req(session(10, 12_000));
  const res = mk(cfg).process(r, { attempt: 1 });
  assert.ok(res.plan!.compactions >= 1);
  const out = res.request!.messages;
  const goal = String(out[1]!.content);
  assert.ok(goal.startsWith('Task GOAL-1: do the thing.\n\n' + SUMMARY_HEADER));
  assert.equal(out[2]!.role, 'assistant');
});

test('client-written summary (OpenCode shape) stays verbatim in the head ()', () => {
  const cfg = presetConfig('32k');
  const cs: ChatMessage = { role: 'assistant', content: '## Objective\n- CS-ONLY-P4W7Q migrate\n\n## Next Move\n1. run specs' };
  const h: ChatMessage[] = [sys, user('What did we do so far?'), cs, ...session(10, 12_000).slice(2), user(cfg.client.boilerplateUserTexts[0]!)];
  const res = mk(cfg).process(req(h), { attempt: 1 });
  assert.ok(res.plan!.compactions >= 1);
  assert.equal(res.plan!.hEnd, 3);
  assert.equal(res.request!.messages[2], cs);
  assert.ok(String(res.request!.messages[3]!.content).startsWith(SUMMARY_HEADER));
});

test('reasoning.tail = drop removes reasoning from kept assistants at compaction', () => {
  const cfg = presetConfig('32k', { reasoning: { tail: 'drop' } });
  const h = session(10, 12_000).map((m) => (m.role === 'assistant' ? { ...m, reasoning_content: 'I think ' + words(50) } : m));
  const res = mk(cfg).process(req(h), { attempt: 1 });
  const p = res.plan!;
  assert.ok(p.compactions >= 1);
  // messages kept at the compaction lose their reasoning; later ones are appended verbatim (I6)
  const out = res.request!.messages;
  let checked = 0;
  for (let i = p.cut; i < h.length; i++) {
    const m = out[p.hEnd + 1 + (i - p.cut)]!;
    if (m.role !== 'assistant') continue;
    if (i < p.n) {
      assert.ok(!('reasoning_content' in m), `index ${i}`);
      checked++;
    } else assert.equal(m, h[i]);
  }
  assert.ok(checked >= 1);
});

test('replan diagnostics: new_session, inputs_changed, client_mutation ()', () => {
  const cfg = presetConfig('32k');
  const e = mk(cfg);
  const h = session(6, 3000);
  assert.equal(e.process(req(h), { attempt: 1 }).replan, 'new_session');
  const h2 = [...h, { role: 'assistant', content: 'more' }, user('ok')];
  assert.equal(e.process(req(h2), { attempt: 1 }).replan, undefined, 'one step from the previous boundary');
  const mutated = h2.map((m, i) => (i === 5 ? { ...m, content: '[Old tool result content cleared]' } : m));
  assert.equal(e.process(req(mutated), { attempt: 1 }).replan, 'client_mutation');
  const E = { ...e.learned('|m'), tighten: 256 };
  assert.equal(e.process(req(h2), { attempt: 1, learned: E }).replan, 'inputs_changed');
});

// ---------------------------------------------------------------- fit-loop rungs (§5.4 step 4)

const step = (i: number, content: string, tool = 'read', args = `{"filePath":"/f${i}.ts"}`): ChatMessage[] => [
  { role: 'assistant', content: `Step ${i}.`, tool_calls: [{ id: `k${i}`, type: 'function', function: { name: tool, arguments: args } }] },
  { role: 'tool', tool_call_id: `k${i}`, content },
];

test('R3: the mandatory unit oversized result is truncated head+tail (admission off)', () => {
  const cfg = presetConfig('32k', { oversize: { admission: false } });
  const h = [...session(3, 4000), ...step(9, words(40_000, 9))];
  const res = mk(cfg).process(req(h), { attempt: 1 });
  const p = res.plan!;
  assert.match(String(p.meta?.['rungs']), /R3/);
  const rw = p.rewrites[h.length - 1]!;
  assert.equal(rw.kind, 'truncate');
  assert.equal(rw.stage, 'compaction');
  assert.match(String(rw.message.content), /\[kitzur: this output was truncated/);
  assert.equal(p.fit, 'ok');
  assert.ok(res.stats.tokensOut <= res.stats.budget.hard);
});

test('R4 runs right after R1 when bytes drive the loop: images omitted, oldest first ()', () => {
  const img = (n: number) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(n) } });
  const cfg = presetConfig('32k', { upstream: { maxBodyBytes: 60_000 } });
  const h: ChatMessage[] = [...session(2, 3000), { role: 'user', content: [{ type: 'text', text: 'look' }, img(30_000), img(30_000)] }];
  const res = mk(cfg).process(req(h), { attempt: 1 });
  const p = res.plan!;
  assert.match(String(p.meta?.['rungs']), /R4/);
  const parts = res.request!.messages[res.request!.messages.length - 1]!.content as Array<{ type: string; text?: string }>;
  assert.equal(parts[1]!.type, 'text');
  assert.match(parts[1]!.text!, /image omitted/);
  assert.ok(Buffer.byteLength(JSON.stringify(res.request!.messages)) + 512 <= 60_000 + 30_100, 'one image was enough');
});

test('R5: the newest assistant\'s tool-call argument strings are cut; arguments stay valid JSON', () => {
  const cfg = presetConfig('32k');
  const args = JSON.stringify({ filePath: '/big.ts', content: words(30_000, 5) });
  const h = [...session(2, 2000), ...step(7, 'Wrote file.', 'write', args)];
  const res = mk(cfg).process(req(h), { attempt: 1 });
  const p = res.plan!;
  assert.match(String(p.meta?.['rungs']), /R5/);
  const a = res.request!.messages.find((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'k7')!;
  const parsed = JSON.parse(a.tool_calls![0]!.function.arguments) as { filePath: string; content: string };
  assert.equal(parsed.filePath, '/big.ts');
  assert.match(parsed.content, /\[kitzur: this output was truncated/);
  assert.ok(res.stats.tokensOut <= res.stats.budget.budget);
});

test('R8: a huge user message in the mandatory units is truncated as the last resort', () => {
  const cfg = presetConfig('32k');
  const h = [...session(3, 3000), user('USER-MARK-1 ' + words(40_000, 3) + ' USER-END-2')];
  const res = mk(cfg).process(req(h), { attempt: 1 });
  const p = res.plan!;
  assert.match(String(p.meta?.['rungs']), /R8/);
  const last = String(res.request!.messages[res.request!.messages.length - 1]!.content);
  assert.ok(last.startsWith('USER-MARK-1') && last.endsWith('USER-END-2'), 'head and tail of the user text survive');
  assert.ok(res.stats.tokensOut <= res.stats.budget.budget);
});

test('eager stubs (ablation): a newly superseded snapshot is stubbed without a compaction', () => {
  const cfg = presetConfig('100k', { rules: { snapshot: { stub: 'eager' } } });
  const e = mk(cfg);
  const snap = (i: number) => `### Page state\n- Page URL: https://x/${i}\n- Page Title: T${i}\n- Page Snapshot:\n` + Array.from({ length: 300 }, (_, j) => `- button "b${j}" [ref=e${j}]`).join('\n');
  let h: ChatMessage[] = [sys, user('Task GOAL-1')];
  let prevCompactions = 0;
  let stubbed = false;
  for (let i = 0; i < 6; i++) {
    h = [...h, ...step(i, snap(i), 'browser_snapshot', '{}')];
    const res = e.process(req(h), { attempt: 1 });
    const stubs = Object.values(res.plan!.rewrites).filter((r) => r.kind === 'stub').length;
    if (stubs > 0 && res.plan!.compactions === prevCompactions && res.action === 'compact') stubbed = true;
    prevCompactions = res.plan!.compactions;
    // mandatory units are never stubbed
    assert.equal(res.plan!.rewrites[h.length - 1]?.kind === 'stub', false);
  }
  assert.ok(stubbed);
});
