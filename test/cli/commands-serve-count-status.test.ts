import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-cmds-'));
  try { await f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('serve, count and status keep their usage-error contract through main', () =>
  withTmp(async (dir) => {
    for (const argv of [['serve', '--frob'], ['serve', 'extra'], ['count'], ['count', 'a.json', 'b.json'], ['status', '--frob']]) {
      const r = await run(argv, dir);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /^kitzur: /, argv.join(' '));
      assert.equal(r.out, '');
    }
    assert.match((await run(['serve', '--frob'], dir)).err, /unknown option --frob/);
    assert.match((await run(['count'], dir)).err, /count needs one request file/);
    writeFileSync(join(dir, 'nope.json'), JSON.stringify({ prompt: 'p' }));
    const notChat = await run(['count', 'nope.json', '--state-dir', dir], dir);
    assert.equal(notChat.code, 2);
    assert.match(notChat.err, /nope\.json: not a chat request/);
    // an unparseable --url is a runtime failure (exit 1), not a usage error
    const badUrl = await run(['status', '--url', 'not a url'], dir);
    assert.equal(badUrl.code, 1);
    assert.match(badUrl.err, /^kitzur: cannot reach not a url: /);
  }));

test('serve loads the runtime log from its new directory and exits 2 without an upstream origin', () =>
  withTmp(async (dir) => {
    const r = await run(['serve', '--state-dir', dir], dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /kitzur: config error: upstream\.origin is required/);
  }));

test('count --estimate measures a tiny synthetic request offline', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hello there' }] }));
    const r = await run(['count', 'r.json', '--estimate', '--json', '--state-dir', dir], dir);
    assert.equal(r.code, 0, r.err);
    const o = JSON.parse(r.out) as { file: string; messages: number; tools: number; tReq: number; total: number; overhead: number; perMessage: Array<{ i: number; role: string; tokens: number }> };
    assert.equal(o.file, 'r.json');
    assert.equal(o.messages, 1);
    assert.equal(o.tools, 0);
    assert.equal(o.tReq, 100);
    assert.deepEqual(o.perMessage.map((m) => [m.i, m.role]), [[0, 'user']]);
    assert.equal(o.perMessage[0]!.tokens + o.overhead, o.total);
    assert.ok(!r.out.includes('hello'), 'no content');
  }));
