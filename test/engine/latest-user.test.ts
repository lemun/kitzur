// The latest user message under compaction (the rule is written down at keptStart's use in compact, plan.ts):
// it is forwarded verbatim while no assistant message follows it, because it then lies in the mandatory units; once
// the agent has answered it, it is an ordinary older unit that the cut walk may summarize (or drop when the ledger
// keeps no facts from it). Seeded chains (gen.ts) check the rule broadly; seed 1000 is the case that first showed
// the summarized latest user message, and a hand-made agent loop pins both sides of the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatRequest, EngineResult } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { createEngine } from '../../src/engine/engine.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { createSummarizerExt } from '../../src/engine/summary.js';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import { optsFor, type ChainSpec } from './chain-check.js';
import { genChain } from './gen.js';
import { estimateCounter, testConfig } from './stubs.js';

function runChain(c: ChainSpec): EngineResult[] {
  const counter = estimateCounter(c.template);
  const engine = createEngine(c.cfg, { counter, summarizer: createSummarizerExt(c.cfg, counter), rules: createToolRules(c.cfg), faults: null });
  return c.requests.map((request, k) => engine.process(request, optsFor(c, k, counter)));
}

function lastUser(ms: readonly ChatMessage[]): number {
  let i = ms.length - 1;
  while (i >= 0 && ms[i]!.role !== 'user') i--;
  return i;
}
const answered = (ms: readonly ChatMessage[], i: number): boolean => ms.slice(i + 1).some((m) => m.role === 'assistant');
const forwardedVerbatim = (r: EngineResult, m: ChatMessage): boolean =>
  r.request!.messages.some((x) => canonicalJSON(x) === canonicalJSON(m));
const outcomeOf = (r: EngineResult, i: number) =>
  r.plan!.retention!.find((d) => d.category === 'message' && d.sources[0]!.messageIndex === i)!;

test('seeded chains: an unanswered latest user message is never summarized; an answered one may be', () => {
  let unanswered = 0;
  let summarized = 0;
  for (let seed = 1000; seed < 1030; seed++) {
    const chain = genChain(seed, { exact: false });
    runChain(chain).forEach((r, k) => {
      if (!r.request || !r.plan?.summaryAttribution) return;
      const ms = chain.requests[k]!.messages;
      const i = lastUser(ms);
      if (i < r.plan.hEnd) return; // the head has its own policy (oversize.headPolicy)
      const o = outcomeOf(r, i);
      const at = `seed ${seed} request ${k}: latest user message ${i}`;
      if (!answered(ms, i)) {
        unanswered++;
        assert.ok(i >= r.plan.cut, `${at} is unanswered but was summarized (cut ${r.plan.cut})`);
        // only cut when it alone does not fit the budget (R8), or its images omitted (R4)
        if (o.disposition === 'excerpted') assert.ok(o.reason === 'truncate' || o.reason === 'image', `${at}: ${o.reason}`);
        else assert.ok(forwardedVerbatim(r, ms[i]!), `${at} is not forwarded verbatim`);
      } else if (i < r.plan.cut) {
        summarized++;
        assert.ok(o.disposition === 'summarized' || o.disposition === 'dropped', `${at}: ${o.disposition}`);
      }
    });
  }
  assert.ok(unanswered > 0, 'no compacted request ended with a user message');
  assert.ok(summarized > 0, 'no answered latest user message was summarized (seed 1000 request 2 is one)');
});

const cfg: Config = testConfig({
  budget: { window: 4000, defaultMaxTokens: 128 }, compaction: { triggerTokens: 900, targetTokens: 500 }, tokenizer: { template: { name: 'sim' } },
});
const call = (id: string): ChatMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"/repo/a.ts"}' } }] });
const result = (id: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: `output ${id} `.repeat(500) });
const LATEST: ChatMessage = { role: 'user', content: 'Also check the shipping page on https://shop.example.com.' };
const history: ChatMessage[] = [
  { role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'Fix the checkout test.' },
  call('c1'), result('c1'), call('c2'), result('c2'), LATEST, call('c3'), result('c3'), call('c4'), result('c4'),
];
const i = history.indexOf(LATEST);
const request = (end: number): ChatRequest => ({ model: 'm', messages: history.slice(0, end), max_tokens: 128 });
const chainOf = (ends: number[]): ChainSpec =>
  ({ seed: 0, cfg, template: 'sim', mode: 'estimate', requests: ends.map(request), learned: ends.map(() => null), mutated: ends.map(() => false) });

test('an agent loop: the latest user message is verbatim until the agent answers, then it may be summarized', () => {
  const [asked, working] = runChain(chainOf([i + 1, history.length]));
  assert.ok(asked!.plan?.summary, 'the request ending with the user message is compacted');
  assert.ok(forwardedVerbatim(asked!, LATEST), 'the unanswered latest user message is forwarded verbatim');
  assert.equal(outcomeOf(asked!, i).disposition, 'verbatim');

  // two tool rounds later the newest assistant unit alone exceeds the target: the user message is behind the cut
  assert.ok(working!.plan!.cut > i, `cut ${working!.plan!.cut} keeps the answered user message`);
  assert.ok(!forwardedVerbatim(working!, LATEST));
  assert.match(working!.plan!.summary!, /shipping page/, 'its instruction survives in the summary');
  assert.equal(outcomeOf(working!, i).disposition, 'summarized');
});
