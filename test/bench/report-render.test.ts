import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, cell, computeGates, deterministicPart, divergence, fmtCell, ReportError, selectLatest, Table } from '../../bench/report.js';
import type { ResultsFile, RunMetrics } from '../../bench/metrics/results.js';

const METRICS: RunMetrics = {
  steps: 46, steps_ok: 46, client_errors: 0, client_error_kinds: {}, failed_at: null, upstream_requests: 46, rejections: 0, rejected: 0,
  processed: 1_734_159, processed_main_accepted: 1_734_159, processed_main_rejected: 0, processed_aux: 0, aux_requests: 0, completion: 3063,
  peak: 60_984, budget: 67_000, hard: 61_000, pairing_errors: 0, pairing_errors_lenient: 0, client_prompt_total: 7_275_192,
  compactions_generic: 7, compaction_steps: [10, 17, 22, 27, 32, 37, 43], compactions_reported: 7, b2b: 0, client_rewrites: 0,
  client_compactions: 0, summarizer_requests: 0, title_requests: 0, hit: 1_388_802 / 1_734_159, lcp: 1_388_802, uncached: 345_357,
  fresh: 315_423, fresh_synth: 4_338, fresh_literal: 319_761, L: 29_934, reusable: 1_388_802 / (1_734_159 - 315_423), hit_global: 0.8009,
  hit_block16: 0.8006, template_breaks: 0, recoveries: 0, retry_monotone: true, retry_monotone_violations: [], original_resent: 0,
  max_attempts: 1, headroom: -7016, headroom_usable: 68_000,
};

let n = 0;
function res(system: string, scenario: string, window: string, over: Partial<ResultsFile> = {}, m: Partial<RunMetrics> = {}): ResultsFile {
  n++;
  return {
    schema: 1, runKey: `${String(n).padStart(4, '0')}${system}${scenario}${window}`.replace(/[^a-z0-9]/g, '').padEnd(64, '0').slice(0, 64),
    status: 'ok', reason: null,
    versions: { commit: 'c', node: 'v', gobSha: null, gobVersion: null, tokenizerSha: null, codeVersion: 'x'.repeat(64) },
    system, systemLabel: system, scenario, family: scenario.startsWith('talk') ? 'F2' : scenario.startsWith('huge') ? 'F4' : scenario.startsWith('err-') ? 'F11' : 'F1',
    window, tier: 'T1', configHash: 'h', config: {}, driver: 'spec', metrics: { ...METRICS, ...m }, facts: [], supersession: null,
    gates: { G1: { pass: true, detail: '' } }, notes: [], perRequest: [],
    timing: { wallMs: 1234, stepMs: { n: 1, p50: 1, p90: 1, p99: 1, max: 1, mean: 1 }, systemMs: null, startedAt: '2026-09-28T00:00:00.000Z' },
    ...over,
  };
}

const XC_ALL = { results: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ id, match: { derived_equal: true, sequences: [{ equal: true }], summary_diffs: [] } })) };

test('a MEASURED cell without src is refused; READ cells may cite; formatting', () => {
  assert.throws(() => cell(5, 'MEASURED', null), ReportError);
  assert.doesNotThrow(() => cell(null, 'MEASURED', null), 'an absent value has nothing to cite');
  assert.equal(fmtCell(cell(1_734_159, 'READ', 'bench/README.md')), '1,734,159');
  assert.equal(fmtCell(cell(0.8008520758, 'MEASURED', 'results/x.json#/metrics/hit', 'pct')), '80.09%');
  const t = new Table(['a', 'b']);
  assert.throws(() => t.add(['1']), ReportError);
});

test('T0: PASS with every case matching and the (a) assertions; NOT RUN when cases are missing; FAIL on a broken assertion', () => {
  const a = res('gobstopper-tuned', 'qa46-ref', '100k');
  let g = computeGates([a], XC_ALL).find((x) => x.gate === 'T0')!;
  assert.equal(g.status, 'PASS', JSON.stringify(g));
  assert.deepEqual(g.runKeys, [a.runKey]);
  const partial = { results: XC_ALL.results.slice(0, 5) };
  g = computeGates([a], partial).find((x) => x.gate === 'T0')!;
  assert.equal(g.status, 'NOT RUN');
  assert.match(g.reason!, /f, g, h/);
  const bad = res('gobstopper-tuned', 'qa46-ref', '100k', {}, { uncached: 345_347 });
  g = computeGates([bad], XC_ALL).find((x) => x.gate === 'T0')!;
  assert.equal(g.status, 'FAIL');
  const mismatch = { results: [...XC_ALL.results.slice(0, 7), { id: 'h', match: { derived_equal: false } }] };
  assert.equal(computeGates([a], mismatch).find((x) => x.gate === 'T0')!.status, 'FAIL');
  assert.equal(computeGates([], XC_ALL).find((x) => x.gate === 'T0')!.status, 'NOT RUN');
});

