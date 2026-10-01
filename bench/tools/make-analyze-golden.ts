// Dev tool: writes the synthetic run directory of test/bench/analyze-fixture.ts, runs the UNMODIFIED
// Python analyze.py on it and stores its stdout as test/fixtures/bench/analyze_synthetic.txt.gz.
//
//   KITZUR_REF_DIR=<ref> node dist/bench/tools/make-analyze-golden.js

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { refHarness, ROOT } from '../lib/paths.js';
import { writeSyntheticRun } from '../../test/bench/analyze-fixture.js';

const ref = refHarness();
if (!ref) {
  console.error('set KITZUR_REF_DIR to the Python reference harness');
  process.exit(2);
}
const base = mkdtempSync(join(tmpdir(), 'kitzur-analyze-'));
const dir = join(base, 'synthetic_run'); // the basename appears in the first output line
writeSyntheticRun(dir);
const r = spawnSync(ref.python, [join(ref.sim, 'analyze.py'), dir], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}
writeFileSync(join(ROOT, 'test', 'fixtures', 'bench', 'analyze_synthetic.txt.gz'), gzipSync(Buffer.from(r.stdout, 'utf8'), { level: 9 }));
console.log(r.stdout);
rmSync(base, { recursive: true, force: true });
