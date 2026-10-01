// Regression tests for the regression engine performance changes: each cache must be invisible in results.
//   - ledger supersession: sentence analyses cached by text (a 300k-character goal made every compaction step
//     re-split and re-scan all user messages); statuses stay per call;
//   - superseded-snapshot stubs cached by result digest (the same object every time);
//   - the counter remembers the digests the engine passes (the proxy's later countRequest of the same message
//     objects no longer re-hashes the history), with identical counts;
//   - floorTokens comes from a budget-0 render: the summarizer's floorTokens is independent of the budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { supersede, supersedeRules } from '../../src/engine/ledger/supersede.js';
import { stubFor, type ResultsEnv } from '../../src/engine/results.js';
import { Lru } from '../../src/engine/lru.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { createSummarizerExt } from '../../src/engine/summary.js';
import { createCounter } from '../../src/tokenize/counter.js';
import { digestOf } from '../../src/tokenize/canonical.js';

const cfg = structuredClone(DEFAULT_CONFIG);

test('supersession: cached sentence analyses give identical, independent results', () => {
  const rules = supersedeRules(cfg.ledger);
  const goal = 'Use staging-3 for every run. ' + 'Keep the cart tests green. '.repeat(2000);
  const msgs = [
    { index: 1, text: goal, head: true },
    { index: 5, text: 'Always use the page object for checkout. Run tests on chromium.', head: false },
    { index: 9, text: 'Actually, use the API helper instead of the page object for checkout.', head: false },
  ];
  const a = supersede(msgs, rules, new Set());
  const b = supersede(msgs, rules, new Set());
  const view = (r: ReturnType<typeof supersede>): unknown => ({
    events: r.events, amends: [...r.amends], sentences: [...r.sentences].map(([i, ss]) => [i, ss.map((s) => [s.sentence.text, s.supersededBy])]),
  });
  assert.deepEqual(view(b), view(a));
  assert.ok(a.events.some((e) => e.rule === 'overlap' && e.target === 5), JSON.stringify(a.events));
  // statuses are per call: changing one result does not leak into the next call
  for (const ss of a.sentences.values()) for (const s of ss) s.supersededBy = 999;
  const c = supersede(msgs, rules, new Set());
  assert.deepEqual(view(c), view(b));
  // and a rules object built from an equal config shares the analysis without changing results
  assert.deepEqual(view(supersede(msgs, supersedeRules(structuredClone(cfg.ledger)), new Set())), view(b));
});

test('supersession: repeated ledger builds over a huge goal are fast (analysis cached)', () => {
  const rules = supersedeRules(cfg.ledger);
  const goal = 'Task GOAL-7: ' + Array.from({ length: 20_000 }, (_, i) => `step ${i} checks the cart total and the promo field.`).join(' ');
  const msgs = [{ index: 1, text: goal, head: true }, ...Array.from({ length: 30 }, (_, i) => ({ index: 10 + i, text: `Actually, use staging-${i} instead of staging-${i - 1}.`, head: false }))];
  const time = (f: () => void, n: number): number => {
    const t0 = performance.now();
    for (let k = 0; k < n; k++) f();
    return (performance.now() - t0) / n;
  };
  // uncached: a rules object with its own ignore set never shares the analysis cache
  let salt = 0;
  const cold = time(() => supersede(msgs, supersedeRules({ ...cfg.ledger, stopWords: [`zz${salt++}`] }), new Set()), 3);
  supersede(msgs, rules, new Set());
  const warm = time(() => supersede(msgs, rules, new Set()), 10);
  // relative, so that a loaded machine does not fail it: the cached build skips splitting and scanning the goal
  assert.ok(warm < cold / 2, `cached ${warm.toFixed(1)} ms vs uncached ${cold.toFixed(1)} ms per build`);
});

test('stubFor: cached by result digest, the same object, equal to the uncached stub', () => {
  const rules = createToolRules(cfg);
  const counter = createCounter({ mode: 'estimate', template: 'sim' });
  const snap = ['### Page state', '- Page URL: https://shop/checkout', '- Page Title: Checkout', '- Page Snapshot:', '```yaml',
    ...Array.from({ length: 80 }, (_, i) => `- button "Pay ${i}" [ref=e${i}]`), '```'].join('\n');
  const msgs: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: snap },
  ];
  const size = (m: ChatMessage): number => counter.measure({ messages: [m] }).total;
  const base = { msgs, digests: msgs.map((m) => digestOf(m)), rules, classify: new Lru<string, never>(16), size };
  const uncached = stubFor(base as ResultsEnv, 1);
  const env: ResultsEnv = { ...(base as ResultsEnv), stubs: new Lru(16) };
  const s1 = stubFor(env, 1);
  const s2 = stubFor(env, 1);
  assert.ok(s1 !== null && uncached !== null);
  assert.equal(s2, s1);
  assert.deepEqual(s1, uncached);
});

