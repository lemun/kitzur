import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factResults, factsGate, supersessionConfusion } from '../../bench/metrics/facts.js';
import type { ClientRec, RunRecords, UpstreamRec } from '../../bench/metrics/records.js';
import type { FactSpec } from '../../bench/scenarios/types.js';

// A message is a digest; `F` maps a digest to the fact ids its text contains.
type M = string;
let seq = 0;
function mk(F: Record<string, string[]>) {
  const facts = (ds: M[]): string[][] => ds.map((d) => F[d] ?? []);
  return {
    up: (step: number, ds: M[], status = 200): UpstreamRec => ({
      seq: ++seq, session: 's', step, kind: 'main', status, rejected: status !== 200, prompt: 10, completion: 0, maxTokens: 0, bytes: 0, lcp: 0,
      lcpGlobal: null, digests: ds, msgTokens: ds.map(() => 1), overhead: 0, facts: facts(ds), pairingError: null, pairingStrict: [],
    }),
    cl: (step: number, ds: M[]): ClientRec => ({
      session: 's', step, kind: 'main', attempt: 1, digests: ds, facts: facts(ds), prompt: null, bytes: null, status: 200, clientErrorKind: null,
      usage: null, maxTokens: null, pairingStrict: [],
    }),
  };
}
const F = (id: string, expect: FactSpec['expect'], supersededBy?: string, gate = true): FactSpec =>
  supersededBy ? { id, marker: id.toUpperCase(), channel: 'user', expect, gate, supersededBy } : { id, marker: id.toUpperCase(), channel: 'user', expect, gate };

/** Client history: step k's request C_k = h[0..k]; the proxy forwards A_k. */
function runOf(C: M[][], A: M[][], F_: Record<string, string[]>): RunRecords {
  seq = 0;
  const b = mk(F_);
  return { up: A.map((a, k) => b.up(k, a)), client: C.map((c, k) => b.cl(k, c)), steps: { s: C.length } };
}

test('survive: planted at the first client request carrying it; must be in every later forwarded request', () => {
  const f = { g: ['keep'] };
  const C = [['s', 'u'], ['s', 'u', 'g'], ['s', 'u', 'g', 'x'], ['s', 'u', 'g', 'x', 'y']];
  const A = [['s', 'u'], ['s', 'u', 'g'], ['s', 'SUM', 'x'], ['s', 'SUM', 'x', 'y']];
  let r = factResults([F('keep', 'survive')], runOf(C, A, f))[0]!;
  assert.equal(r.planted, 1);
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.missing, [2, 3]);
  // the summary carries it: pass
  r = factResults([F('keep', 'survive')], runOf(C, A, { ...f, SUM: ['keep'] }))[0]!;
  assert.equal(r.status, 'pass');
  assert.equal(r.checked, 3);
  // never planted: not-planted, and the gate fails
  const n = factResults([F('ghost', 'survive')], runOf(C, A, f));
  assert.equal(n[0]!.status, 'not-planted');
  assert.equal(factsGate(n).pass, false);
  // report-only: counted, never gated
  const ro = factResults([F('keep', 'report-only', undefined, false)], runOf(C, A, f));
  assert.equal(ro[0]!.status, 'report');
  assert.equal(ro[0]!.present, 1);
  assert.equal(factsGate(ro).pass, true);
});

test('latest: required only until the successor value is planted', () => {
  const f = { v1: ['url1'], v2: ['url2'] };
  const C = [['s'], ['s', 'v1'], ['s', 'v1', 'x'], ['s', 'v1', 'x', 'v2'], ['s', 'v1', 'x', 'v2', 'y']];
  const A = [['s'], ['s', 'v1'], ['s', 'v1', 'x'], ['s', 'SUM', 'v2'], ['s', 'SUM', 'v2', 'y']];
  const [a, b] = factResults([F('url1', 'latest', 'url2'), F('url2', 'latest')], runOf(C, A, f));
  assert.equal(a!.status, 'pass', 'url1 may disappear once url2 exists');
  assert.equal(a!.checked, 2);
  assert.equal(b!.status, 'pass');
  // url1 missing before url2 appears: fail
  const A2 = [['s'], ['s', 'v1'], ['s', 'x'], ['s', 'SUM', 'v2'], ['s', 'SUM', 'v2', 'y']];
  assert.equal(factResults([F('url1', 'latest', 'url2')], runOf(C, A2, f))[0]!.status, 'fail');
});

// instruction g (message G) planted at 1, correction j (message J) planted at 3
const FF = { G: ['old'], J: ['new'] };
const CC = [['s'], ['s', 'G'], ['s', 'G', 'x'], ['s', 'G', 'x', 'J'], ['s', 'G', 'x', 'J', 'y'], ['s', 'G', 'x', 'J', 'y', 'z']];
const facts = [F('old', 'absent-after-supersede', 'new'), F('new', 'survive')];

