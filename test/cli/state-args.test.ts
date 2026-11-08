import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { freshLearnedEntry } from '../../src/proxy/state.js';

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

async function withState(f: (dir: string, file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-state-args-'));
  const file = join(dir, 'learned.json');
  const e = { ...freshLearnedEntry(100_000, 'c1'), window: 90_000 };
  writeFileSync(file, JSON.stringify({ version: 2, entries: { 'http://a|model-a': e, 'http://b|model-b': e } }, null, 1) + '\n');
  try { await f(dir, file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('state reset and show refuse a stray argument and leave every entry on disk', () =>
  withState(async (dir, file) => {
    const before = readFileSync(file, 'utf8');
    const reset = await run(['state', 'reset', 'typo', '--state-dir', dir], dir);
    assert.equal(reset.code, 2);
    assert.match(reset.err, /kitzur: state reset takes no arguments \(got typo\); use --key K to select one entry\n/);
    assert.equal(reset.out, '');
    assert.equal(readFileSync(file, 'utf8'), before);
    const show = await run(['state', 'show', 'typo', '--state-dir', dir], dir);
    assert.equal(show.code, 2);
    assert.match(show.err, /kitzur: state show takes no arguments \(got typo\)/);
  }));

test('state reset --key still removes only the matching entry, and show --json still works', () =>
  withState(async (dir) => {
    const reset = await run(['state', 'reset', '--key', 'model-a', '--state-dir', dir], dir);
    assert.equal(reset.code, 0, reset.err);
    assert.match(reset.out, /^removed 1 entry: http:\/\/a\|model-a\n/);
    const show = await run(['state', 'show', '--json', '--state-dir', dir], dir);
    assert.equal(show.code, 0, show.err);
    assert.deepEqual(Object.keys(JSON.parse(show.out).entries), ['http://b|model-b']);
  }));
