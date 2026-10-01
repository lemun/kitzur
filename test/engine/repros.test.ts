// Frozen fuzz repros for the two engine bugs fixed in benchmark component, replayed through the fuzz invariants
// (bench/fuzz/invariants.ts). Unlike the seed-based tests in test/fuzz/fuzz.test.ts these do not depend on the
// generator staying the same: each file is the shrunk chain (bench/fuzz/shrink.ts) produced against a build with
// the fix reverted, so it fails there and passes with the fix.
//
//   repro-4873 (32k, sim, exact, clamp on; 1 request, 9 messages) — : R2 asked for a summary below the floor,
//     got the floor size back, but recorded the smaller request as the level; R6 then started from that level and
//     evicted every floor item for an overshoot of a few tokens. Fix: src/engine/plan.ts, R2 records
//     max(requested, rendered).
//   repro-8648 (16k, sim, exact; 2 requests, 6 messages) — retry with extraTighten 2000 + noClamp: the compaction
//     step accepted a plan that was fewer tokens but more bytes than its input, and the guard rejected it
//     (guard:larger_bytes) although the original fit. Fix: Counting.smaller (tokens strictly smaller, bytes not
//     larger) for every rewrite acceptance and a byte comparison in the no-gain check (src/engine/count.ts, plan.ts).
//     The seed-based 8648 test in test/fuzz only reaches this retry with the fault RNG of the full checks; this
//     frozen chain replays it directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { checkChain, DEFAULT_CHECKS, type CheckOptions } from '../../bench/fuzz/invariants.js';
import { fromRepro, type Repro } from '../../bench/fuzz/shrink.js';
import { fuzzTokenizer } from '../../bench/fuzz/run.js';
import { ROOT } from '../helpers.js';

const load = (seed: number): Repro =>
  JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'engine', 'repros', `repro-${seed}.json.gz`))).toString('utf8')) as Repro;
const skip = fuzzTokenizer() ? false : 'no dev tokenizer (exact-mode repros)';

const cases: Array<{ seed: number; inv: string; checks: CheckOptions }> = [
  { seed: 4873, inv: 'ledger-fit', checks: { ...DEFAULT_CHECKS, freshEvery: 1, boundaryReplay: 1, caps: false, restart: false, faults: 0, ledgerFit: true } },
  { seed: 8648, inv: 'retry-guard', checks: DEFAULT_CHECKS },
];

for (const { seed, inv, checks } of cases) {
  test(`frozen fuzz repro ${seed} (${inv}): no invariant violation`, { skip }, () => {
    const r = load(seed);
    assert.equal(r.inv, inv, 'the repro was shrunk for this invariant');
    const o = checkChain(fromRepro(r), fuzzTokenizer(), checks);
    assert.deepEqual(o.violations, []);
    if (inv === 'ledger-fit') assert.ok(o.checks.ledgerFit >= 1, 'the ledger-fit check ran');
    else assert.ok(o.checks.retries >= 1, 'the retry ran');
  });
}
