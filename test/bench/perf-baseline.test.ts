// bench/perf-baseline.ts without real timing: the comparison with injected numbers, the CLI modes on a temporary
// baseline, the committed baseline file's schema and size, and one tiny case end to end with an injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINE_PATH, CASES, REFRESH, caseKey, compare, main, measure, runCase, stableJSON, validateBaseline,
  type Baseline, type CaseRecord,
} from '../../bench/perf-baseline.js';

const retention = { dropped: 4, excerpted: 0, summarized: 2, verbatim: 6 };
const rec = (relCost: number, tokensOut = 900): CaseRecord => ({ results: { requests: 40, tokensIn: 5000, tokensOut, compactions: 3, retention }, relCost });
const base: Baseline = { schema: 1, date: '2026-01-01', cases: { a: rec(10), b: rec(20) } };

test('compare: pass, deterministic mismatch, slow case, missing case', () => {
  assert.deepEqual(compare(base, { a: rec(14.9), b: rec(5) }), []);
  const [changed, ...more] = compare(base, { a: rec(10, 901), b: rec(20) });
  assert.deepEqual(more, []);
  assert.match(changed!, /^a: planner output changed: .*"tokensOut":900.*"tokensOut":901.*refresh with: npm run build/);
  const slow = compare(base, { a: rec(10), b: rec(30.1) });
  assert.deepEqual(slow, [`b: relative cost 30.1 exceeds the baseline 20 by more than 50% (1.505x); if intended, refresh with: ${REFRESH}`]);
  assert.deepEqual(compare(base, { a: rec(10), b: rec(30) }), [], 'exactly +50% passes');
  const missing = compare(base, { a: rec(10), c: rec(1) });
  assert.match(missing.join('\n'), /^c: missing from the baseline.*\nb: in the baseline but not measured/);
});

test('validateBaseline: schema errors', () => {
  assert.deepEqual(validateBaseline(base), []);
  assert.deepEqual(validateBaseline([]), ['baseline: not a JSON object']);
  assert.match(validateBaseline({ ...base, schema: 2 })[0]!, /schema must be 1/);
  assert.match(validateBaseline({ ...base, date: '2026-01-01T00:00:00Z' })[0]!, /date/);
  assert.match(validateBaseline({ ...base, cases: null })[0]!, /cases must be an object/);
  assert.match(validateBaseline({ ...base, cases: { a: { ...rec(1), relCost: 0 } } })[0]!, /a\.relCost/);
  assert.match(validateBaseline({ ...base, cases: { a: { relCost: 1, results: { requests: 1.5 } } } })[0]!, /a\.results is malformed/);
});

test('main: --update refused under CI=true, --check and --update on a temporary baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-perf-'));
  const p = join(dir, 'engine-perf.json');
  const run = (argv: string[], cases: Record<string, CaseRecord> | null = base.cases, env: Record<string, string> = {}): [number, string] => {
    const lines: string[] = [];
    const measure = (): Record<string, CaseRecord> => cases ?? assert.fail('measured');
    const code = main(argv, { env, log: (s) => void lines.push(s), measure, baselinePath: p, today: () => '2026-02-03' });
    return [code, lines.join('\n')];
  };
  try {
    assert.deepEqual(run(['--update'], null, { CI: 'true' }), [2, `perf-baseline: --update refused under CI=true; refresh the baseline locally with: ${REFRESH}`]);
    assert.match(run(['--check']).join(' '), /^1 [^]*cannot read the baseline/);
    assert.equal(run(['--update'])[0], 0);
    // the file has sorted keys, the measured records do not: still equal
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { ...base, date: '2026-02-03' });
    assert.equal(run(['--check'], { a: rec(12), b: rec(20) })[0], 0);
    assert.match(run(['--check'], { a: rec(10), b: rec(31) }).join(' '), /^1 [^]*FAIL b: relative cost 31 exceeds the baseline 20/);
    writeFileSync(p, JSON.stringify({ schema: 1, cases: {} }));
    assert.match(run(['--check']).join(' '), /^1 [^]*FAIL baseline: date must be YYYY-MM-DD; regenerate it with/);
    assert.deepEqual(JSON.parse(run(['--json'])[1]), { cases: base.cases });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed baseline: valid, every case, sorted keys, small, no paths or machine names', () => {
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  const b = JSON.parse(raw) as Baseline;
  assert.deepEqual(validateBaseline(b), []);
  assert.deepEqual(Object.keys(b.cases).sort(), CASES.map(caseKey).sort());
  assert.equal(raw, stableJSON(b));
  assert.ok(Buffer.byteLength(raw) < 6 * 1024, `${Buffer.byteLength(raw)} bytes`);
  assert.doesNotMatch(raw, /[/\\]|host|user/i);
});

test('a tiny case end to end with an injected clock is deterministic', () => {
  let t = 0;
  const now = (): number => (t += 1);
  const tiny = { messages: 24, window: '32k' };
  const r = runCase(tiny, now);
  assert.equal(r.ms, r.results.requests, 'one clock tick per request');
  assert.ok(r.results.requests > 1 && r.results.tokensIn >= r.results.tokensOut);
  assert.deepEqual(runCase(tiny, now).results, r.results);
  const m = measure([tiny], { runs: 3, now, calibrate: () => 4 });
  assert.deepEqual(m, { '24msg@32k': { results: r.results, relCost: r.results.requests / 4 } });
});
