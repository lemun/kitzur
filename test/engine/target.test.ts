// compaction.targetFraction is honored by the cut walk (DESIGN §5.4 step 2, ): the tail after a compaction is the
// largest run of whole units with count(head) + summaryBudget + count(tail) ≤ target, never cut below the kept-always
// units. Regression for the component B2 sweep observation (qa46 at 100k: targetFraction 0.30 and 0.35 gave
// byte-identical runs). Measured cause: on qa46 the newest assistant unit alone is 14–18k tokens, so
// head 9,376 + summaryBudget 2,680 + that unit exceeds both targets (18,300 / 21,350) and the cut stays at the
// kept-always unit; the target is honored, it just cannot bind. These tests pin both halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatRequest, EngineResult, TokenCounter } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { createEngine } from '../../src/engine/engine.js';
import { computeBudget } from '../../src/engine/budget.js';
import { estimateCounter, exactCounter, presetConfig, StubRules, StubSummarizer } from './stubs.js';

const counterFor = (): TokenCounter => exactCounter('sim') ?? estimateCounter('sim');
/** the client's requests of a session, one per tool step, through one engine; returns every result */
function runChain(cfg: Config, msgs: ChatMessage[], counter: TokenCounter): EngineResult[] {
  const e = createEngine(cfg, { counter, summarizer: new StubSummarizer(cfg, counter), rules: new StubRules(cfg), faults: null });
  const out: EngineResult[] = [];
  for (let n = 4; n <= msgs.length; n += 2) out.push(e.process({ model: 'm', messages: msgs.slice(0, n), max_tokens: 32_000 } as ChatRequest, { attempt: 1 }));
  return out;
}
const compactions = (rs: EngineResult[]): EngineResult[] => rs.filter((r) => r.action === 'compact');

const words = (n: number, seed: number): string => {
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'][x % 8] + (i % 12 === 11 ? '.\n' : ' ');
  }
  return s;
};
/** a tool session; result i has sizes[i] words */
function session(sizes: number[]): ChatMessage[] {
  const h: ChatMessage[] = [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'Task GOAL-1: do the thing.' }];
  sizes.forEach((n, i) => {
    h.push({ role: 'assistant', content: `Step ${i}.`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: `{"filePath":"/f${i}.ts"}` } }] });
    h.push({ role: 'tool', tool_call_id: `c${i}`, content: words(n, i + 1) });
  });
  return h;
}
const cfgAt = (g: number): Config => presetConfig('100k', { compaction: { targetFraction: g } });
const targetOf = (cfg: Config): number => computeBudget(cfg, { window: null, maxPrompt: null, tighten: 0, maxBodyBytes: null } as never, 0, 32_000).target;

test('targetFraction moves the cut when units are small: larger target keeps more tail, every tail fits the target', () => {
  const counter = counterFor();
  const msgs = session(Array.from({ length: 80 }, () => 800)); // 80 units of ~1k tokens, well over trigger 61,000
  const firstCut: number[] = [];
  for (const g of [0.3, 0.35, 0.45]) {
    const cfg = cfgAt(g);
    const target = targetOf(cfg);
    const cs = compactions(runChain(cfg, msgs, counter));
    assert.ok(cs.length >= 1, `g=${g}: no compaction`);
    for (const r of cs) {
      // forwarded = head + summary (≤ summaryBudget) + tail ≤ target ()
      assert.ok(r.stats.tokensOut <= target, `g=${g}: forwarded ${r.stats.tokensOut} > target ${target}`);
      // maximal: one more unit (~1k tokens) would have fit if the forwarded prompt stopped this far below the target
      assert.ok(r.stats.tokensOut > target - 1_100 - 2_680, `g=${g}: forwarded ${r.stats.tokensOut} stops far below target ${target}`);
    }
    firstCut.push(cs[0]!.plan!.n - cs[0]!.plan!.cut); // messages kept after the summary
  }
  assert.ok(firstCut[0]! < firstCut[1]! && firstCut[1]! < firstCut[2]!, `kept tail not monotone in target: ${firstCut}`);
});

test('qa46 shape: when head + summaryBudget + the newest unit exceed the target, 0.30 and 0.35 give the same plan (cut at the kept-always unit)', () => {
  const counter = counterFor();
  // older units ~1k tokens, the newest assistant unit ~20k tokens (qa46 at 100k: kept-always tail 14–18k)
  const msgs = session([...Array.from({ length: 58 }, () => 800), 16_500]);
  const last = (g: number): EngineResult => runChain(cfgAt(g), msgs, counter).at(-1)!;
  const res = [0.3, 0.35].map(last);
  const lastAssistant = msgs.length - 2;
  for (const r of res) {
    assert.equal(r.action, 'compact', 'the big unit triggers the (only) compaction');
    assert.equal(r.plan!.cut, lastAssistant, 'cut at the kept-always (= mandatory) unit');
    // (the walk reserves summaryBudget 2,680; head + 2,680 + the ~19k unit is over both targets, while the stub's
    // actual summary is far smaller, so the forwarded count itself may land under the target)
  }
  assert.equal(JSON.stringify(res[0]!.request!.messages), JSON.stringify(res[1]!.request!.messages), 'identical forwarded bodies');
  // a target above head + summaryBudget + that unit keeps older units again, and still fits it
  const big = last(0.6);
  assert.equal(big.action, 'compact');
  assert.ok(big.plan!.cut < lastAssistant, `target ${targetOf(cfgAt(0.6))} should keep older units (cut ${big.plan!.cut})`);
  assert.ok(big.stats.tokensOut <= targetOf(cfgAt(0.6)));
});
