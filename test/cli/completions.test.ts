import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { main, type CliIO } from '../../src/cli.js';
import { USAGE } from '../../src/cli/usage.js';
import { completionData } from '../../src/cli/commands/completions.js';
import { ROOT } from '../helpers.js';

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd: ROOT, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

const COMMANDS = [...new Set(USAGE.split('\n\n')[1]!.split('\n').flatMap((l) => /^ {2}(\S+)/.exec(l)?.slice(1) ?? []))];

test('completionData: commands, subcommands and flags come from USAGE', () => {
  const data = new Map(completionData().map((c) => [c.name, c]));
  assert.deepEqual([...data.keys()], COMMANDS);
  assert.deepEqual(data.get('config')!.subs, ['init', 'show', 'validate', 'import-eval', 'export-opencode']);
  assert.deepEqual(data.get('state')!.subs, ['show', 'reset']);
  assert.deepEqual(data.get('autostart')!.subs, ['install', 'remove', 'status', 'run']);
  assert.deepEqual(data.get('completions')!.subs, ['bash', 'zsh', 'fish']);
  assert.ok(data.get('serve')!.flags.includes('--drain-ms'));
  assert.ok(data.get('serve')!.flags.includes('-c'));
  assert.ok(!data.get('report')!.flags.includes('-c'));
});

test('completions: every shell prints an ASCII script naming every command and serve --drain-ms', async () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const r = await run(['completions', shell]);
    assert.equal(r.code, 0, `${shell}: ${r.err}`);
    assert.equal(r.err, '');
    assert.ok(r.out.length > 0, shell);
    assert.match(r.out, /^[\x00-\x7f]*$/, `${shell} is plain ASCII`);
    for (const cmd of COMMANDS) assert.match(r.out, new RegExp(`\\b${cmd}\\b`), `${shell}: ${cmd}`);
    assert.ok(r.out.includes(shell === 'fish' ? '-l drain-ms' : '--drain-ms'), `${shell}: serve --drain-ms`);
    assert.match(r.out, /\binit\b.*\bexport-opencode\b/, `${shell}: config subcommands`);
  }
  assert.match((await run(['completions', 'fish'])).out, /__kitzur_cmd serve' -l drain-ms/);
});

test('completions bash: the script parses with bash -n', async (t) => {
  const script = (await run(['completions', 'bash'])).out;
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return t.skip('bash not installed');
  assert.equal(r.status, 0, r.stderr);
});

test('completions: a missing or unknown shell, or an extra argument, exits 2', async () => {
  for (const argv of [['completions'], ['completions', 'tcsh']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.out, '');
    assert.ok(r.err.startsWith('kitzur: completions needs one of bash, zsh, fish\n'), r.err);
  }
  const extra = await run(['completions', 'bash', 'extra']);
  assert.equal(extra.code, 2);
  assert.equal(extra.out, '');
  assert.match(extra.err, /^kitzur: completions takes one shell \(got extra\)/);
});
