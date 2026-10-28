import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { benchEntry } from '../../src/cli/commands/bench.js';

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

test('replay over a tiny synthetic request prints sizes only and exits 0', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'secret words here' }] }));
    const r = await run(['replay', 'r.json', '--state-dir', dir], dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /; 1 request\(s\)\n/);
    assert.match(r.out, /determinism \(live == fresh\): 1\/1 ok/);
    assert.ok(!r.out.includes('secret'), 'no content');
    const j = await run(['replay', 'r.json', '--json', '--no-fresh', '--state-dir', dir], dir);
    assert.equal(j.code, 0, j.err);
    const o = JSON.parse(j.out) as { requests: Array<Record<string, unknown>>; mismatches: number; failures: number };
    assert.equal(o.requests.length, 1);
    assert.equal(o.requests[0]!['file'], 'r.json');
    assert.equal(o.requests[0]!['deterministic'], undefined);
    assert.deepEqual([o.mismatches, o.failures], [0, 0]);
    assert.match((await run(['replay'], dir)).err, /replay needs a file or directory/);
  }));

test('state show and reset on an empty state directory', () =>
  withTmp(async (dir) => {
    const show = await run(['state', 'show', '--state-dir', dir], dir);
    assert.equal(show.code, 0, show.err);
    assert.match(show.out, /: 0 entries\n$/);
    const reset = await run(['state', 'reset', '--plans', '--state-dir', dir], dir);
    assert.equal(reset.code, 0, reset.err);
    assert.equal(reset.out, 'no matching entries\nrestart a running proxy: it keeps its entries in memory and writes them back\n');
    const bad = await run(['state', 'frob'], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /state needs a subcommand: show, reset/);
  }));

test('bench answers --help with its usage and does not start the suite', () =>
  withTmp(async (dir) => {
    for (const h of ['--help', '-h']) {
      const r = await run(['bench', h], dir);
      assert.equal(r.code, 0);
      assert.match(r.out, /bench/);
      assert.equal(r.err, '');
    }
  }));

test('benchEntry points at the built benchmark runner', () => {
  const p = benchEntry();
  assert.equal(basename(p), 'run-all.js');
  assert.ok(existsSync(p), p);
});
