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

// the packer uses GNU tar (--sort) and sha256sum, as on the Linux build host
function hasGnuTools(): boolean {
  return process.platform !== 'win32' && /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '')
    && spawnSync('sha256sum', ['--version'], { encoding: 'utf8' }).status === 0;
}

test('pack-offline.sh ships the launchd plist and the systemd unit that deploy/README.md tells the installer to use', { skip: !hasGnuTools() }, () => {
  const out = mkdtempSync(join(tmpdir(), 'kitzur-pack-'));
  const res = spawnSync('bash', [join(ROOT, 'scripts', 'pack-offline.sh'), out], { encoding: 'utf8', cwd: ROOT });
  assert.equal(res.status, 0, res.stderr);
  const bundle = readdirSync(out).find((f) => f.endsWith('-offline.tar.gz'));
  assert.ok(bundle, 'the vendored tarball is built');
  const listing = spawnSync('tar', ['-tzf', join(out, bundle)], { encoding: 'utf8' }).stdout.split('\n');
  for (const f of ['deploy/README.md', 'deploy/kitzur.service', 'deploy/com.github.lemun.kitzur.plist'])
    assert.ok(listing.some((l) => l.endsWith(`/${f}`)), `${f} is in the bundle`);
});
