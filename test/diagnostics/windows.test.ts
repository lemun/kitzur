import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { doctor } from '../../src/diagnostics/doctor.js';
import { parseExcludedPortRanges, portOutside, syncedRoot, windowsChecks, type WindowsDeps } from '../../src/diagnostics/windows.js';
import { ROOT } from '../helpers.js';

const NETSH = [
  '',
  'Protocol tcp Port Exclusion Ranges',
  '',
  'Start Port    End Port',
  '----------    --------',
  '      5357        5357',
  '      8080        8082',
  '     50000       50059     *',
  '',
  '* - Administered port exclusions.',
  '',
].join('\r\n');

const input = { port: 8081, stateDir: 'C:\\Users\\example\\AppData\\Local\\kitzur', logFile: 'C:\\Users\\example\\AppData\\Local\\kitzur\\logs\\kitzur.log', configPath: 'C:\\Users\\example\\kitzur.json' };
const deps = (over: WindowsDeps = {}): WindowsDeps => ({ platform: 'win32', env: {}, run: () => NETSH, autostartStatus: async () => 'not installed: C:\\Startup\\Kitzur.lnk\n', ...over });
const find = (checks: Awaited<ReturnType<typeof windowsChecks>>, code: string) => checks.find((c) => c.code === code);

test('netsh excluded port ranges parse from ASCII output and from empty output', () => {
  assert.deepEqual(parseExcludedPortRanges(NETSH), [[5357, 5357], [8080, 8082], [50000, 50059]]);
  assert.deepEqual(parseExcludedPortRanges(''), []);
  assert.equal(portOutside([[8080, 8082]], 8081), 8083);
});

test('windows.port warns inside an excluded range and suggests a free port', async () => {
  const port = find(await windowsChecks(input, deps()), 'windows.port')!;
  assert.equal(port.status, 'warn');
  assert.match(port.message, /8080-8082/);
  assert.match(port.fix!, /listen\.port to 8083/);
  assert.equal(find(await windowsChecks({ ...input, port: 4141 }, deps()), 'windows.port')!.status, 'ok');
});

test('missing netsh, empty output or a throwing runner yield no warning', async () => {
  for (const run of [() => null, () => '', () => { throw new Error('ENOENT'); }]) {
    const checks = await windowsChecks(input, deps({ run }));
    assert.equal(find(checks, 'windows.port')!.status, 'ok');
    assert.ok(checks.every((c) => c.status !== 'error'));
  }
});

test('windows.synced_folder warns for paths under OneDrive or similar folders', async () => {
  const env = { OneDrive: 'C:\\Users\\example\\OneDrive - Example Ltd' };
  assert.equal(syncedRoot('c:/users/example/onedrive - example ltd/kitzur', env), env.OneDrive);
  assert.equal(syncedRoot('D:\\Dropbox\\kitzur.json', {}), 'D:\\Dropbox');
  assert.equal(syncedRoot('C:\\Users\\example\\AppData\\Local\\kitzur', env), null);
  const checks = await windowsChecks({ ...input, configPath: 'C:\\Users\\example\\OneDrive - Example Ltd\\kitzur.json' }, deps({ env }));
  const synced = find(checks, 'windows.synced_folder')!;
  assert.equal(synced.status, 'warn');
  assert.match(synced.message, /config file is under/);
  assert.equal(find(await windowsChecks(input, deps({ env })), 'windows.synced_folder')!.status, 'ok');
});

test('windows.autostart reports the Startup shortcut state without failing', async () => {
  assert.match(find(await windowsChecks(input, deps({ autostartStatus: async () => 'installed: C:\\Startup\\Kitzur.lnk\n' })), 'windows.autostart')!.message, /is installed/);
  assert.match(find(await windowsChecks(input, deps()), 'windows.autostart')!.message, /not installed/);
  const failing = find(await windowsChecks(input, deps({ autostartStatus: async () => { throw new Error('no PowerShell'); } })), 'windows.autostart')!;
  assert.equal(failing.status, 'ok');
});

test('doctor runs the Windows checks only on win32', async () => {
  const cfg = defaultConfig();
  cfg.listen.port = 0;
  assert.deepEqual(await windowsChecks(input, { platform: 'linux', run: () => { throw new Error('must not run'); } }), []);
  const other = await doctor(cfg, { windows: { platform: 'linux' } });
  assert.ok(other.checks.every((c) => !c.code.startsWith('windows.')));
  const win = await doctor(cfg, { windows: deps() });
  assert.deepEqual(win.checks.filter((c) => c.code.startsWith('windows.')).map((c) => c.code), ['windows.port', 'windows.synced_folder', 'windows.autostart']);
});

test('the Windows check codes are documented in TROUBLESHOOTING.md', () => {
  const doc = readFileSync(join(ROOT, 'docs/TROUBLESHOOTING.md'), 'utf8');
  for (const code of ['windows.port', 'windows.synced_folder', 'windows.autostart']) assert.ok(doc.includes(`\`${code}\``), code);
});
