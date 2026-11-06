import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatRequest, RetentionDecision } from '../../src/types.js';
import { createEngine } from '../../src/engine/engine.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { createSummarizerExt } from '../../src/engine/summary.js';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import { genChain } from './gen.js';
import { estimateCounter, testConfig } from './stubs.js';

const N = Number(process.env['KITZUR_ENGINE_FUZZ'] ?? 40);
const BASE_SEED = Number(process.env['KITZUR_ENGINE_SEED'] ?? 1000);
const categories = ['user', 'decision', 'todo', 'file', 'rest', 'narrative1', 'narrative2', 'toolLog'];
const reasons = ['user-instruction', 'protected-floor', 'priority-prefix', 'budget-eviction'];

function makeEngine(cfg: ReturnType<typeof testConfig>, counter = estimateCounter('sim')) {
  return { counter, engine: createEngine(cfg, { counter, summarizer: createSummarizerExt(cfg, counter), rules: createToolRules(cfg) }) };
}

function checkAttribution(seed: number, plan: NonNullable<ReturnType<ReturnType<typeof makeEngine>['engine']['process']>['plan']>) {
  const attrs = plan.summaryAttribution;
  assert.ok(attrs, `seed ${seed}: plan has no summary attribution`);
  const counts: Record<string, { kept: number; dropped: number }> = {};
  for (const a of attrs) {
    assert.ok(categories.includes(a.category), `seed ${seed}: unknown category ${a.category}`);
    assert.ok(['summarized', 'dropped'].includes(a.disposition), `seed ${seed}: invalid disposition ${a.disposition}`);
    assert.ok(reasons.includes(a.reason), `seed ${seed}: invalid reason ${a.reason}`);
    for (const index of a.supersededBy) {
      assert.ok(index !== a.sources[0]!.messageIndex, `seed ${seed}: item supersedes itself at ${index}`);
      assert.ok(index < plan.n, `seed ${seed}: superseder ${index} is outside the planned history`);
    }
    const c = counts[a.category] ??= { kept: 0, dropped: 0 };
    c[a.disposition === 'summarized' ? 'kept' : 'dropped']++;
  }
  for (const [category, count] of Object.entries(counts)) {
    assert.ok(count.kept + count.dropped > 0, `seed ${seed}: category ${category} has no outcomes`);
  }
}

function run(cfg: ReturnType<typeof testConfig>, request: ChatRequest, counter?: ReturnType<typeof estimateCounter>) {
  const { counter: usedCounter, engine } = makeEngine(cfg, counter);
  const result = engine.process(request, { attempt: 1 });
  return { counter: usedCounter, result };
}

test(`retention properties across seeded chains (${N}, seed ${BASE_SEED})`, () => {
  for (let i = 0; i < N; i++) {
    const chain = genChain(BASE_SEED + i, { exact: false });
    const request = chain.requests.at(-1)!;
    const { counter, result } = run(chain.cfg, request);
    const seed = chain.seed;
    if (!result.plan?.summaryAttribution || !result.request) continue;
    checkAttribution(seed, result.plan);
    if (i % 10 === 0) {
      const summaryInput = { messages: request.messages.slice(0, result.plan.n), digests: [], hEnd: result.plan.hEnd, cut: result.plan.cut, compaction: result.plan.compactions };
      const summarizer = createSummarizerExt(chain.cfg, counter);
      const rungs = String(result.plan.meta?.['rungs'] ?? '');
      const allowFloorEviction = rungs.includes('R6') || rungs.includes('R7');
      const shortenSteps = rungs.includes('R7') ? [1, 2] as const : [0] as const;
      const rendered = shortenSteps.map((userShortenStep) =>
        summarizer.render(summaryInput, { budgetTokens: Number(result.plan!.meta?.['summaryTokens'] ?? result.stats.budget.summaryBudget), allowFloorEviction, userShortenStep }))
        .find((r) => canonicalJSON(r.attribution) === canonicalJSON(result.plan!.summaryAttribution));
      assert.ok(rendered, `seed ${seed}: summary attribution does not match any final render`);
      const renderedCounts: Record<string, { kept: number; dropped: number }> = {};
      for (const a of result.plan.summaryAttribution) {
        const c = renderedCounts[a.category] ??= { kept: 0, dropped: 0 };
        c[a.disposition === 'summarized' ? 'kept' : 'dropped']++;
      }
      for (const [category, count] of Object.entries(renderedCounts)) {
        assert.deepEqual(rendered.categories[category], count, `seed ${seed}: rendered ${category} counts disagree with attribution`);
      }
    }
    if (result.plan.fit !== 'over_budget') {
      const measured = counter.countRequest(result.request);
      assert.ok(measured <= result.stats.budget.budget || measured <= result.stats.budget.trigger,
        `seed ${seed}: compacted request ${measured} exceeds budget ${result.stats.budget.budget} and trigger ${result.stats.budget.trigger}`);
    }
    if (chain.cfg.compaction.summaryRole !== 'merge-into-first-user') {
      const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
      const lastUserIndex = lastUser ? request.messages.lastIndexOf(lastUser) : -1;
      if (lastUser && typeof lastUser.content === 'string' && lastUserIndex >= result.plan.cut) {
        assert.ok(result.request.messages.some((m) => canonicalJSON(m) === canonicalJSON(lastUser)), `seed ${seed}: latest tail user message missing or changed`);
      }
    }

    if (i % 10 === 0) {
      const fresh = run(chain.cfg, request, counter).result;
      assert.equal(canonicalJSON(result.plan.summaryAttribution), canonicalJSON(fresh.plan?.summaryAttribution), `seed ${seed}: attribution is nondeterministic`);
    }
  }
});

