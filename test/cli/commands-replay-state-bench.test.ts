import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { benchEntry } from '../../src/cli/commands/bench.js';
import { loadModules } from '../../src/app.js';

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

test('replay picks the model profile from each request, with a --model override', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'kitzur.json'), JSON.stringify({ budget: { window: 100000 }, models: { 'org/small': { budget: { window: 50000 } } } }));
    mkdirSync(join(dir, 'reqs'));
    const messages = [{ role: 'user', content: 'hello there' }];
    writeFileSync(join(dir, 'reqs', 'a.json'), JSON.stringify({ model: 'org/small', max_tokens: 100, messages }));
    writeFileSync(join(dir, 'reqs', 'b.json'), JSON.stringify({ model: 'other', max_tokens: 100, messages }));
    writeFileSync(join(dir, 'reqs', 'c.json'), JSON.stringify({ max_tokens: 100, messages }));
    const replay = async (...extra: string[]) => {
      const r = await run(['replay', 'reqs', '--config', 'kitzur.json', '--json', '--state-dir', dir, ...extra], dir);
      assert.equal(r.code, 0, r.err);
      return (JSON.parse(r.out) as { requests: Array<Record<string, unknown>> }).requests.map((q) => [q['profile'], q['budget'], q['trigger']]);
    };
    const rows = await replay();
    assert.deepEqual(rows.map((q) => q[0]), ['org/small', 'root', 'root']);
    assert.notEqual(rows[0]![1], rows[1]![1], 'budget differs by profile');
    assert.notEqual(rows[0]![2], rows[1]![2], 'trigger differs by profile');
    assert.deepEqual(rows[1], rows[2]);
    const forced = await replay('--model', 'org/small');
    assert.deepEqual(forced, [rows[0], rows[0], rows[0]]);
    const text = await run(['replay', join('reqs', 'a.json'), '--config', 'kitzur.json', '--no-fresh', '--state-dir', dir], dir);
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, / {2}profile\n[^\n]+ {2}org\/small\n/);
    const bad = await run(['replay', 'reqs', '--config', 'kitzur.json', '--model', 'nope', '--state-dir', dir], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--model nope: no configured profile for this model \(configured: org\/small\)/);
  }));

test('replay without model profiles reports root in JSON and text', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
    const j = await run(['replay', 'r.json', '--json', '--no-fresh', '--state-dir', dir], dir);
    assert.equal((JSON.parse(j.out) as { requests: Array<Record<string, unknown>> }).requests[0]!['profile'], 'root');
    const t = await run(['replay', 'r.json', '--no-fresh', '--state-dir', dir], dir);
    assert.match(t.out, /max_tok {2}det {2}profile\n[^\n]+ {2}root\n/);
    const bad = await run(['replay', 'r.json', '--model', 'm', '--state-dir', dir], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /\(configured: none\)/);
  }));

test('replay text output names the profile of a request that fails processing', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'kitzur.json'), JSON.stringify({ budget: { window: 100000 }, models: { 'org/small': { budget: { window: 50000 } } } }));
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'org/small', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
    const base = await loadModules({ proxy: false });
    const createEngine: typeof base.createEngine = (c, o) => {
      if (c.budget.window === 50000) throw new Error('profile engine broke');
      return base.createEngine(c, o);
    };
    const out: string[] = [];
    const io: CliIO = { stdout: (s) => void out.push(s), stderr: () => undefined, env: {}, cwd: dir, onSignal: () => undefined, modules: { ...base, createEngine } };
    assert.equal(await main(['replay', 'r.json', '--config', 'kitzur.json', '--no-fresh', '--state-dir', dir], io), 1);
    assert.match(out.join(''), / ERROR Error: profile engine broke {2}profile org\/small\n/);
  }));
