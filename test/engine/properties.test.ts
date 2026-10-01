// Property tests of DESIGN §1 over random chains (gen.ts), with the stub summarizer and rules:
// I1–I6,  (fresh engine on H[0..b) at every boundary), store caps 1–4, restart equivalence with
// and without the JSONL store (chain-check.ts), interleaved sessions, and I7 under fault injection.
// KITZUR_ENGINE_FUZZ=<chains> scales the run (default 40); KITZUR_ENGINE_SEED moves the seed base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genChain } from './gen.js';
import { oracleCounter } from './oracle.js';
import { devTokenizer, estimateCounter } from './stubs.js';
import { checkChain, engineFor, essence, newCoverage, optsFor, serverFits, tReq } from './chain-check.js';

const N = Number(process.env['KITZUR_ENGINE_FUZZ'] ?? 40);
const BASE_SEED = Number(process.env['KITZUR_ENGINE_SEED'] ?? 1000);
const hasTok = devTokenizer() !== null;

test(`random chains: I1–I6, , store caps, restart (${N} chains, seed ${BASE_SEED})`, (t) => {
  const cov = newCoverage();
  for (let i = 0; i < N; i++) checkChain(genChain(BASE_SEED + i, { exact: hasTok }), cov);
  // coverage minimums (), scaled to this suite
  const pct = (x: number): number => (100 * x) / cov.chains;
  const report = JSON.stringify(cov);
  t.diagnostic(`coverage ${report}`);
  assert.ok(pct(cov.compact) >= 25, `compact coverage ${report}`);
  assert.ok(pct(cov.admission) >= 5, `admission coverage ${report}`);
  assert.ok(pct(cov.oversize) >= 5, `oversize coverage ${report}`);
  assert.ok(pct(cov.slim) >= 2, `slim coverage ${report}`);
  if (N >= 40) {
    assert.ok(cov.impossible + cov.truncate >= 1, `§5.7 coverage ${report}`);
    assert.ok(cov.clamp >= 1, `clamp coverage ${report}`);
  }
  assert.ok(cov.i6pairs >= cov.requests / 10, `I6 pairs ${report}`);
});

test('interleaved sessions on one engine == each session alone (determinism)', () => {
  for (let i = 0; i < 8; i++) {
    const chains = [0, 1, 2].map((j) => genChain(BASE_SEED + 5000 + 3 * i + j, { exact: false }));
    // one engine serves all three: give them the first chain's config and template
    const cs = chains.map((c) => ({ ...c, cfg: chains[0]!.cfg, template: chains[0]!.template, mode: 'estimate' as const }));
    const counter = estimateCounter(cs[0]!.template);
    const alone = cs.map((c) => {
      const e = engineFor(c, counter);
      return c.requests.map((r, k) => essence(e.process(r, optsFor(c, k, counter))));
    });
    const sharedCounter = estimateCounter(cs[0]!.template);
    const shared = engineFor(cs[0]!, sharedCounter);
    const idx = [0, 0, 0];
    for (let step = 0; idx.some((x, j) => x < cs[j]!.requests.length); step++) {
      const j = step % 3;
      const k = idx[j]!;
      if (k >= cs[j]!.requests.length) continue;
      idx[j]!++;
      assert.equal(essence(shared.process(cs[j]!.requests[k]!, optsFor(cs[j]!, k, sharedCounter))), alone[j]![k], `interleaved chain ${j} request ${k}`);
    }
  }
});

test('I7 under fault injection: the original only on attempt 1 and only when it fits ()', () => {
  let fallbacks = 0;
  let rejects = 0;
  for (let i = 0; i < 40; i++) {
    const c = genChain(BASE_SEED + 9000 + i, { exact: false });
    const counter = estimateCounter(c.template);
    const e = engineFor(c, counter, undefined, { faults: 'engine-throw:0.3' });
    const oc = oracleCounter(c.template, 'estimate');
    for (let k = 0; k < c.requests.length; k++) {
      const req = c.requests[k]!;
      const r1 = e.process(req, optsFor(c, k, counter));
      if (r1.reason === 'engine:fault') {
        if (r1.action === 'guard_fallback') {
          fallbacks++;
          assert.equal(r1.request, req);
          assert.ok(serverFits(r1.stats.budget, oc(req), tReq(req, c.cfg.budget.defaultMaxTokens)), `seed ${c.seed} request ${k}`);
        } else {
          rejects++;
          assert.equal(r1.action, 'guard_reject');
          assert.equal(r1.request, null);
        }
      }
      // a retry never FALLS BACK to the original (); whether an unchanged plan may be resent is the
      // recovery ladder's strictly-smaller rule (§8, ), not the engine's
      const r2 = e.process(req, { ...optsFor(c, k, counter), attempt: 2 });
      assert.notEqual(r2.action, 'guard_fallback', `attempt 2 fell back (seed ${c.seed} request ${k})`);
      if (r2.reason === 'engine:fault') assert.equal(r2.request, null);
    }
  }
  assert.ok(fallbacks > 0 && rejects > 0, `fallbacks ${fallbacks} rejects ${rejects}`);
});
