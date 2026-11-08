import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { passthroughEngine } from '../proxy/fake-engine.js';
import { request, startProxy } from '../proxy/harness.js';

const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const entry = join(ROOT, 'dist', 'src', 'cli.js');

function run(t: { after(fn: () => void): void }, ...argv: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'kitzur-version-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (k.startsWith('KITZUR_')) delete env[k];
  return spawnSync(process.execPath, [entry, ...argv], { encoding: 'utf8', env, cwd: home, timeout: 30_000 });
}

test('package-lock.json carries the package.json version at the top level and in packages[""]', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version: string }> };
  assert.equal(lock.version, version);
  assert.equal(lock.packages['']!.version, version);
});

test('kitzur version, --version and -V print the package.json version', (t) => {
  for (const arg of ['version', '--version', '-V']) {
    const r = run(t, arg);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `kitzur ${version} (node ${process.version})\n`);
  }
});

test('doctor --snapshot - reports the package.json version', (t) => {
  const r = run(t, 'doctor', '--snapshot', '-');
  assert.ok(r.stdout.trim().startsWith('{'), `no snapshot JSON (exit ${r.status}): ${r.stdout}${r.stderr}`);
  assert.equal((JSON.parse(r.stdout) as { version: string }).version, version);
});

test('serve /status reports the package.json version', async (t) => {
  const f = await startProxy(t, 'http://127.0.0.1:9', passthroughEngine());
  try {
    const status = (await request(f.port, { method: 'GET', path: '/status' })).json();
    assert.equal(status.version, version);
  } finally { await f.close(); }
});