test('absent-after-supersede: verbatim client messages may keep the marker (I6)', () => {
  const A = [['s'], ['s', 'G'], ['s', 'G', 'x'], ['s', 'G', 'x', 'J'], ['s', 'G', 'x', 'J', 'y'], ['s', 'G', 'x', 'J', 'y', 'z']];
  const r = factResults(facts, runOf(CC, A, FF));
  assert.equal(r[0]!.status, 'pass');
  assert.equal(r[0]!.exercised, false, 'the instruction never left the verbatim tail');
  assert.equal(r[1]!.status, 'pass');
});

test('absent-after-supersede: a summary synthesized BEFORE the correction may keep it until the next compaction', () => {
  const A = [['s'], ['s', 'G'], ['s', 'S1'], ['s', 'S1', 'J'], ['s', 'S1', 'J', 'y'], ['s', 'S2', 'y', 'z']];
  const r = factResults(facts, runOf(CC, A, { ...FF, S1: ['old'] }));
  assert.equal(r[0]!.status, 'pass', JSON.stringify(r[0]));
  assert.equal(r[0]!.exercised, true);
  assert.equal(r[0]!.revivedAt, null);
});

test('absent-after-supersede: REVIVED = in synthesized content first forwarded at or after the correction', () => {
  // the step-5 summary S2 (new content) repeats the superseded instruction
  const A = [['s'], ['s', 'G'], ['s', 'S1'], ['s', 'S1', 'J'], ['s', 'S1', 'J', 'y'], ['s', 'S2', 'y', 'z']];
  const r = factResults(facts, runOf(CC, A, { ...FF, S1: ['old'], S2: ['old', 'new'] }))[0]!;
  assert.equal(r.status, 'fail');
  assert.equal(r.revivedAt, 5);
  // synthesized AT the correction step also revives
  const A3 = [['s'], ['s', 'G'], ['s', 'G', 'x'], ['s', 'S3', 'J'], ['s', 'S3', 'J', 'y'], ['s', 'S3', 'J', 'y', 'z']];
  const r3 = factResults(facts, runOf(CC, A3, { ...FF, S3: ['old'] }))[0]!;
  assert.equal(r3.revivedAt, 3);
});

test('absent-after-supersede: RESURFACED = absent, then present again (even verbatim)', () => {
  const A = [['s'], ['s', 'G'], ['s', 'x'], ['s', 'x', 'J'], ['s', 'G', 'x', 'J', 'y'], ['s', 'x', 'J', 'y', 'z']];
  const r = factResults(facts, runOf(CC, A, FF))[0]!;
  assert.equal(r.status, 'fail');
  assert.equal(r.resurfacedAt, 4);
  assert.equal(r.revivedAt, null, 'G is a client message: not synthesized');
});

test('absent-after-supersede without a planted successor is reported, not passed', () => {
  const C = CC.slice(0, 3);
  const A = [['s'], ['s', 'G'], ['s', 'G', 'x']];
  const r = factResults(facts, runOf(C, A, FF))[0]!;
  assert.equal(r.status, 'no-successor');
  assert.equal(factsGate([r]).pass, false);
});

test('F9 confusion matrix: true / missed / not exercised / false / kept', () => {
  const A_true = [['s'], ['s', 'G'], ['s', 'S1'], ['s', 'S1', 'J'], ['s', 'S1', 'J', 'y'], ['s', 'S2', 'y', 'z']];
  const res = factResults(facts, runOf(CC, A_true, { ...FF, S1: ['old'], S2: ['new'] }));
  let c = supersessionConfusion([{ label: 'a', fact: 'old', supersede: true }, { label: 'k', fact: 'new', supersede: false }], res);
  assert.deepEqual(c.rows.map((r) => r.outcome), ['true', 'kept']);
  const res2 = factResults(facts, runOf(CC, A_true, { ...FF, S1: ['old'], S2: ['old'] }));
  c = supersessionConfusion([{ label: 'a', fact: 'old', supersede: true }, { label: 'k', fact: 'new', supersede: false }], res2);
  assert.deepEqual(c.rows.map((r) => r.outcome), ['missed', 'false'], 'S2 revives the old one and loses the new one');
  assert.deepEqual(c.counts, { true: 0, missed: 1, false: 1, 'not-exercised': 0, kept: 0, 'not-planted': 0 });
  const verbatim = factResults(facts, runOf(CC, CC, FF));
  c = supersessionConfusion([{ label: 'a', fact: 'old', supersede: true }], verbatim);
  assert.deepEqual(c.rows.map((r) => r.outcome), ['not-exercised']);
});
