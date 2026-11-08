import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { listenErrorHint } from '../../src/cli/commands/serve.js';

const CLI = join(ROOT, 'dist', 'src', 'cli.js');
const home = mkdtempSync(join(tmpdir(), 'kitzur-listen-errors-'));
test.after(() => rmSync(home, { recursive: true, force: true }));
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'KITZUR_CONFIG']) delete env[k];
const serve = (...args: string[]) => spawnSync(process.execPath,
  [CLI, 'serve', '--upstream', 'http://127.0.0.1:9', '--state-dir', join(home, 'state'), ...args],
  { env, cwd: home, encoding: 'utf8', timeout: 15_000 });

test('serve on a port already in use names the port and how to pick another', async (t) => {
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
  t.after(() => holder.close());
  const port = (holder.address() as AddressInfo).port;
  const r = serve('--port', String(port));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use; another kitzur may be running \\(kitzur status --url http://127\\.0\\.0\\.1:${port}\\), or pick another port with --port N or listen\\.port`));
  assert.match(r.stderr, /\(listen EADDRINUSE: address already in use/);
});

test('serve on a host that does not resolve says listen.host must be local', () => {
  const r = serve('--host', 'nosuchhost.invalid', '--port', '0');
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /cannot listen on nosuchhost\.invalid; listen\.host \(--host\) must be an address of this machine \(127\.0\.0\.1 or ::1 for local only\)/);
  assert.match(r.stderr, /ENOTFOUND nosuchhost\.invalid/);
});

test('listenErrorHint covers privileged ports and foreign addresses, and leaves other errors alone', () => {
  assert.equal(listenErrorHint('EACCES', '127.0.0.1', 80, 'listen EACCES: permission denied 127.0.0.1:80'),
    'port 80 on 127.0.0.1 needs privileges; ports below 1024 usually do, use a higher --port N or listen.port (listen EACCES: permission denied 127.0.0.1:80)');
  assert.match(listenErrorHint('EADDRNOTAVAIL', '192.0.2.1', 8270, 'listen EADDRNOTAVAIL: address not available 192.0.2.1:8270') ?? '',
    /^cannot listen on 192\.0\.2\.1; listen\.host .*127\.0\.0\.1 or ::1 for local only\) \(listen EADDRNOTAVAIL: address not available 192\.0\.2\.1:8270\)$/);
  assert.match(listenErrorHint('EADDRINUSE', '::1', 8270, 'x') ?? '', /kitzur status --url http:\/\/\[::1\]:8270/);
  assert.equal(listenErrorHint(undefined, '127.0.0.1', 8270, 'listen EADDRINUSE'), null);
  assert.equal(listenErrorHint('EMFILE', '127.0.0.1', 8270, 'too many open files'), null);
});
