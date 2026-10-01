// The metrics against the reference runs (bench/README.md§17): gobstopper tuned on qa46-ref must give 7 generic
// compactions at steps 10/17/22/27/32/37/43, hit 0.8009, uncached 345,357, fresh 315,423 (L 29,934, reusable 97.89%).
// The runs are made here, into private temp dirs, with the TS harness (bench/harness.ts: the cross-checked
// Python-parity path) against the real gobstopper binary — the shared bench/results/raw/xc-* dirs are not read, since a
// concurrent cross-check may be rewriting them. Skipped without the gobstopper binary or the dev tokenizer. The fact and
// compaction semantics are cross-validated against bench/analyze.ts (the byte-exact analyze.py port) on each run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, readJsonlFile, summarize } from '../../bench/analyze.js';
import { runExperiment } from '../../bench/harness.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { gobstopperBin } from '../../bench/lib/paths.js';
import { Direct } from '../../bench/systems/direct.js';
import { Gobstopper, GOB_TUNED_ARGS } from '../../bench/systems/gobstopper.js';
import type { BenchSystem } from '../../bench/systems/types.js';
import { collectRunDir } from '../../bench/metrics/collect.js';
import { computeMetrics } from '../../bench/metrics/results.js';
import { buildScenario } from '../../bench/scenarios/index.js';
import { refFacts } from '../../bench/scenarios/browser.js';
import type { ScenarioOptions } from '../../bench/scenarios/reference.js';
import { WINDOWS } from '../../bench/scenarios/windows.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';

const tok = testTokenizerPath();
const counter = tok ? new PromptCounter(loadTokenizer(tok)) : null;
const gob = gobstopperBin();
const root = mkdtempSync(join(tmpdir(), 'kitzur-metrics-ref-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

async function run(name: string, system: BenchSystem, scenario: ScenarioOptions): Promise<string> {
  const dir = join(root, name);
  await runExperiment({ name, runDir: dir, system, scenario, counter: counter! });
  return dir;
}

function measure(dir: string) {
  const rr = collectRunDir(dir, { counter: counter!, facts: refFacts(true), steps: { default: 46 } });
  return computeMetrics({ scenario: buildScenario('qa46-ref'), window: WINDOWS['100k'], rr, ledger: readJsonlFile(join(dir, 'ledger.jsonl')) });
}

function agreesWithAnalyze(dir: string, m: ReturnType<typeof measure>, rewritesAreCompactions: boolean): void {
  const a = summarize(analyze(dir));
  assert.equal(m.metrics.processed, a.sent_total, dir);
  assert.equal(m.metrics.rejections, a.rejections, dir);
  assert.equal(m.metrics.peak, a.peak, dir);
  assert.equal(m.metrics.steps_ok, a.steps_ok, dir);
  assert.equal(m.metrics.client_errors, a.client_errors, dir);
  assert.equal(m.metrics.compactions_reported, a.compactions, dir);
  assert.equal(m.metrics.b2b, a.b2b, dir);
  if (rewritesAreCompactions) assert.equal(m.metrics.compactions_generic, a.compactions, `${dir}: every gobstopper compaction is a non-append rewrite`);
  // analyze.py counts a never-planted fact as lost; here it is "not-planted" (also not a pass)
  assert.deepEqual(Object.fromEntries(m.facts.map((f) => [f.id, f.status === 'pass'])), a.survival, dir);
}

const skipGob = !counter ? 'no dev tokenizer' : !gob ? 'no gobstopper binary (KITZUR_GOBSTOPPER_BIN / KITZUR_REF_DIR)' : false;

test('gobstopper tuned / qa46-ref: the pre-registered generic and prefix numbers (benchmark contract (a), §17)', { skip: skipGob }, async () => {
  const dir = await run('gob-tuned', new Gobstopper({ bin: gob!, args: GOB_TUNED_ARGS }), { capBytes: 51_200 });
  const m = measure(dir);
  const x = m.metrics;
  assert.equal(x.processed, 1_734_159);
  assert.equal(x.peak, 60_984);
  assert.equal(x.compactions_generic, 7);
  assert.deepEqual(x.compaction_steps, [10, 17, 22, 27, 32, 37, 43]);
  assert.equal(x.compactions_reported, 7);
  assert.equal(x.b2b, 0);
  assert.equal(x.hit!.toFixed(4), '0.8009');
  assert.equal(x.lcp, 1_388_802);
  assert.equal(x.uncached, 345_357);
  assert.equal(x.fresh, 315_423);
  assert.equal(x.L, 29_934);
  assert.equal(x.reusable!.toFixed(4), '0.9789');
  assert.equal(x.fresh_literal, 319_761, '§6.2 read literally (synthesized first sends counted as fresh)');
  assert.equal(x.client_compactions, 0);
  assert.equal(x.pairing_errors, 0);
  assert.equal(x.steps_ok, 46);
  // Σ of our LCPs equals the mock's own lcp_ok_tokens (an independent implementation of the same quantity)
  const mock = readJsonlFile(join(dir, 'mock.jsonl'));
  assert.equal(mock.filter((r) => r['status'] === 200).reduce((a, r) => a + (r['lcp_ok_tokens'] as number), 0), x.lcp);
  // facts: gobstopper loses the todo and both paths, exactly as analyze.py says
  assert.deepEqual(Object.fromEntries(m.facts.map((f) => [f.id, f.status === 'pass'])), {
    goal: true, decision: true, 'user-rule': true, 'unfinished(text)': true, 'unfinished(todo)': false, 'path(call arg)': false, 'path(tool output)': false,
  });
  agreesWithAnalyze(dir, m, true);
  assert.equal(m.gates['G1']!.pass, true);
  assert.equal(m.gates['G2']!.pass, false);
});

test('gobstopper defaults (with rejections) and direct: generic metrics agree with analyze.ts', { skip: skipGob }, async () => {
  const d = await run('gob-defaults', new Gobstopper({ bin: gob!, args: [] }), { capBytes: 51_200 });
  const m = measure(d);
  assert.equal(m.metrics.processed, 2689015, 'case (e) F_defaults');
  assert.equal(m.metrics.rejected, 548297);
  assert.equal(m.metrics.recoveries, 7, 'every rejection recovered within its step');
  agreesWithAnalyze(d, m, true);
  const c = await run('direct', new Direct(), {});
  const mc = measure(c);
  assert.equal(mc.metrics.processed, 440_287, 'case (c)');
  assert.deepEqual(mc.metrics.failed_at, { session: 'default', step: 10 });
  assert.equal(mc.metrics.L, 0, 'direct: every uncached token is a first send');
  agreesWithAnalyze(c, mc, false);
});
