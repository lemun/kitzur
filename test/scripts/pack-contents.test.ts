import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { ROOT } from '../helpers.js';

// a throwaway npm cache keeps the run independent of the user's cache
const env = { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), 'kitzur-npm-cache-')) };
after(() => rmSync(env.npm_config_cache, { recursive: true, force: true }));

const packed = (): Set<string> => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', env, shell: process.platform === 'win32' });
  assert.equal(res.status, 0, res.stderr);
  return new Set((JSON.parse(res.stdout) as { files: { path: string }[] }[])[0]?.files.map((f) => f.path));
};

// known gap: CHANGELOG.md is not packed, and README.md/docs/README.md link to docs/CLIENTS.md,
// docs/SETUPS.md, docs/INTRANET.md and docs/JSON-OUTPUT.md, which are not in package.json 'files'
test('the packed tarball has what a user needs, no dev files, and every relative import resolves', () => {
  const files = packed();
  const required = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CONFIG.md', 'SECURITY.md', 'package.json',
    'dist/src/cli.js', 'dist/src/index.js', 'deploy/windows/manage.mjs',
    ...readdirSync(join(ROOT, 'LICENSES')).map((f) => `LICENSES/${f}`)];
  for (const f of required) assert.ok(files.has(f), `${f} is not packed`);
  assert.ok([...files].some((f) => f.startsWith('presets/')), 'no presets/* file is packed');

  const forbidden = ['test/', 'bench/', 'site/', '.github/', 'dist/test/', 'dist/bench/', 'docs/assets/'];
  for (const f of files) {
    assert.ok(!forbidden.some((p) => f.startsWith(p)), `dev file is packed: ${f}`);
    const base = posix.basename(f);
    assert.ok(!/\.(tgz|pem)$/.test(base) && !base.startsWith('.env'), `secret or archive is packed: ${f}`);
  }

  const unresolved: string[] = [];
  let imports = 0;
  for (const f of files) {
    if (!f.startsWith('dist/src/') || !f.endsWith('.js')) continue;
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const [, spec = ''] of src.matchAll(/(?:from\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      imports++;
      const target = posix.normalize(posix.join(posix.dirname(f), spec));
      if (!files.has(target)) unresolved.push(`${f} -> ${spec}`);
    }
  }
  assert.ok(imports > 0, 'no relative imports found in dist/src');
  assert.deepEqual(unresolved, []);
});
