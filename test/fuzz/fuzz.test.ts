// The fuzz suite in the unit-test run (bench/fuzz, benchmark contract ): a few seeded live chains through every invariant
// with the production engine, generator determinism, the I6 boundary rule, and a shrink round trip.
// KITZUR_FUZZ_CHAINS scales it (default 12); the full suite is `node dist/bench/fuzz/run.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import { genChain } from '../../bench/fuzz/gen.js';
import { checkChain, DEFAULT_CHECKS } from '../../bench/fuzz/invariants.js';
import { fromRepro, shrink, type Repro } from '../../bench/fuzz/shrink.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { fuzzTokenizer } from '../../bench/fuzz/run.js';

const N = Number(process.env['KITZUR_FUZZ_CHAINS'] ?? 12);
const BASE = Number(process.env['KITZUR_FUZZ_SEED'] ?? 424_242);
const QUICK = { ...DEFAULT_CHECKS, freshEvery: 2, boundaryReplay: 3 };

test('generator: a chain is a pure function of its seed', () => {
  for (const s of [1, 77, 4242]) {
    const a = genChain(s, { exact: true });
    const b = genChain(s, { exact: true });
    assert.equal(canonicalJSON(a), canonicalJSON(b));
    assert.ok(a.requests.length >= 1);
    // requests grow as a live chain: every request ends where the client would send
    for (const r of a.requests) assert.ok(Array.isArray(r.messages) && r.messages.length > 0);
  }
});

test(`fuzz chains: no invariant violation (${N} chains from seed ${BASE})`, () => {
  const tok = fuzzTokenizer();
  const bad: string[] = [];
  for (let i = 0; i < N; i++) {
    const c = genChain(BASE + i, { exact: tok !== null });
    const o = checkChain(c, tok, QUICK);
    for (const v of o.violations) bad.push(`seed ${v.seed} ${v.inv}@${v.request}: ${v.detail}`);
  }
  assert.deepEqual(bad, []);
});

test('HTTP-shaped chains (intact pairing, no template errors) pass the in-process invariants too', () => {
  const tok = fuzzTokenizer();
  for (let i = 0; i < 4; i++) {
    const c = genChain(BASE + 1000 + i, { exact: tok !== null, http: true, template: i % 2 ? 'qwen3' : 'sim' });
    const o = checkChain(c, tok, QUICK);
    assert.deepEqual(o.violations, [], `seed ${c.seed}`);
  }
});

test('shrink: a passing chain shrinks to nothing and round-trips through its repro', () => {
  const tok = fuzzTokenizer();
  const c = genChain(BASE + 2000, { exact: false });
  const r = shrink(c, 'I5-fresh', tok, QUICK);
  assert.equal(r.violation, null);
  const back = fromRepro(r);
  assert.equal(back.requests.length, c.requests.length);
  assert.deepEqual(checkChain(back, tok, QUICK).violations, []);
});

test('regression (fuzz seed 4873, ): R2 at the floor does not make R6 evict every floor item', { skip: fuzzTokenizer() ? false : 'no dev tokenizer' }, () => {
  // 32k/8k, clamp on (hard = budget = 23,500): R2 asked for a 0-token summary, got the 195-token floor and recorded
  // 0 as the level; R3/R5 then left an overshoot of a few tokens and R6, starting from that 0, evicted all four floor
  // items (summary 51 tokens, count 23,392, room 108). Fixed: R2 records the size it got.
  const tok = fuzzTokenizer();
  const c = genChain(4873, { exact: true });
  const one = { ...c, requests: c.requests.slice(0, 1), learned: c.learned.slice(0, 1), mutated: [false] };
  const o = checkChain(one, tok, { ...DEFAULT_CHECKS, freshEvery: 1, boundaryReplay: 1, caps: false, restart: false, faults: 0, ledgerFit: true });
  assert.deepEqual(o.violations, []);
  assert.ok(o.checks.ledgerFit >= 1, 'the ledger-fit check ran');
});

test('regression (fuzz seeds 7205, 7248, 7897, guard larger_bytes): rewrites and compactions never add bytes', () => {
  // Shrunk repros (test/fuzz/repros, from bench/fuzz/shrink.ts). 7205 (4k, exact): an admission head+tail cut dropped
  // 261 characters and added a 280-character marker (fewer tokens, more bytes); 7248 / 7897 (2k): the summary of two
  // short messages was longer in bytes than they were. The guard rejected those outputs (attempt 1 fell back to the
  // original, or got a 400 when the original did not fit). Fixed: a rewrite must not grow in bytes
  // (Counting.smaller) and the compaction step's no-gain check compares bytes too.
  for (const seed of [7205, 7248, 7897]) {
    const r = JSON.parse(readFileSync(join(ROOT, 'test', 'fuzz', 'repros', `repro-${seed}.json`), 'utf8')) as Repro;
    if (r.mode === 'exact' && !fuzzTokenizer()) continue;
    const o = checkChain(fromRepro(r), fuzzTokenizer(), { ...DEFAULT_CHECKS, freshEvery: 1, boundaryReplay: 2, faults: 0 });
    assert.deepEqual(o.violations, [], `seed ${seed}`);
  }
  // 8648 (16k, exact): the same on a retry with extra tighten and noClamp
  if (fuzzTokenizer()) {
    const c = genChain(8648, { exact: true });
    const o = checkChain({ ...c, requests: c.requests.slice(0, 2), learned: c.learned.slice(0, 2), mutated: c.mutated.slice(0, 2) }, fuzzTokenizer(), { ...DEFAULT_CHECKS, freshEvery: 1, boundaryReplay: 1, caps: false, restart: false, ledgerFit: false });
    assert.deepEqual(o.violations, []);
  }
});
