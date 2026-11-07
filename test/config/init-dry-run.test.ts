import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { renderInitConfig } from '../../src/config/init.js';
import { loadConfig } from '../../src/config/load.js';
import { PRESET_TABLE } from '../../src/config/presets.js';
import { validateConfig } from '../../src/config/validate.js';

async function run(argv: string[], cwd = process.cwd()): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}
function withTmp(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-init-'));
  return f(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
/** Loads the text as a config file with upstream filled in; returns the model IDs after asserting no validation errors. */
function validates(dir: string, text: string): string[] {
  const file = join(dir, 'check.jsonc');
  writeFileSync(file, text.replace('"origin": null', '"origin": "http://gw.example.com:8000"'));
  const l = loadConfig({ configPath: file, env: {} });
  assert.deepEqual(validateConfig(l.config, { provenance: l.provenance }).errors, []);
  for (const id of Object.keys(l.models)) assert.deepEqual(validateConfig(l.models[id]!).errors, [], id);
  return Object.keys(l.models);
}

test('config init without --model or --dry-run: the text is unchanged (golden)', () => {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  assert.equal(sha(renderInitConfig('32k')), '72dcf5e37fc4620609d4de8f3254eae3d7ac9b155fe95d0d865212064d7ab42c');
  assert.equal(sha(renderInitConfig('64k')), 'a424d3e5f2daf7a8332da809fc7d95d7f9f1bd6b456010ea9d7678fe91ac7375');
  assert.equal(sha(renderInitConfig('100k')), 'fe2b7e317451725fd8f2e8fd91b8e0f76ea683911dea7db0f83613a4c171713a');
  assert.equal(sha(renderInitConfig('128k')), 'dc64c6b3994697f546362195a3c20e3149a0ce5c2eef30151150944d1df188d5');
  assert.equal(sha(renderInitConfig('100k', { upstream: 'http://gw.example.com:8000', tokenizer: '/opt/tok.json', models: [] })), '2ffe0a4f60b2aea1f63f5c40fc30e3782f5936ac72eed3eaa964ef7bc66ffe6a');
});

test('config init --dry-run on a new path: writes nothing, not even the directory', () =>
  withTmp(async (dir) => {
    const r = await run(['config', 'init', '--dry-run', '--out', 'sub/dir/k.jsonc'], dir);
    assert.equal(r.code, 0, r.err);
    const path = join(dir, 'sub', 'dir', 'k.jsonc');
    assert.ok(r.out.startsWith(`would write ${path} (new)\n${renderInitConfig('100k')}`));
    assert.match(r.out, /\nnext: set upstream\.origin and tokenizer\.path, then: kitzur config validate --config sub\/dir\/k\.jsonc\n$/);
    assert.equal(existsSync(join(dir, 'sub')), false);
  }));

test('config init --dry-run on an existing path: refused without --force, would overwrite with it', () =>
  withTmp(async (dir) => {
    const path = join(dir, 'k.jsonc');
    writeFileSync(path, 'old');
    const refused = await run(['config', 'init', '--dry-run', '--out', 'k.jsonc'], dir);
    assert.equal(refused.code, 1);
    assert.ok(refused.out.startsWith(`would write ${path} (exists: refused without --force)\n// kitzur configuration`));
    const forced = await run(['config', 'init', '--dry-run', '--force', '--out', 'k.jsonc'], dir);
    assert.equal(forced.code, 0, forced.err);
    assert.ok(forced.out.startsWith(`would write ${path} (exists: would overwrite, --force)\n`));
    assert.equal(readFileSync(path, 'utf8'), 'old');
    const stdout = await run(['config', 'init', '--dry-run', '--out', '-'], dir);
    assert.equal(stdout.out, renderInitConfig('100k'));
  }));

test('config init --model: one or several profiles, IDs JSON-escaped, every variant validates', () =>
  withTmp(async (dir) => {
    const one = await run(['config', 'init', '-o', '-', '--model', 'org/qwen.v1']);
    assert.equal(one.code, 0, one.err);
    assert.match(one.out, /may set the per-model groups budget, client and tokenizer/);
    assert.deepEqual(validates(dir, one.out), ['org/qwen.v1']);
    const ids = ['org/qwen.v1', 'a.b/c-d:7b', 'say "hi"\\x'];
    for (const [preset, { window }] of Object.entries(PRESET_TABLE)) {
      const big = window * 2;
      const many = await run(['config', 'init', '-p', preset, '-o', '-', '--model', `${ids[0]}=${big.toLocaleString('en-US').replaceAll(',', '_')}`, '--model', ids[1]!, '--model', `${ids[2]}=${window}`]);
      assert.equal(many.code, 0, many.err);
      assert.ok(many.out.includes(`${JSON.stringify(ids[2])}: { "budget": { "window": ${window} } }`));
      assert.deepEqual(validates(dir, many.out), ids);
      const file = join(dir, 'check.jsonc');
      const l = loadConfig({ configPath: file, env: {} });
      assert.equal(l.models[ids[0]!]!.budget.window, big);
      assert.equal(l.models[ids[1]!]!.budget.window, l.config.budget.window, 'no =WINDOW inherits the root');
    }
    const dry = await run(['config', 'init', '--dry-run', '--model', 'm=64000', '--out', 'k.jsonc'], dir);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /"m": \{ "budget": \{ "window": 64000 \} \}/);
  }));

test('config init --model: duplicate, empty and invalid values are usage errors that name the flag', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['--model', 'm', '--model', 'm=32000'], /--model "m": given twice; pass each model ID once/],
    [['--model', ''], /--model "": empty model ID; pass the exact wire model ID/],
    [['--model', '=32000'], /empty model ID/],
    [['--model', 'm=32k'], /--model "m=32k": the window must be a positive integer such as 32000 or 32_000/],
    [['--model', 'm=0'], /must be a positive integer/],
    [['--model', 'm=1.5'], /must be a positive integer/],
    [['--model', 'm='], /must be a positive integer/],
    [['--model', '__proto__'], /--model "__proto__": invalid model ID/],
    [['--model', 'm=1000'], /config init --model: models\["m"\]: no room for the prompt.*; pass a larger window/],
  ];
  for (const [args, want] of cases) {
    const r = await run(['config', 'init', '-o', '-', ...args]);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, '');
    assert.match(r.err, want);
  }
});
