import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

// a throwaway npm cache keeps the run independent of the user's cache
const env = { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), 'kitzur-npm-cache-')) };
const checkPack = (dir: string) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-pack.mjs'), dir], { encoding: 'utf8', env });

test('check-pack.mjs passes on the built package', () => {
  const res = checkPack(ROOT);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^check-pack: ok, \d+ files/);
});

test('check-pack.mjs lists every violation in a broken package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-check-pack-'));
  mkdirSync(join(dir, 'lib'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'example-pkg', version: '1.0.0',
    bin: { example: 'lib/cli.js', 'example-plain': 'lib/index.js' },
    files: ['lib', 'test', 'missing.md'],
    engines: { node: '>=18' },
  }));
  writeFileSync(join(dir, 'lib', 'index.js'), 'export {};\n');
  writeFileSync(join(dir, 'test', 'a.test.js'), 'export {};\n');
  const res = checkPack(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check-pack: 5 violation\(s\) in example-pkg-1\.0\.0\.tgz:/);
  assert.match(res.stderr, /files entry "missing\.md" matches nothing in the pack/);
  assert.match(res.stderr, /bin "example" target lib\/cli\.js is not in the pack/);
  assert.match(res.stderr, /bin "example-plain" target lib\/index\.js does not start with "#!\/usr\/bin\/env node"/);
  assert.match(res.stderr, /test file would ship: test\/a\.test\.js/);
  assert.match(res.stderr, /engines\.node is ">=18", expected >=22/);
});
