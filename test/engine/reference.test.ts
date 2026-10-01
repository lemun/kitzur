// The reference scenario through the engine, request by request (sim template, exact counts, the bench
// mock's counter as the oracle): the §1 invariants on the 46-step session at every preset window, the
// chatty 80-step variant and the huge-output variants (SIM_HUGE_AT=20, uncapped: 150k/180k/400k), plus
// the headline numbers at 100k/32k against gobstopper tuned (7 compactions, 1,734,118, peak 60,984).
// Uses benchmark component's real summarizer and rules when they are built, else the test stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScenarioOptions } from '../../bench/scenarios/reference.js';
import { checkChain, newCoverage, type ChainSpec, type Parts } from './chain-check.js';
import { describe, loadParts, runReference } from './ref-run.js';
import { devTokenizer, exactCounter, presetConfig, PRESETS, referenceRequests } from './stubs.js';

const tok = devTokenizer();
const skip = tok ? false : 'dev tokenizer missing (scripts/fetch-tokenizer.sh)';
const loaded = await loadParts();
const parts: Parts = { summarizer: loaded.summarizer, rules: loaded.rules };

function spec(window: keyof typeof PRESETS, scenario: ScenarioOptions, steps: number): ChainSpec {
  const cfg = presetConfig(window, { tokenizer: { template: { name: 'sim' } } });
  const requests = referenceRequests(steps, scenario, PRESETS[window]!.out);
  return { seed: 0, cfg, template: 'sim', mode: 'exact', requests, learned: requests.map(() => null), mutated: requests.map(() => false) };
}

const variants: Array<[string, keyof typeof PRESETS, ScenarioOptions, number]> = [
  ['qa46 32k', '32k', { capBytes: 51_200 }, 46],
  ['qa46 64k', '64k', { capBytes: 51_200 }, 46],
  ['qa46 100k', '100k', { capBytes: 51_200 }, 46],
  ['qa46 128k', '128k', { capBytes: 51_200 }, 46],
  ['chatty80 100k', '100k', { capBytes: 51_200, chatty: true }, 80],
  ['chatty80 32k', '32k', { capBytes: 51_200, chatty: true }, 80],
  ['huge150k 64k', '64k', { capBytes: 0, hugeAt: 20, hugeChars: 150_000 }, 46],
  ['huge180k 100k', '100k', { capBytes: 0, hugeAt: 20, hugeChars: 180_000 }, 46],
  ['huge180k 32k', '32k', { capBytes: 0, hugeAt: 20, hugeChars: 180_000 }, 46],
  ['huge400k 100k', '100k', { capBytes: 0, hugeAt: 20, hugeChars: 400_000 }, 46],
];

for (const [name, w, sc, steps] of variants) {
  test(`reference ${name} (${loaded.real ? 'real' : 'stub'} summarizer): I1–I6, fresh,  sample, restart`, { skip }, () => {
    const s = spec(w, sc, steps);
    const cov = newCoverage();
    const results = checkChain(s, cov, { parts, counter: exactCounter('sim')!, freshEvery: 15, boundaryReplay: 4, caps: false });
    assert.ok(cov.compact === 1, 'compacts');
    for (const r of results) {
      assert.ok(r.action !== 'guard_fallback' && r.action !== 'guard_reject' && r.action !== 'impossible', `${r.action}: ${r.reason}`);
      assert.ok(r.stats.tokensOut <= r.stats.budget.budget, 'every request within the budget');
    }
  });
}

test('reference 100k/32k headline numbers vs gobstopper tuned', { skip }, async () => {
  const r = await runReference({ window: '100k' });
  console.log(describe(r));
  assert.equal(r.overBudget, 0);
  assert.ok(r.peak <= r.hard, `peak ${r.peak} <= hard ${r.hard}`);
  assert.ok(r.tokens <= Math.round(1_734_118 * 1.1), `G3 bound: ${r.tokens}`);
  assert.ok(r.restartEqual);
  if (r.summarizer === 'real') for (const [k, v] of Object.entries(r.factMisses)) assert.equal(v, 0, `fact ${k}`);
});
