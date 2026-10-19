import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, type CliIO } from '../../src/cli.js';

test('autostart is discoverable and rejects unknown actions', async () => {
  let out = '';
  const io: CliIO = { stdout: s => { out += s; }, stderr: () => {}, cwd: process.cwd(), env: {}, onSignal: () => {} };
  assert.equal(await main(['autostart', '--help'], io), 0);
  assert.match(out, /install\|remove\|status\|run/);
  assert.equal(await main(['autostart', 'unknown'], io), 2);
});

import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config/load.js';
import { runAutostart, shortcutArguments, shortcutScript, windowsQuote } from '../../src/autostart.js';

test('Windows and PowerShell quoting preserve spaces, apostrophes, quotes and trailing slashes', () => {
  assert.equal(windowsQuote('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(windowsQuote('a"b'), '"a\\"b"');
  assert.equal(shortcutArguments("C:\\O'Brien\\config.json", 'C:\\cli space.js'), '"C:\\cli space.js" autostart run --config "C:\\O\'Brien\\config.json"');
  assert.match(shortcutScript("C:\\O'Brien\\config.json", 'C:\\state'), /O''Brien/);
  assert.doesNotMatch(shortcutScript('config', 'state'), /ExecutionPolicy|Start-Process/);
});

test('guard refuses unrelated and hung listeners; recognises authenticated Kitzur', async () => {
  for (const kind of ['responsive', 'other', 'hung'] as const) {
    const server = kind === 'hung' ? tcpServer(s => { s.on('error', () => {}); s.resume(); }) : createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer secret');
      res.end(JSON.stringify({ name: kind === 'responsive' ? 'kitzur' : 'unrelated' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const cfg = loadConfig({ env: {}, object: { listen: { host: '127.0.0.1', port: address.port, token: 'secret' } } }).config;
      const lines: string[] = [];
      assert.equal(await runAutostart(cfg, '/unused', '/unused', { timeoutMs: 200, log: s => lines.push(s) }), kind === 'responsive' ? 0 : 1);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, kind === 'responsive' ? /already running/ : /occupied/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('free port launches detached and appends stdout/stderr; spawn errors surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur autostart '));
  const listener = tcpServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const cfg = loadConfig({ env: {}, object: { listen: { host: '127.0.0.1', port: address.port } } }).config;
  const script = join(dir, "fake cli's.cjs");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2))); console.error('stderr appended');");
  try {
    for (let i = 0; i < 2; i++) {
      await runAutostart(cfg, join(dir, 'config.json'), dir, { cli: script, log: () => {} });
      // Watch the actual output, bounded; this is not a background full-suite wait.
      const log = join(dir, 'logs', 'serve-stdio.log');
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('child output timeout')); }, 5000);
        const poll = setInterval(() => {
          if (readFileSync(log, 'utf8').split('stderr appended').length - 1 === i + 1) { clearInterval(poll); clearTimeout(deadline); resolve(); }
        }, 20);
      });
    }
    const text = readFileSync(join(dir, 'logs', 'serve-stdio.log'), 'utf8');
    assert.equal(text.split('stderr appended').length - 1, 2);
    assert.match(text, /serve/); assert.ok(text.includes(JSON.stringify(join(dir, 'config.json'))));
    await assert.rejects(runAutostart(cfg, join(dir, 'config.json'), dir, { node: join(dir, 'missing-node'), log: () => {} }), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('Windows shortcut install/readback, guard twice, status and removal', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "Kitzur CI's spaces "));
  const config = join(dir, 'config.json');
  const listener = tcpServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const addr = listener.address(); assert.ok(addr && typeof addr !== 'string');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  writeFileSync(config, JSON.stringify({ upstream: { origin: 'http://127.0.0.1:1' }, listen: { port: addr.port }, stateDir: dir }));
  const io: CliIO = { stdout: () => {}, stderr: () => {}, cwd: dir, env: process.env, onSignal: () => {} };
  try {
    assert.equal(await main(['autostart', 'install', '--config', config], io), 0);
    const script = "$l=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Kitzur.lnk')); @($l.TargetPath,$l.Arguments,$l.WindowStyle,$l.WorkingDirectory) | ConvertTo-Json -Compress";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [node, args, style, cwd] = JSON.parse(r.stdout);
    assert.equal(node.toLowerCase(), process.execPath.toLowerCase()); assert.equal(args, shortcutArguments(config));
    assert.equal(style, 7); assert.equal(cwd, dir);
    assert.equal(await main(['autostart', 'status'], io), 0);
    const wrapper = join(dir, 'launch.mjs');
    const pidFile = join(dir, 'child.pid');
    writeFileSync(wrapper, `import {writeFileSync} from 'node:fs'; import {main} from ${JSON.stringify(new URL('../../src/cli.js', import.meta.url).href)}; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.exitCode = await main(process.argv.slice(2));`);
    try {
      assert.equal(await runAutostart(loadConfig({ configPath: config, env: {} }).config, config, dir, { cli: wrapper, log: () => {} }), 0);
      const ready = await new Promise<boolean>(resolve => {
        const deadline = setTimeout(() => { clearInterval(poll); resolve(false); }, 15000);
        let probing = false;
        const poll = setInterval(async () => {
          if (probing) return;
          probing = true;
          const { probeInstance } = await import('../../src/diagnostics/doctor.js');
          if (await probeInstance('127.0.0.1', addr.port, 200) === 'responsive') { clearInterval(poll); clearTimeout(deadline); resolve(true); }
          probing = false;
        }, 100);
      });
      assert.ok(ready, 'detached serve becomes responsive');
      let output = '';
      for (let i = 0; i < 2; i++) assert.equal(await main(['autostart', 'run', '--config', config], { ...io, stdout: s => { output += s; } }), 0);
      assert.equal(output, 'kitzur: already running\nkitzur: already running\n');
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* child may have failed before recording its pid */ }
    }
  } finally {
    assert.equal(await main(['autostart', 'remove'], io), 0);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
