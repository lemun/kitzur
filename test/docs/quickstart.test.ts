import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const CLI = join(ROOT, 'dist', 'src', 'cli.js');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('README quick start commands work against the built CLI', async (t) => {
  const block = /## Quick start[\s\S]*?```sh\n([\s\S]*?)```/.exec(readme)?.[1];
  assert.ok(block, 'README must have a Quick start sh block');
  assert.match(block, /node dist\/src\/cli\.js config init --preset 32k --out ~\/\.config\/kitzur\/kitzur\.jsonc \\\n\s+--upstream \S+ --tokenizer \S+/);
  assert.match(readme.slice(readme.indexOf(block)), /node dist\/src\/cli\.js serve --config ~\/\.config\/kitzur\/kitzur\.jsonc/);

  const home = mkdtempSync(join(tmpdir(), 'kitzur-quickstart-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'KITZUR_CONFIG']) delete env[k];
  const file = join(home, '.config', 'kitzur', 'kitzur.jsonc');
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: home, encoding: 'utf8', timeout: 15_000 });

  const upstream = createServer((req, res) => {
    res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const init = run('config', 'init', '--preset', '32k', '--out', file,
    '--upstream', upstreamUrl, '--tokenizer', join(home, 'nonexistent', 'tokenizer.json'));
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /wrote /);
  assert.ok(existsSync(file));
  for (const args of [['config', 'validate', '--config', file], ['config', 'validate']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }

  if (process.platform === 'win32') return;
  const child = spawn(process.execPath, [CLI, 'serve', '--config', file, '--set', 'listen.port=0'], { env, cwd: home });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no 'listening on' within 10 s: ${stderr}`)), 10_000);
      let out = '';
      child.stdout.on('data', (d) => {
        const m = /listening on (http:\/\/\S+)/.exec((out += d));
        if (m) { clearTimeout(timer); resolve(m[1]!); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`serve exited ${code}: ${stderr}`)); });
    });
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { version?: string }).version, version);
    child.kill('SIGTERM');
    const timeout = new Promise<'timeout'>((r) => setTimeout(r, 10_000, 'timeout').unref());
    assert.notEqual(await Promise.race([exited, timeout]), 'timeout', 'serve did not exit on SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