test('kitzur gates are NOT RUN without kitzur results — never PASS', () => {
  const gates = computeGates([res('gobstopper-tuned', 'qa46-ref', '100k')], XC_ALL);
  for (const g of gates.filter((x) => x.gate !== 'T0')) assert.equal(g.status, 'NOT RUN', g.gate);
});

test('G3 / G4 against gobstopper tuned: PASS, FAIL(gap, cause), and the  case (ratio misses, uncached and reusable better)', () => {
  const gob = [res('gobstopper-tuned', 'qa46-ref', '100k'), res('gobstopper-tuned', 'qa46', '100k')];
  const better = [res('kitzur', 'qa46-ref', '100k', {}, { processed: 1_700_000, hit: 0.81 }), res('kitzur', 'qa46', '100k', {}, { processed: 1_700_000, hit: 0.81 })];
  let gs = computeGates([...gob, ...better], XC_ALL);
  assert.equal(gs.find((g) => g.gate === 'G3')!.status, 'PASS');
  assert.equal(gs.find((g) => g.gate === 'G4')!.status, 'PASS');
  assert.equal(gs.find((g) => g.gate === 'G3')!.runKeys.length, 4);
  const worse = [res('kitzur', 'qa46-ref', '100k', {}, { processed: 1_900_000, hit: 0.79, uncached: 300_000, reusable: 0.99 }), res('kitzur', 'qa46', '100k', {}, { processed: 1_700_000 })];
  gs = computeGates([...gob, ...worse], XC_ALL);
  const g3 = gs.find((g) => g.gate === 'G3')!;
  assert.equal(g3.status, 'FAIL');
  assert.match(g3.gap!, /qa46-ref: processed 1,900,000 vs gobstopper-tuned 1,734,159 \(\+?9\.6%\)/);
  const g4 = gs.find((g) => g.gate === 'G4')!;
  assert.equal(g4.status, 'FAIL');
  assert.match(g4.gap!, /uncached and reusable beat the comparator/);
  // one side missing: NOT RUN, not PASS
  gs = computeGates([...gob, better[0]!], XC_ALL);
  assert.equal(gs.find((g) => g.gate === 'G3')!.status, 'NOT RUN');
});

test('G1 / G2 / G5 / I5 from kitzur cells', () => {
  const g1ok = res('kitzur', 'qa46', '100k');
  const g1bad = res('kitzur', 'talk80', '100k', { gates: { G1: { pass: false, detail: 'steps 40/80' } } });
  let gs = computeGates([g1ok, g1bad], XC_ALL);
  assert.equal(gs.find((g) => g.gate === 'G1')!.status, 'FAIL');
  const withFacts = res('kitzur', 'qa46', '100k', {
    facts: [{ id: 'o1-vp-old', marker: 'M', channel: 'user', expect: 'absent-after-supersede', gate: true, session: 's', planted: 5, status: 'fail', checked: 1, present: 1, missing: [], revivedAt: 17, resurfacedAt: null, exercised: true }],
  });
  gs = computeGates([withFacts], XC_ALL);
  const g2 = gs.find((g) => g.gate === 'G2')!;
  assert.equal(g2.status, 'FAIL');
  assert.match(g2.cause!, /o1-vp-old fail/);
  // F14 imp-tools: the documented 400 and no upstream request for that step
  const imp = (body: string, reqStep: number | null) => res('kitzur', 'imp-tools', '32k', {
    family: 'F14', clientErrors: [{ session: 's', step: 0, status: 400, kind: 'http_status', body }],
    perRequest: reqStep === null ? [] : [{ session: 's', step: reqStep, attempt: 1, kind: 'main', status: 400, prompt: 1, lcp: 0, fresh: 0, rewrite: 0, clientRewrite: 0, ownCount: null, bytes: 1, maxTokens: 1, clientErrorKind: null, msgsDigest: 'x' }],
  });
  const g1 = (r: ResultsFile) => computeGates([g1ok, r], XC_ALL).find((g) => g.gate === 'G1')!;
  assert.equal(g1(imp('{"error":{"code":"kitzur_fixed_prompt_too_large"}}', null)).status, 'PASS');
  assert.match(g1(imp('{"error":"other"}', null)).cause!, /no kitzur_fixed_prompt_too_large 400/);
  assert.match(g1(imp('{"error":{"code":"kitzur_fixed_prompt_too_large"}}', 0)).cause!, /the mock saw a request for step 0/);
  const huge = res('kitzur', 'huge180k', '100k', {}, { client_errors: 1, steps_ok: 20 });
  assert.equal(computeGates([huge], XC_ALL).find((g) => g.gate === 'G5')!.status, 'FAIL');
  // I5: divergence against the qa46 control
  const pr = (d: string) => ({ session: 's', step: 0, attempt: 1, kind: 'main', status: 200, prompt: 1, lcp: 0, fresh: 0, rewrite: 0 as const, clientRewrite: 0 as const, ownCount: null, bytes: 1, maxTokens: 1, clientErrorKind: null, msgsDigest: d });
  const ctl = res('kitzur', 'qa46', '100k', { perRequest: [pr('x'), { ...pr('y'), step: 1 }] });
  const same = res('kitzur', 'rs46-sigterm', '100k', { perRequest: [pr('x'), { ...pr('y'), step: 1 }] });
  const diff = res('kitzur', 'rs46-sigkill', '100k', { perRequest: [pr('x'), { ...pr('z'), step: 1 }] });
  assert.equal(divergence(same, ctl), 0);
  assert.equal(divergence(diff, ctl), 1);
  const i5 = computeGates([ctl, same, diff], XC_ALL).find((g) => g.gate === 'I5')!;
  assert.equal(i5.status, 'FAIL');
  assert.match(i5.gap!, /rs46-sigkill @100k: 1/);
});

