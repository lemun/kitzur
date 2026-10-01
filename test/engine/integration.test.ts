// The engine with benchmark component's real summarizer (src/engine/summary.ts createSummarizer) and tool rules
// (src/engine/rules/index.ts createToolRules), loaded dynamically: skipped while they are not built.
// Random chains through every §1 check, and the summary shape and fact survival on the reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../../src/config/schema.js';
import type { TokenCounter } from '../../src/types.js';
import { SUMMARY_HEADER, type Summarizer, type ToolRules } from '../../src/engine/contracts.js';
import { checkChain, newCoverage, type Parts } from './chain-check.js';
import { genChain } from './gen.js';
import { devTokenizer, exactCounter, presetConfig, referenceRequests } from './stubs.js';
import { createEngine } from '../../src/engine/engine.js';

let parts: Parts | null = null;
try {
  const s = (await import('../../src/engine/summary.js')) as { createSummarizer?: (c: Config, t: TokenCounter) => Summarizer };
  const r = (await import('../../src/engine/rules/index.js')) as { createToolRules?: (c: Config) => ToolRules };
  if (typeof s.createSummarizer === 'function' && typeof r.createToolRules === 'function') {
    parts = { summarizer: s.createSummarizer, rules: r.createToolRules };
  }
} catch {
  parts = null;
}
const skip = parts ? false : 'real summarizer/rules not built yet';
const N = Number(process.env['KITZUR_ENGINE_FUZZ_REAL'] ?? 15);

const SEED = Number(process.env['KITZUR_ENGINE_SEED_REAL'] ?? 30_000);
test(`real summarizer and rules: random chains through I1–I6, , caps, restart (${N} chains)`, { skip }, (t) => {
  const cov = newCoverage();
  for (let i = 0; i < N; i++) checkChain(genChain(SEED + i, { exact: devTokenizer() !== null }), cov, { parts: parts! });
  t.diagnostic(`coverage ${JSON.stringify(cov)}`);
  assert.ok(cov.compact >= N / 4, JSON.stringify(cov));
});

test('real summarizer on the reference at 32k: header first, trailer last, every compaction keeps the goal in the head', { skip: skip || (devTokenizer() ? false : 'no tokenizer') }, () => {
  const cfg = presetConfig('32k', { tokenizer: { template: { name: 'sim' } } });
  const counter = exactCounter('sim')!;
  const e = createEngine(cfg, { counter, summarizer: parts!.summarizer(cfg, counter), rules: parts!.rules(cfg), faults: null });
  let compactions = 0;
  for (const r of referenceRequests(46, { capBytes: 51_200 }, 8000)) {
    const res = e.process(r, { attempt: 1 });
    const p = res.plan!;
    if (p.summary !== null) {
      assert.ok(p.summary.startsWith(SUMMARY_HEADER));
      assert.match(p.summary, /\[kitzur\] Messages \d+–\d+ were compacted \(compaction \d+\)\.?\s*$/);
      assert.ok(String(res.request!.messages[1]!.content).includes('GOAL-CHK-7F3A'));
    }
    compactions = p.compactions;
  }
  assert.ok(compactions >= 10, `compactions ${compactions}`);
});
