import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { ROOT } from '../helpers.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const verify = (...args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, 'deploy', 'verify-bundle.mjs'), ...args], { encoding: 'utf8' });

function put(dir: string, rel: string, data: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

function writeManifest(dir: string) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/')).filter((f) => f !== 'SHA256SUMS').sort();
  writeFileSync(join(dir, 'SHA256SUMS'), files.map((f) => `${sha(readFileSync(join(dir, f)))}  ./${f}\n`).join(''));
}

function fakeBundle(extra: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-verify-bundle-'));
  put(dir, 'package.json', JSON.stringify({ name: 'kitzur', engines: { node: '>=22' }, devDependencies: { typescript: '*' } }));
  put(dir, 'dist/src/cli.js', "#!/usr/bin/env node\nimport { run } from './cli/run.js';\nprocess.exit(run(process.argv.slice(2)));\n");
  put(dir, 'dist/src/cli/run.js', "import '../util.js';\nexport const run = (a) => (a[0] === 'version' || a[0] === 'config' ? 0 : 3);\n");
  put(dir, 'dist/src/util.js', 'export {};\n');
  put(dir, 'deploy/README.md', '# Deployment\n');
  extra(dir);
  writeManifest(dir);
  return dir;
}

test('verify-bundle.mjs passes a complete bundle and its archive checksum', () => {
  const dir = fakeBundle();
  const out = mkdtempSync(join(tmpdir(), 'kitzur-verify-archive-'));
  writeFileSync(join(out, 'kitzur-1.0.0-offline.tar.gz'), 'archive');
  writeFileSync(join(out, 'SHA256SUMS'), `${sha('other')}  kitzur-1.0.0.tgz\n${sha('archive')} *kitzur-1.0.0-offline.tar.gz\n`);
  const res = verify(dir, '--archive', join(out, 'kitzur-1.0.0-offline.tar.gz'), '--sums', join(out, 'SHA256SUMS'));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.match(/^PASS /gm)?.length, 6, res.stdout);
  assert.doesNotMatch(res.stdout, /^FAIL /m);
});

test('verify-bundle.mjs fails a wrong archive checksum', () => {
  const dir = fakeBundle();
  const out = mkdtempSync(join(tmpdir(), 'kitzur-verify-archive-'));
  writeFileSync(join(out, 'kitzur-1.0.0-offline.tar.gz'), 'tampered');
  writeFileSync(join(out, 'SHA256SUMS'), `${sha('archive')}  kitzur-1.0.0-offline.tar.gz\n`);
  const res = verify(dir, '--archive', join(out, 'kitzur-1.0.0-offline.tar.gz'), '--sums', join(out, 'SHA256SUMS'));
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL archive checksum: kitzur-1\.0\.0-offline\.tar\.gz does not match/m);
});

test('verify-bundle.mjs fails a tampered file and an unlisted file', () => {
  const dir = fakeBundle();
  writeFileSync(join(dir, 'dist/src/util.js'), 'export const evil = 1;\n');
  writeFileSync(join(dir, 'extra.txt'), 'x');
  const res = verify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL bundle manifest: changed dist\/src\/util\.js; not in the manifest: extra\.txt$/m);
});

test('verify-bundle.mjs does not run a tampered CLI', () => {
  const dir = fakeBundle();
  const marker = join(dir, 'ran.txt');
  writeFileSync(join(dir, 'dist/src/cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const res = verify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL bundled CLI runs: skipped, an earlier check failed$/m);
  assert.equal(existsSync(marker), false);
});

test('verify-bundle.mjs fails a missing import target', () => {
  const dir = fakeBundle((d) => put(d, 'dist/src/lazy.js', "export const f = () => import('./gone.js');\n"));
  const res = verify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL package and imports: dist\/src\/lazy\.js imports missing \.\/gone\.js$/m);
});

test('verify-bundle.mjs fails a forbidden member', () => {
  const dir = fakeBundle((d) => { put(d, 'test/a.test.js', ''); put(d, 'certs/server.pem', ''); });
  const res = verify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL no forbidden files: key material: certs\/server\.pem; test file: test\/a\.test\.js$/m);
  assert.match(res.stdout, /^PASS bundle manifest$/m);
});

test('verify-bundle.mjs exits 2 on a usage error', () => {
  assert.equal(verify().status, 2);
  assert.equal(verify(fakeBundle(), '--archive', 'a.tar.gz').status, 2);
  const res = verify(fakeBundle(), '--bogus');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^usage: node verify-bundle\.mjs/m);
});
