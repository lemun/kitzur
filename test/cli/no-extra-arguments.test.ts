import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

async function withTmp(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-extra-'));
  try { await f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('config show, validate, init, export-opencode and status refuse a stray argument and write nothing', () =>
  withTmp(async (dir) => {
    for (const [name, argv] of [
      ['config show', ['config', 'show', 'extra', '--state-dir', dir]],
      ['config validate', ['config', 'validate', 'extra', '--state-dir', dir]],
      ['config init', ['config', 'init', 'extra', '--dry-run']],
      ['config init', ['config', 'init', 'extra']],
      ['config export-opencode', ['config', 'export-opencode', '--model', 'm', 'extra', '--state-dir', dir]],
      ['status', ['status', 'http://host:8270', '--state-dir', dir]],
    ] as const) {
      const r = await run([...argv], dir);
      assert.equal(r.code, 2, argv.join(' '));
      assert.equal(r.out, '', argv.join(' '));
      const got = name === 'status' ? 'http://host:8270' : 'extra';
      assert.ok(r.err.startsWith(`kitzur: ${name} takes no arguments (got ${got})`), r.err);
      assert.doesNotMatch(r.err, /cannot reach/);
    }
    assert.match((await run(['status', 'http://host:8270'], dir)).err, /; use --url URL/);
    assert.deepEqual(readdirSync(dir), []);
  }));

test('the same commands still work without the stray argument', () =>
  withTmp(async (dir) => {
    assert.equal((await run(['config', 'show', '--state-dir', dir], dir)).code, 0);
    assert.match((await run(['config', 'validate', '--state-dir', dir], dir)).out, /ok \(/);
    const dry = await run(['config', 'init', '--dry-run'], dir);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /would write .*kitzur\.config\.jsonc \(new\)/);
    assert.equal(existsSync(join(dir, 'kitzur.config.jsonc')), false);
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ models: { m: {} } }));
    const exp = await run(['config', 'export-opencode', '--model', 'm', '--config', join(dir, 'm.json'), '--state-dir', dir], dir);
    assert.equal(exp.code, 0, exp.err);
    const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const st = await run(['status', '--url', `http://127.0.0.1:${port}/status`, '--json'], dir);
      assert.equal(st.code, 0, st.err);
      assert.match(st.out, /"ok": true/);
    } finally {
      server.close();
    }
  }));
