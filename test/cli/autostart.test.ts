import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { loadConfig } from '../../src/config/load.js';
import { runAutostart, shortcutArguments, shortcutScript, windowsQuote } from '../../src/autostart.js';

test('autostart help and invalid actions', async () => {
  let out = '';
  const io: CliIO = { stdout: s => { out += s; }, stderr: () => {}, cwd: process.cwd(), env: {}, onSignal: () => {} };
  assert.equal(await main(['autostart', '--help'], io), 0);
  assert.match(out, /install\|remove\|status\|run/);
  assert.equal(await main(['autostart', 'unknown'], io), 2);
});

test('Windows argument and PowerShell quoting handle spaces, quotes and apostrophes', () => {
  assert.equal(windowsQuote('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(windowsQuote('a"b'), '"a\\"b"');
  assert.equal(shortcutArguments("C:\\O'Brien\\config.json", 'C:\\cli space.js'), `"C:\\cli space.js" autostart run --config "C:\\O'Brien\\config.json"`);
  assert.match(shortcutScript("C:\\O'Brien\\config.json", 'C:\\state'), /O''Brien/);
  assert.doesNotMatch(shortcutScript('config', 'state'), /ExecutionPolicy/);
});

test('port guard accepts Kitzur and refuses unrelated or hung listeners', async () => {
  for (const kind of ['responsive', 'other', 'hung'] as const) {
    const server = kind === 'hung' ? tcpServer(s => s.resume()) : createServer((req, res) => {
      // answer what probeInstance needs from a live Kitzur: GET /status, 200, a JSON body naming kitzur
      if (req.method !== 'GET' || req.url !== '/status' || req.headers.authorization !== 'Bearer secret') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: kind === 'responsive' ? 'kitzur' : 'unrelated' }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
      const cfg = loadConfig({ env: {}, object: { listen: { host: '127.0.0.1', port: addr.port, token: 'secret' } } }).config;
      const lines: string[] = [];
      assert.equal(await runAutostart(cfg, '/unused', '/unused', { timeoutMs: kind === 'hung' ? 1000 : 3000, log: s => lines.push(s) }), kind === 'responsive' ? 0 : 1);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, kind === 'responsive' ? /already running/ : /occupied/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('free port starts detached and appends output on repeated runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur autostart '));
  const listener = tcpServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const addr = listener.address(); assert.ok(addr && typeof addr !== 'string');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const cfg = loadConfig({ env: {}, object: { listen: { host: '127.0.0.1', port: addr.port } } }).config;
  const script = join(dir, "fake cli's.cjs");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2))); console.error('appended');");
  try {
    for (let i = 0; i < 2; i++) {
      await runAutostart(cfg, join(dir, 'config.json'), dir, { cli: script, log: () => {} });
      const log = join(dir, 'logs', 'serve-stdio.log');
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('child output timeout')); }, 5000);
        const poll = setInterval(() => {
          if (readFileSync(log, 'utf8').split('appended').length - 1 === i + 1) { clearInterval(poll); clearTimeout(deadline); resolve(); }
        }, 20);
      });
    }
    const output = readFileSync(join(dir, 'logs', 'serve-stdio.log'), 'utf8');
    assert.equal(output.split('appended').length - 1, 2);
    assert.ok(output.includes(JSON.stringify(join(dir, 'config.json'))));
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
