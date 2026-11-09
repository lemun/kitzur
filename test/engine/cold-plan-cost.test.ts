// Pins the counting work of ONE cold planning pass (no stored plan, as after a proxy restart) over long histories,
// by counter calls rather than time, so it is deterministic and not flaky. The history and engine are built as in
// bench/perf-baseline.ts (history() and runCase()). The cost grows faster than linearly with history length; this
// test notices if it gets much worse. A deliberate planner change that moves these numbers should update the
// bounds below in the same commit. It stops at 800 messages because larger cold passes are too slow for the suite:
// a 1630-message pass took about 4 s and a 4006-message pass about 70 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatRequest } from '../../src/types.js';
import { loadConfig } from '../../src/config/load.js';
import { createEngine } from '../../src/engine/engine.js';
import { createSummarizer } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import { genChain } from '../../bench/fuzz/gen.js';

const TOOLS = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } }];

/** At least `n` messages: the final requests of the fuzz chains of seeds 1, 2, ... concatenated (as bench/perf-baseline.ts). */
function history(n: number): ChatMessage[] {
  const h: ChatMessage[] = [];
  for (let seed = 1; h.length < n; seed++) {
    const id = (x: string): string => `s${seed}_${x}`;
    for (const m of genChain(seed, { exact: false, http: true }).requests.at(-1)!.messages) {
      if (h.length > 0 && (m.role === 'system' || m.role === 'developer')) continue;
      const x: ChatMessage = { ...m, content: typeof m.content === 'string' ? m.content.slice(0, 2048) : m.content };
      if (m.tool_calls) x.tool_calls = m.tool_calls.map((c) => ({ ...c, id: id(c.id) }));
      if (m.tool_call_id !== undefined) x.tool_call_id = id(m.tool_call_id);
      h.push(x);
    }
  }
  return h;
}

/** One cold process() over the history with a fresh engine and counter; the counter's call counts afterwards. */
function coldPass(n: number): { messages: number; measures: number; pieceHits: number } {
  const cfg = loadConfig({ preset: '32k', env: {}, sets: ['calibration.enabled=false'] }).config;
  const counter = counterFromConfig(cfg);
  const e = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg), faults: null });
  const messages = history(n);
  e.process({ model: 'qwen', messages, tools: TOOLS, max_tokens: cfg.budget.defaultMaxTokens } as ChatRequest, { attempt: 1 });
  const { measures, pieceHits } = counter.stats();
  return { messages: messages.length, measures, pieceHits };
}

// Measured: 218 msgs 99 / 2989, 412 msgs 199 / 7239, 804 msgs 475 / 26590 (measures / pieceHits); bounds ~30% above.
const BOUNDS = [
  { n: 200, measures: 130, pieceHits: 3_900 },
  { n: 400, measures: 260, pieceHits: 9_400 },
  { n: 800, measures: 620, pieceHits: 34_600 },
];

test('one cold planning pass stays within its counting budget at 200, 400 and 800 messages', () => {
  const runs = BOUNDS.map((b) => ({ b, r: coldPass(b.n) }));
  for (const { b, r } of runs) {
    assert.ok(r.messages >= b.n, `history of ${r.messages} messages, wanted at least ${b.n}`);
    assert.ok(r.measures <= b.measures, `${r.messages} msgs: ${r.measures} measures > ${b.measures}`);
    assert.ok(r.pieceHits <= b.pieceHits, `${r.messages} msgs: ${r.pieceHits} pieceHits > ${b.pieceHits}`);
  }
  const [, mid, big] = runs.map((x) => x.r);
  assert.ok(big!.measures / mid!.measures < 3.5, `measures grew ${(big!.measures / mid!.measures).toFixed(2)}x from ${mid!.messages} to ${big!.messages} msgs`);
  assert.ok(big!.pieceHits / mid!.pieceHits < 5, `pieceHits grew ${(big!.pieceHits / mid!.pieceHits).toFixed(2)}x from ${mid!.messages} to ${big!.messages} msgs`);
});

test('a cold planning pass counts the same work every time', () => {
  assert.deepEqual(coldPass(200), coldPass(200));
});
