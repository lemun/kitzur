import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeStdout, report } from '../../bench/analyze.js';
import { ROOT } from '../helpers.js';
import { writeSyntheticRun } from './analyze-fixture.js';

test('analyze.ts prints exactly what the Python analyze.py printed for the synthetic run', () => {
  const base = mkdtempSync(join(tmpdir(), 'kitzur-analyze-'));
  const dir = join(base, 'synthetic_run');
  try {
    writeSyntheticRun(dir);
    const want = gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'bench', 'analyze_synthetic.txt.gz'))).toString('utf8');
    assert.equal(analyzeStdout(dir), want);
    // the edge cases the fixture was built for really occur
    const { summary, analysis } = report(dir);
    assert.equal(summary.compactions, 2);
    assert.equal(summary.b2b, 1);
    assert.equal(summary.client_errors, 1);
    assert.ok(want.includes('first 1.00, last 1.12')); // 1125 permille: ties-to-even
    const row3 = analysis.rows.find((r) => r.step === 3)!;
    const row4 = analysis.rows.find((r) => r.step === 4)!;
    assert.equal(row3.drop!.short_results_in_summary, 1); // "ok\u0085" only matches after Python strip() (JS trim keeps U+0085)
    assert.equal(row4.drop!.short_results_in_summary, 2); // + 499 emoji: <= 500 code points (998 UTF-16 units)
    assert.ok(row4.drop!.dropped.has('?'));
    // RUN_DIR with a trailing "/": Python os.path.basename gives "" (MEASURED with analyze.py), not the dir name
    const [first, ...rest] = want.split('\n');
    assert.ok(first!.startsWith('### Run `synthetic_run` — '));
    assert.equal(analyzeStdout(dir + '/'), [first!.replace('`synthetic_run`', '``'), ...rest].join('\n'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
