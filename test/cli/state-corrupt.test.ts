import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function withState(content: string, f: (dir: string, file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-state-corrupt-'));
  const file = join(dir, 'learned.json');
  writeFileSync(file, content);
  try { await f(dir, file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const DAMAGED = ['{"version":2,"entr', 'not json at all\n', '[]'];
const SHOW_HINT = "kitzur: the proxy ignores this file and learns from scratch; run 'kitzur state reset' to move it aside\n";

for (const content of DAMAGED) {
  test(`state show on a damaged learned.json (${JSON.stringify(content)}) says what it means and exits 1`, () =>
    withState(content, async (dir, file) => {
      const show = await run(['state', 'show', '--state-dir', dir], dir);
      assert.equal(show.code, 1);
      assert.ok(show.err.startsWith(`kitzur: ${file}: `), show.err);
      assert.ok(show.err.endsWith(SHOW_HINT), show.err);
      assert.equal(readFileSync(file, 'utf8'), content);
    }));

  test(`state reset moves a damaged learned.json (${JSON.stringify(content)}) aside`, () =>
    withState(content, async (dir, file) => {
      const reset = await run(['state', 'reset', '--state-dir', dir], dir);
      assert.equal(reset.code, 0, reset.err);
      assert.ok(reset.out.startsWith(`moved the unreadable ${file} to ${file}.corrupt; the proxy learns from scratch\n`), reset.out);
      assert.match(reset.out, /restart a running proxy/);
      assert.equal(existsSync(file), false);
      assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), content);
      const again = await run(['state', 'reset', '--state-dir', dir], dir);
      assert.equal(again.code, 0);
      assert.match(again.out, /^no matching entries\n/);
    }));

  test(`state reset --key on a damaged learned.json (${JSON.stringify(content)}) changes nothing and exits 1`, () =>
    withState(content, async (dir, file) => {
      const reset = await run(['state', 'reset', '--key', 'model-a', '--state-dir', dir], dir);
      assert.equal(reset.code, 1);
      assert.equal(reset.err, `kitzur: cannot select entries in an unreadable ${file}; run 'kitzur state reset' without --key to move it aside\n`);
      assert.equal(reset.out, '');
      assert.equal(readFileSync(file, 'utf8'), content);
      assert.equal(existsSync(`${file}.corrupt`), false);
    }));
}

test('state reset replaces an older .corrupt file', () =>
  withState('garbage', async (dir, file) => {
    writeFileSync(`${file}.corrupt`, 'older');
    const reset = await run(['state', 'reset', '--state-dir', dir], dir);
    assert.equal(reset.code, 0);
    assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), 'garbage');
  }));

test('a valid learned.json is untouched by show and by reset --key of a missing key', () => {
  const e = { ...freshLearnedEntry(100_000, 'c1'), window: 90_000 };
  return withState(JSON.stringify({ version: 2, entries: { 'http://a|model-a': e } }, null, 1) + '\n', async (dir, file) => {
    const before = readFileSync(file, 'utf8');
    const show = await run(['state', 'show', '--state-dir', dir], dir);
    assert.equal(show.code, 0);
    assert.equal(show.err, '');
    const reset = await run(['state', 'reset', '--key', 'nope', '--state-dir', dir], dir);
    assert.equal(reset.code, 0);
    assert.match(reset.out, /^no matching entries\n/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(`${file}.corrupt`), false);
  });
});
