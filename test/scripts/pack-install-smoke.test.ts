import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../helpers.js';

// everything (npm cache, tarball, the install, HOME) lives under one temp folder removed at the end
const tmp = mkdtempSync(join(tmpdir(), 'kitzur-pack-smoke-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const env = { ...process.env, npm_config_cache: join(tmp, 'npm-cache') };
const npm = (args: string[], cwd: string) => {
  const res = spawnSync('npm', args, { cwd, encoding: 'utf8', env, timeout: 120000 });
  assert.equal(res.status, 0, `npm ${args.join(' ')} failed:\n${res.stderr}`);
  return res.stdout;
};
const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

test('the packed tarball installs offline into a clean project and runs', async () => {
  const out = join(tmp, 'out');
  const project = join(tmp, 'project');
  const home = join(tmp, 'home');
  for (const d of [out, project, home]) mkdirSync(d);
  npm(['pack', '--ignore-scripts', '--pack-destination', out], ROOT);
  const [tarball] = readdirSync(out).filter((f) => f.endsWith('.tgz'));
  assert.ok(tarball, 'npm pack wrote no tarball');
  writeFileSync(join(project, 'package.json'), '{"name":"smoke","private":true}\n');
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(out, tarball)], project);

  const pkg = join(project, 'node_modules', 'kitzur');
  const cli = join(pkg, 'dist', 'src', 'cli.js');
  const opts: SpawnSyncOptions = { cwd: project, encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home } };
  const run = (...args: string[]) => {
    const res = spawnSync(process.execPath, [cli, ...args], opts);
    assert.equal(res.status, 0, `kitzur ${args.join(' ')} failed:\n${String(res.stderr)}`);
    return String(res.stdout);
  };
  assert.ok(run('version').startsWith(`kitzur ${version}`));
  assert.match(run('completions', 'bash'), /_kitzur/);
  const before = [readdirSync(project).sort(), readdirSync(home).sort()];
  assert.match(run('config', 'init', '--dry-run'), /kitzur configuration/);
  assert.deepEqual([readdirSync(project).sort(), readdirSync(home).sort()], before, 'config init --dry-run created a file');
  run('help');

  if (process.platform !== 'win32') {
    const bin = join(project, 'node_modules', '.bin', 'kitzur');
    assert.ok(existsSync(bin), 'node_modules/.bin/kitzur is missing');
    assert.equal(realpathSync(bin), realpathSync(cli));
  }
  const api = (await import(pathToFileURL(join(pkg, 'dist', 'src', 'index.js')).href)) as Record<string, unknown>;
  assert.ok(Object.keys(api).length > 0, 'the installed package exports nothing');
  assert.equal(typeof api['loadConfig'], 'function');
});

// the non-build part of the pack, pinned on purpose: a mismatch names the path; update this list
// only when adding or removing a packed file is intended (presets/ and LICENSES/ follow their folders)
const PINNED = [
  'CONFIG.md', 'DESIGN.md', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'deploy/README.md', 'deploy/kitzur.service', 'deploy/windows/ADMIN.md', 'deploy/windows/Install-Kitzur.ps1',
  'deploy/windows/Kitzur.ps1', 'deploy/windows/Register-Startup.ps1', 'deploy/windows/USER.md',
  'deploy/windows/manage.mjs', 'deploy/windows/opencode.template.json', 'deploy/windows/profile.example.json',
  'docs/DIAGNOSTICS.md', 'docs/README.md', 'docs/SECURITY-REVIEW.md', 'docs/TROUBLESHOOTING.md', 'package.json',
];

const diff = (actual: Set<string>, expected: Set<string>) => ({
  unexpected: [...actual].filter((p) => !expected.has(p)).sort(),
  missing: [...expected].filter((p) => !actual.has(p)).sort(),
});

test('the pack list matches the pinned files and the compiled sources exactly', () => {
  const [info] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], ROOT)) as { files: { path: string }[] }[];
  const files = info!.files.map((f) => f.path);
  const expected = new Set([
    ...PINNED,
    ...readdirSync(join(ROOT, 'presets')).map((f) => `presets/${f}`),
    ...readdirSync(join(ROOT, 'LICENSES')).map((f) => `LICENSES/${f}`),
  ]);
  assert.deepEqual(diff(new Set(files.filter((p) => !p.startsWith('dist/'))), expected), { unexpected: [], missing: [] },
    'the pack outside dist/ changed; update PINNED on purpose if intended');

  const sources = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => `dist/src/${f.split('\\').join('/').replace(/\.ts$/, '.js')}`);
  assert.ok(sources.length > 0);
  const built = new Set([...sources, ...sources.map((s) => `${s}.map`)]);
  assert.deepEqual(diff(new Set(files.filter((p) => p.startsWith('dist/'))), built), { unexpected: [], missing: [] },
    'dist/ in the pack must be exactly one .js and .js.map per src/**/*.ts');
});