test('the report is deterministic: input order and timing do not change the deterministic part', () => {
  const rs = [
    res('gobstopper-tuned', 'qa46-ref', '100k'), res('direct', 'qa46-ref', '100k', {}, { steps_ok: 10 }),
    res('opencode-sim-compat', 'qa46-ref', '100k', {}, { processed: 2_492_784, compactions_reported: 6, hit: null }),
    res('gobstopper-tuned', 'talk80', '32k', { status: 'not-run', reason: 'x', metrics: null }),
  ];
  const a = buildReport({ results: rs, crosscheck: XC_ALL });
  const b = buildReport({ results: [...rs].reverse(), crosscheck: XC_ALL });
  assert.equal(a.deterministic, b.deterministic);
  const slower = rs.map((r) => ({ ...r, timing: r.timing ? { ...r.timing, wallMs: 99_999 } : null }));
  const c = buildReport({ results: slower, crosscheck: XC_ALL });
  assert.equal(c.deterministic, a.deterministic);
  assert.notEqual(c.markdown, a.markdown);
  assert.equal(deterministicPart(a.markdown), a.deterministic);
  // every MEASURED cell cites a results file
  for (const x of a.cells) if (x.tag === 'MEASURED' && x.value !== null) assert.match(x.src!, /^results\/[0-9a-z]{64}\.json#\//);
  // content: the pre-registered rows match, NOT RUN rows are listed
  assert.match(a.markdown, /\| gobstopper tuned 100k \| 100k\/32k \| 1,734,118 \| 1,734,159 \| 7 \| 7 \| 80\.09% \| 80\.09% \| NO \|/);
  assert.match(a.markdown, /\| OpenCode mechanics 100k \| 100k\/32k \| 2,492,784 \| 2,492,784 \| 6 \| 6 \| – \| – \| yes \|/);
  assert.match(a.markdown, /NOT RUN `gobstopper-tuned\/talk80\/32k`: x/);
  assert.equal(a.gates.gates['T0']!.status, 'PASS');
  assert.equal(a.gates.gates['G7']!.status, 'NOT RUN');
});

test('selectLatest keeps one results file per cell: ok over not-run over error, then the newest', () => {
  const old = res('direct', 'qa46', '100k', { timing: { wallMs: 1, stepMs: { n: 0, p50: null, p90: null, p99: null, max: null, mean: null }, systemMs: null, startedAt: '2026-01-01T00:00:00.000Z' } });
  const nu = res('direct', 'qa46', '100k');
  const err = res('direct', 'qa46', '100k', { status: 'error', reason: 'boom', timing: { ...nu.timing!, startedAt: '2027-01-01T00:00:00.000Z' } });
  assert.deepEqual(selectLatest([old, err, nu]).map((r) => r.runKey), [nu.runKey]);
});
