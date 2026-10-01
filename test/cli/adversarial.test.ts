// Adversarial checks of the command line against the documented workflows (README quick start, deploy/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { loadConfig } from '../../src/config/load.js';
import { buildEngine } from '../../src/app.js';

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], over: Partial<CliIO> = {}): Promise<Run> {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const x: CliIO = {
    stdout: (s) => void outBuf.push(s),
    stderr: (s) => void errBuf.push(s),
    env: {},
    cwd: process.cwd(),
    onSignal: () => undefined,
    ...over,
  };
  const code = await main(argv, x);
  return { code, out: outBuf.join(''), err: errBuf.join('') };
}

async function withTmp<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-cli-adv-'));
  try {
    return await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config init --out into a directory that does not exist yet (README quick start on a fresh host) (regression)', () =>
  withTmp(async (dir) => {
    // README: `node dist/src/cli.js config init --preset 100k --out ~/.config/kitzur/kitzur.jsonc` with no mkdir
    const r = await run(['config', 'init', '--preset', '100k', '--out', '.config/kitzur/kitzur.jsonc'], { cwd: dir });
    assert.equal(r.code, 0, r.err);
    const file = join(dir, '.config', 'kitzur', 'kitzur.jsonc');
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, 'utf8'), /"preset": "100k"/);
    assert.equal(loadConfig({ configPath: file, env: {} }).preset, '100k');
  }));

test('store.persist: the plan directory (summaries = user content) is owner-only whatever the umask (regression)', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, () =>
  withTmp(async (dir) => {
    const stateDir = join(dir, 'state');
    const l = loadConfig({ env: {}, object: { stateDir, store: { persist: true }, tokenizer: { mode: 'estimate' } } });
    const old = process.umask(0o022);
    try {
      const { engine } = await buildEngine(l.config, { env: {} });
      const msgs: Array<{ role: string; content: string }> = [{ role: 'system', content: 's' }, { role: 'user', content: 'USER-SECRET goal' }];
      for (let i = 0; i < 80; i++) msgs.push({ role: 'assistant', content: `step ${i} ` + 'x'.repeat(4000) }, { role: 'user', content: `go on ${i}` });
      engine.process({ model: 'm', messages: msgs as never, max_tokens: 1000 }, { attempt: 1 });
    } finally {
      process.umask(old);
    }
    const plans = join(stateDir, 'plans');
    assert.ok(existsSync(plans));
    assert.equal(statSync(plans).mode & 0o777, 0o700);
    assert.ok(readdirSync(plans).length > 0, 'a compaction persisted its plan');
  }));
