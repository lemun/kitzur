import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

test('run-tests.mjs ends with a passed/failed/skipped totals line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-run-tests-'));
  writeFileSync(join(dir, 'a.test.js'), "const { test } = require('node:test');\n"
    + "test('ok', () => {});\ntest('bad', () => { throw new Error('x'); });\ntest('later', { skip: true }, () => {});\n");
  const { NODE_TEST_CONTEXT: _, ...env } = process.env; // run as a top-level runner, not a child of this one
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'run-tests.mjs'), dir, '--test-reporter=dot'], { encoding: 'utf8', env });
  assert.equal(res.status, 1);
  assert.match(res.stdout.trimEnd().split('\n').at(-1) ?? '', /^tests: 1 passed, 1 failed, 1 skipped$/);
});

test('fetch-tokenizer.sh explains a failed download and never leaves a partial file', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-fetch-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(join(ROOT, 'scripts', 'fetch-tokenizer.sh'), join(dir, 'scripts', 'fetch-tokenizer.sh'));
  writeFileSync(join(dir, 'bin', 'curl'), '#!/bin/sh\necho partial > "$5"\nexit 22\n', { mode: 0o755 });
  const run = (env: Record<string, string>) => spawnSync('sh', [join(dir, 'scripts', 'fetch-tokenizer.sh')],
    { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env['PATH']}`, ...env } });
  const failed = run({ KITZUR_TOKENIZER_OPTIONAL: '' });
  assert.equal(failed.status, 22);
  assert.match(failed.stderr, /download failed; it is optional: tests skip the tokenizer cases.*KITZUR_TOKENIZER_OPTIONAL=1/);
  const optional = run({ KITZUR_TOKENIZER_OPTIONAL: '1' });
  assert.equal(optional.status, 0);
  assert.match(optional.stderr, /download failed/);
  assert.deepEqual(readdirSync(join(dir, 'bench', '.cache')), []);
});
