// bench/run-all.ts (flags, --quick selection) and the report's B1 additions: the manifest filter (stale results are
// never reported), G7 / G9 from B2's latency.json / fuzz.json, the benchmark contract sweep selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, quickFilter } from '../../bench/run-all.js';
import { applyManifest, buildReport, gateG7, gateG9, sweepRows } from '../../bench/report.js';
import type { Cell } from '../../bench/matrix.js';
import type { ResultsFile, RunMetrics } from '../../bench/metrics/results.js';

test('run-all flags', () => {
  const o = parseArgs(['--quick', '--tier', 'T1,T2', '--only', 'kitzur/*/100k', '--resume', '--workers', '2', '--no-crosscheck']);
  assert.equal(o.quick, true);
  assert.deepEqual(o.tiers, ['T1', 'T2']);
  assert.equal(o.only, 'kitzur/*/100k');
  assert.equal(o.resume, true);
  assert.equal(o.workers, 2);
  assert.ok(!o.phases.includes('crosscheck'));
  assert.deepEqual(parseArgs([]).phases, ['crosscheck', 'matrix', 'ablations', 'sweep', 'fuzz', 'latency', 'report']);
  assert.throws(() => parseArgs(['--phases', 'nope']), /unknown phase/);
});

test('--quick: kitzur at 100k, comparators on the reference variants, G8 on qa46 at 32k/64k', () => {
  const c = (system: string, scenario: string, window: string, tier = 'T1'): Cell => ({ system, scenario, window, tier, family: 'F1', runKey: 'k', skip: null }) as Cell;
  assert.ok(quickFilter(c('kitzur', 'huge180k', '100k')));
  assert.ok(quickFilter(c('gobstopper-tuned', 'qa46', '100k')));
  assert.ok(!quickFilter(c('gobstopper-tuned', 'huge180k', '100k')));
  assert.ok(quickFilter(c('kitzur', 'qa46-ref', '32k')));
  assert.ok(!quickFilter(c('kitzur', 'talk80', '32k')));
  assert.ok(!quickFilter(c('kitzur', 'qa46-ref', '128k')));
  assert.ok(!quickFilter(c('kitzur-ledger-off', 'qa46-ref', '100k', 'T2')));
});

const M = {
  processed: 1_700_000, hit: 0.81, uncached: 330_000, b2b: 0, client_errors: 0, steps_ok: 46, steps: 46, peak: 60_000, compactions_generic: 7,
  rejections: 0, rejected: 0, processed_main_accepted: 1_700_000, processed_aux: 0, compactions_reported: 7, client_compactions: 0, hard: 61_000,
  lcp: 1_370_000, fresh: 300_000, fresh_synth: 0, L: 30_000, reusable: 0.98, hit_block16: 0.8, hit_global: 0.81, template_breaks: 0,
} as RunMetrics;
function r(system: string, runKey: string, over: Partial<ResultsFile> = {}, m: Partial<RunMetrics> = {}): ResultsFile {
  return {
    schema: 1, runKey, status: 'ok', reason: null, versions: { commit: null, node: 'v', gobSha: null, gobVersion: null, tokenizerSha: null, codeVersion: 'c' },
    system, systemLabel: system, scenario: 'qa46', family: 'F1', window: '100k', tier: 'T1', configHash: '', config: {}, driver: 'spec',
    metrics: { ...M, ...m }, facts: [], supersession: null, gates: {}, notes: [], perRequest: [], timing: null, ...over,
  };
}

test('manifest: only its runKeys are reported; listed cells without a results file are NOT RUN, never PASS', () => {
  const stale = r('kitzur', 'old');
  const cur = r('gobstopper-tuned', 'new');
  const m = { codeVersion: 'c', cells: [{ system: 'gobstopper-tuned', scenario: 'qa46', window: '100k', tier: 'T1', runKey: 'new' }, { system: 'kitzur', scenario: 'qa46', window: '100k', tier: 'T1', runKey: 'want' }] };
  const out = applyManifest([stale, cur], m);
  assert.deepEqual(out.map((x) => `${x.runKey}:${x.status}`).sort(), ['new:ok', 'want:not-run']);
  const rep = buildReport({ results: [stale, cur], crosscheck: null, manifest: m });
  assert.notEqual(rep.gates.gates['G3']!.status, 'PASS');
  assert.match(rep.markdown, /not run yet at this code version/);
});

test('G7 from latency.json and G9 from fuzz.json; absent files are NOT RUN', () => {
  assert.equal(gateG7(null).status, 'NOT RUN');
  assert.equal(gateG7({ gate7: { p99Ms: 42, n: 500 } }).status, 'PASS');
  assert.equal(gateG7({ classes: { a: { n: 600, p99: 130 } } }).status, 'FAIL');
  assert.equal(gateG7({ classes: { a: { n: 46, p99: 10 } } }).status, 'FAIL', 'n < 500');
  // bench/latency.ts's shape
  assert.equal(gateG7({ gate7: { p99: 12.5, pass: true }, classes: { a_steady: { overhead: { n: 500, p99: 12.5 } } } }).status, 'PASS');
  assert.equal(gateG9(null).status, 'NOT RUN');
  const cov = { compact: 0.3, admission: 0.06, oversize: 0.06, slim: 0.03, impossible: 0.02, guardAny: 0.01, clamp: 0.02 };
  assert.equal(gateG9({ chains: 10_000, violations: 0, coverage: cov }).status, 'PASS');
  assert.equal(gateG9({ chains: 10_000, violations: [{ seed: 1 }], coverage: cov }).status, 'FAIL');
  assert.equal(gateG9({ chains: 9_999, violations: 0, coverage: cov }).status, 'FAIL');
  assert.equal(gateG9({ chains: 10_000, violations: 0, coverage: { ...cov, slim: 0.01 } }).status, 'FAIL');
  assert.equal(gateG9({ chains: 10_000, violations: 0, coverageMet: true }).status, 'PASS');
  // bench/fuzz/run.ts's shape
  assert.equal(gateG9({ chains: 10_000, violations: { total: 0 }, coverage: { compact: { share: 0.4, min: 0.25, ok: true } }, coverageOk: true }).status, 'PASS');
  assert.equal(gateG9({ chains: 10_000, violations: { total: 2 }, coverageOk: true }).status, 'FAIL');
});

test('sweep selection (benchmark contract ): min uncached among processed ≤ gob, hit ≥ gob, b2b = 0, facts pass', () => {
  const gob = r('gobstopper-tuned', 'g', {}, { processed: 1_800_000, hit: 0.80 });
  const cfg = (t: number) => ({ config: { set: { 'compaction.triggerFraction': t, 'compaction.targetFraction': 0.35, 'compaction.summaryFraction': 0.04 } } });
  const a = r('kitzur-sweep-a', 'a', cfg(0.9), { uncached: 300_000, processed: 1_900_000 });
  const b = r('kitzur-sweep-b', 'b', cfg(0.95), { uncached: 320_000 });
  const c = r('kitzur-sweep-c', 'c', cfg(1.0), { uncached: 310_000, b2b: 1 });
  const d = r('kitzur-sweep-d', 'd', cfg(0.97), { uncached: 325_000 });
  const sw = sweepRows([gob, a, b, c, d], 'qa46', '100k');
  assert.equal(sw.rows.length, 4);
  assert.equal(sw.selected!.r.runKey, 'b');
  assert.deepEqual(sw.rows.find((x) => x.r.runKey === 'a')!.why, ['processed > gob']);
  assert.deepEqual(sw.rows.find((x) => x.r.runKey === 'c')!.why, ['b2b']);
});