test('counter: digests passed by the engine are reused by countRequest with identical counts', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello ' + 'x'.repeat(5000) },
    { role: 'assistant', content: 'ok' },
  ];
  const a = createCounter({ mode: 'estimate', template: 'qwen3' });
  const b = createCounter({ mode: 'estimate', template: 'qwen3' });
  const ds = msgs.map((m) => digestOf(m));
  const viaEngine = a.measure({ messages: msgs }, ds).total;
  assert.equal(a.countRequest({ messages: msgs }), viaEngine);
  assert.equal(b.countRequest({ messages: msgs }), viaEngine);
});

test('summarizer: floorTokens does not depend on the budget (the compaction step renders it at budget 0)', () => {
  const counter = createCounter({ mode: 'estimate', template: 'sim' });
  const S = createSummarizerExt(cfg, counter);
  const msgs: ChatMessage[] = [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: 'Task GOAL-7: fix checkout.' }];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'assistant', content: `DECISION-D${i}: use testids. Working on step ${i}.`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: `/repo/f${i}.ts` }) } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: `content of f${i}\n`.repeat(40) });
    if (i % 4 === 1) msgs.push({ role: 'user', content: `Also keep rule R-${i} in mind.` });
  }
  const input = { messages: msgs, digests: msgs.map((m) => digestOf(m)), hEnd: 2, cut: msgs.length - 2, compaction: 1 };
  const f0 = S.render(input, { budgetTokens: 0, allowFloorEviction: false, userShortenStep: 0 }).floorTokens;
  for (const b of [50, 400, 2000, 25_000]) {
    assert.equal(S.render(input, { budgetTokens: b, allowFloorEviction: false, userShortenStep: 0 }).floorTokens, f0, `budget ${b}`);
  }
  assert.ok(f0 > 0);
});

test('supersession: the word index picks exactly what the full scan picks (random corpora)', async () => {
  const { cues, contentWords, explicitIds, overlapCoefficient } = await import('../../src/engine/ledger/supersede.js');
  const { splitSentences } = await import('../../src/engine/ledger/text.js');
  const rules = supersedeRules(cfg.ledger);
  // the pre-index algorithm (full scan over the pool), as reference
  const reference = (msgs: Array<{ index: number; text: string; head: boolean }>): unknown[] => {
    type C = { index: number; ord: number; head: boolean; ids: string[]; words: Set<string>; sup: number | null };
    const pool: C[] = [];
    const events: unknown[] = [];
    for (const msg of msgs) {
      const own: C[] = splitSentences(msg.text).map((s, ord) => ({ index: msg.index, ord, head: msg.head, ids: explicitIds(s.text), words: contentWords(s.text, rules.ignore), sup: null, text: s.text } as C & { text: string }));
      if (!msg.head) {
        for (const c of own as Array<C & { text: string }>) {
          if (!cues(c.text, rules)) continue;
          const ids = c.ids;
          if (ids.length) {
            const hit = pool.filter((p) => !p.head && p.sup === null && p.ids.some((x) => ids.includes(x)));
            if (hit.length) {
              for (const p of hit) {
                p.sup = msg.index;
                events.push(['id', msg.index, p.index, p.ord]);
              }
              continue;
            }
          }
          if (rules.additive.test(c.text)) continue;
          let best: C | null = null;
          let bestScore = -1;
          for (const p of pool) {
            if (p.sup !== null) continue;
            const s = overlapCoefficient(p.words, c.words);
            if (s >= rules.minOverlap && s >= bestScore) {
              best = p;
              bestScore = s;
            }
          }
          if (!best) continue;
          if (best.head) events.push(['amends', msg.index, best.index, best.ord]);
          else {
            best.sup = msg.index;
            events.push(['overlap', msg.index, best.index, best.ord]);
          }
        }
      }
      pool.push(...own);
    }
    return events;
  };
  const words = ['staging', 'cart', 'promo', 'checkout', 'firefox', 'chromium', 'helper', 'page', 'object', 'tests', 'legacy', 'selector', 'USER-RULE-Q7', 'VP-OLD-K7Q2M'];
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed % n;
  };
  for (let t = 0; t < 300; t++) {
    const msgs: Array<{ index: number; text: string; head: boolean }> = [];
    const n = 2 + rnd(8);
    for (let i = 0; i < n; i++) {
      const sents: string[] = [];
      for (let k = 0, m = 1 + rnd(3); k < m; k++) {
        const ws = Array.from({ length: 2 + rnd(5) }, () => words[rnd(words.length)]!);
        const cue = rnd(3) === 0 ? ['Actually,', 'Instead', 'Correction:', 'Also'][rnd(4)]! + ' ' : '';
        sents.push(cue + ws.join(' ') + '.');
      }
      msgs.push({ index: i + 1, text: sents.join(' '), head: i === 0 });
    }
    const got = supersede(msgs, rules, new Set()).events.map((e) => [e.rule, e.by, e.target, e.sentence]);
    assert.deepEqual(got, reference(msgs), JSON.stringify(msgs));
  }
});