test('ranking and irrelevant request formatting preserve retention outcomes', () => {
  for (let i = 0; i < Math.min(N, 3); i++) {
    const chain = genChain(BASE_SEED + 20_000 + i, { exact: false });
    const request = chain.requests.at(-1)!;
    const off = testConfig({ ...chain.cfg, ledger: { ...chain.cfg.ledger, ranking: false } });
    const on = testConfig({ ...chain.cfg, ledger: { ...chain.cfg.ledger, ranking: true } });
    const a = run(off, request).result;
    const b = run(on, request).result;
    const c = run(testConfig(chain.cfg), request).result;
    const seed = chain.seed;
    const verbatim = (r: typeof a) => r.plan?.retention?.filter((d) => d.category === 'message' && d.disposition === 'verbatim')
      .flatMap((d) => d.sources.filter((s) => s.kind === 'message').map((s) => s.kind === 'message' ? s.messageIndex : -1)) ?? [];
    assert.equal(canonicalJSON(verbatim(a)), canonicalJSON(verbatim(b)), `seed ${seed}: ranking changed verbatim tail`);
    assert.equal(canonicalJSON(a.plan?.retention?.filter((d) => d.category !== 'message')), canonicalJSON(c.plan?.retention?.filter((d) => d.category !== 'message')), `seed ${seed}: default differs from ranking off`);

    const toolAt = request.messages.findIndex((m) => m.role === 'tool' && typeof m.content === 'string');
    if (toolAt >= 0) {
      const spaced = structuredClone(request);
      const tool = spaced.messages[toolAt]!;
      if (typeof tool.content === 'string') tool.content += '  \n';
      const d = run(off, spaced).result;
      assert.equal(canonicalJSON(a.plan?.retention), canonicalJSON(d.plan?.retention), `seed ${seed}: trailing tool whitespace changed dispositions`);
    }
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
    assert.equal(canonicalJSON(a.plan?.retention), canonicalJSON(run(off, reordered).result.plan?.retention), `seed ${seed}: request key order changed dispositions`);
  }
});

test('retention regressions: empty context, huge message, tool-only history, duplicate instructions, Hebrew and emoji', () => {
  const cases: Array<{ name: string; messages: ChatMessage[] }> = [
    { name: 'empty context', messages: [{ role: 'user', content: '' }, { role: 'assistant', content: 'x '.repeat(3000) }] },
    { name: 'single huge message', messages: [{ role: 'user', content: 'large '.repeat(12_000) }, { role: 'assistant', content: 'done' }] },
    { name: 'tool-only history', messages: [{ role: 'user', content: 'Inspect this.' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'output '.repeat(3000) }, { role: 'assistant', content: 'done' }] },
    { name: 'duplicate user instructions', messages: [{ role: 'user', content: 'Use the blue route.' }, { role: 'assistant', content: 'thinking '.repeat(500) }, { role: 'user', content: 'Use the blue route.' }, { role: 'assistant', content: 'done' }] },
    { name: 'Hebrew and emoji', messages: [{ role: 'user', content: 'שמור על ההנחיה הזאת 😀🚀' }, { role: 'assistant', content: 'תשובה '.repeat(1200) }, { role: 'user', content: 'עדיין לשמור 😀' }, { role: 'assistant', content: 'done' }] },
    { name: 'ordinary tool result', messages: [{ role: 'user', content: 'Read files.' }, { role: 'assistant', content: null, tool_calls: [{ id: 'd', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'd', content: 'result '.repeat(900) }, { role: 'assistant', content: 'done' }] },
  ];
  for (let i = 0; i < cases.length; i++) {
    const { name, messages } = cases[i]!;
    const seed = 90_000 + i;
    const cfg = testConfig({ budget: { window: 4000, defaultMaxTokens: 128 }, compaction: { triggerTokens: 900, targetTokens: 500 }, tokenizer: { template: { name: 'sim' } } });
    const { result } = run(cfg, { model: 'm', messages, max_tokens: 128 });
    if (result.plan?.summaryAttribution) checkAttribution(seed, result.plan);
    assert.ok(result, `seed ${seed} (${name}): engine returned no result`);
  }
});

