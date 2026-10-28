import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, type CliIO } from '../../src/cli.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('config show and validate report each model profile and --model selects it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-model-cli-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ budget: { window: 200000 }, models: { alpha: { budget: { window: 180000 } }, beta: { budget: { window: 150000 } } } }));
  const run = async (args: string[]) => {
    let out = '';
    const io: CliIO = { stdout: (s) => { out += s; }, stderr: () => {}, env: {}, cwd: process.cwd(), onSignal: () => {} };
    const code = await main(args, io);
    return { code, out };
  };
  try {
    const show = await run(['config', 'show', '--config', path]);
    assert.equal(show.code, 0);
    assert.match(show.out, /# model alpha[\s\S]*W +180000[\s\S]*# model beta[\s\S]*W +150000/);
    const json = await run(['config', 'show', '--json', '--config', path]);
    assert.equal(Object.keys(JSON.parse(json.out).derivedByModel).length, 2);
    const selected = await run(['config', 'show', '--model', 'alpha', '--config', path]);
    assert.equal(selected.code, 0);
    assert.match(selected.out, /# model alpha/);
    assert.doesNotMatch(selected.out, /# model beta/);
    const validation = await run(['config', 'validate', '--config', path]);
    assert.equal(validation.code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
