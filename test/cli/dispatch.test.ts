import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, UsageError, type CliIO } from '../../src/cli.js';
import { HELP_COMMANDS } from '../../src/cli/usage.js';
import { cmdConfig } from '../../src/cli/commands/config.js';
import { ROOT } from '../helpers.js';

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd: ROOT, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

/** Every command label main dispatches, with the module that handles it (cli.ts handles help and version itself). */
const DISPATCH: Record<string, string> = {
  help: 'cli.ts', '--help': 'cli.ts', '-h': 'cli.ts',
  version: 'cli.ts', '--version': 'cli.ts', '-V': 'cli.ts',
  serve: 'commands/serve.ts', replay: 'commands/replay.ts', count: 'commands/count.ts', status: 'commands/status.ts',
  'tls-probe': 'commands/diagnostics.ts', doctor: 'commands/diagnostics.ts', report: 'commands/diagnostics.ts',
  config: 'commands/config.ts', state: 'commands/state.ts', bench: 'commands/bench.ts',
};

test('dispatch: every command main dispatches has an entry in the table', () => {
  const src = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function main('), src.indexOf('function isEntryPoint('));
  const cases = [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]!);
  assert.deepEqual([...cases].sort(), Object.keys(DISPATCH).sort());
  for (const cmd of HELP_COMMANDS) assert.ok(cmd in DISPATCH, cmd);
  for (const [cmd, mod] of Object.entries(DISPATCH)) {
    assert.ok(existsSync(mod === 'cli.ts' ? join(ROOT, 'src', mod) : join(ROOT, 'src', 'cli', mod)), `${cmd}: ${mod}`);
  }
});

test('dispatch: every help command answers --help with exit 0 and its usage', async () => {
  for (const cmd of HELP_COMMANDS) {
    for (const flag of ['--help', '-h']) {
      const r = await run([cmd, flag]);
      assert.equal(r.code, 0, `${cmd} ${flag}: ${r.err}`);
      assert.ok(r.out.startsWith(`usage: kitzur ${cmd} [options]\n`), `${cmd} ${flag}`);
      assert.match(r.out, new RegExp(`\\n {2}${cmd.replace(/-/g, '\\-')}\\b`), `${cmd} ${flag} lists its own usage line`);
    }
  }
});

test('dispatch: help and version are answered by cli.ts itself', async () => {
  for (const h of ['help', '--help', '-h']) {
    const r = await run([h]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^usage: kitzur <command> \[options\]/);
  }
  for (const v of ['version', '--version', '-V']) {
    const r = await run([v]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^kitzur \S+ \(node v/);
  }
});

test('dispatch: config without a subcommand or with an unknown one exits 2 with its message', async () => {
  const none = await run(['config']);
  assert.equal(none.code, 2);
  assert.equal(none.err, "kitzur: config needs a subcommand: init, show, validate, import-eval, export-opencode\nrun 'kitzur help' for usage\n");
  const bogus = await run(['config', 'bogus']);
  assert.equal(bogus.code, 2);
  assert.equal(bogus.err, "kitzur: unknown config command 'bogus' (init, show, validate, import-eval, export-opencode)\nrun 'kitzur help' for usage\n");
});

test('cmdConfig: throws UsageError for a missing or unknown subcommand', async () => {
  const io: CliIO = { stdout: () => undefined, stderr: () => undefined, env: {}, cwd: ROOT, onSignal: () => undefined };
  await assert.rejects(cmdConfig([], io), (e: Error) => e instanceof UsageError && /config needs a subcommand/.test(e.message));
  await assert.rejects(cmdConfig(['nope'], io), (e: Error) => e instanceof UsageError && /unknown config command 'nope'/.test(e.message));
});
