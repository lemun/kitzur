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
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  const [info] = JSON.parse(res.stdout) as { files: { path: string }[] }[];
  return new Set(info!.files.map((f) => f.path));
};
const files = packed();

// known gap: the pack has no CHANGELOG.md, and README.md / docs/README.md link to docs/CLIENTS.md,
// docs/SETUPS.md, docs/INTRANET.md and docs/JSON-OUTPUT.md, none of which are in package.json 'files'

test('the pack holds the files a user needs', () => {
  const required = [
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CONFIG.md', 'SECURITY.md', 'package.json',
    'dist/src/cli.js', 'dist/src/index.js', 'deploy/windows/manage.mjs',
    ...readdirSync(join(ROOT, 'LICENSES')).map((f) => `LICENSES/${f}`),
  ];
  assert.deepEqual(required.filter((p) => !files.has(p)), []);
  assert.ok([...files].some((p) => /^presets\/[^/]+\.json$/.test(p)), 'no presets/*.json in the pack');
});

test('the pack holds no dev, test or secret files', () => {
  const prefixes = ['test/', 'bench/', 'site/', '.github/', 'dist/test/', 'dist/bench/', 'docs/assets/'];
  const bad = [...files].filter((p) =>
    prefixes.some((pre) => p.startsWith(pre)) || /\.(tgz|pem)$/.test(p) || /^\.env/.test(posix.basename(p)));
  assert.deepEqual(bad, []);
});

test('every relative import in the packed dist/src resolves inside the pack', () => {
  const sources = [...files].filter((p) => p.startsWith('dist/src/') && p.endsWith('.js'));
  assert.ok(sources.length > 0);
  const spec = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let count = 0;
  const unresolved: string[] = [];
  for (const src of sources) {
    for (const m of readFileSync(join(ROOT, src), 'utf8').matchAll(spec)) {
      count++;
      const target = posix.normalize(posix.join(posix.dirname(src), m[1]!));
      if (!files.has(target)) unresolved.push(`${src} -> ${m[1]}`);
    }
  }
  assert.ok(count > 0, 'no relative imports found');
  assert.deepEqual(unresolved, []);
});
