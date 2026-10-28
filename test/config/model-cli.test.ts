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
    assert.deepEqual(Object.keys(JSON.parse(json.out).derivedByModel), ['alpha', 'beta']);
    assert.equal(JSON.parse(json.out).derivedByModel.alpha[1], 'W             180000');
    const selected = await run(['config', 'show', '--model', 'alpha', '--config', path]);
    assert.equal(selected.code, 0);
    assert.match(selected.out, /# model alpha/);
    assert.doesNotMatch(selected.out, /# model beta/);
    const validation = await run(['config', 'validate', '--config', path]);
    assert.equal(validation.code, 0);

    writeFileSync(path, JSON.stringify({ upstream: { caFile: 'missing.pem' }, models: { alpha: {}, beta: {} } }));
    const invalid = await run(['config', 'validate', '--json', '--config', path]);
    assert.equal(invalid.code, 2);
    const errors = JSON.parse(invalid.out).errors as string[];
    assert.equal(errors.length, 3);
    assert.match(errors[0]!, /^upstream\.caFile: file not found:/);
    assert.match(errors[1]!, /^models\["alpha"\]: upstream\.caFile: file not found:/);
    assert.match(errors[2]!, /^models\["beta"\]: upstream\.caFile: file not found:/);

    writeFileSync(path, JSON.stringify({ models: { auto: { budget: { window: 'auto' } } } }));
    const auto = await run(['config', 'show', '--config', path]);
    assert.match(auto.out, /# model auto \(auto \(fallback \d+\)\)/);
    assert.equal((await run(['config', 'show', '--json', '--model', 'auto', '--config', path])).code, 0);

    // Legacy CLI output remains a fixed contract when there is no models map.
    writeFileSync(path, '{}');
    const legacyShow = await run(['config', 'show', '--config', path]);
    assert.match(legacyShow.out, /^# kitzur \S+ effective config: default < file:/);
    assert.doesNotMatch(legacyShow.out, /# model |derivedByModel/);
    assert.equal((await run(['config', 'show', '--json', '--config', path])).out.includes('"derivedByModel"'), false);
    const legacyValidate = await run(['config', 'validate', '--config', path]);
    assert.match(legacyValidate.out, /^warning: upstream\.origin is not set: serve refuses to start without it\nwarning: tokenizer\.path is not set:/);
    assert.match(legacyValidate.out, /ok \(2 warning\(s\)\)\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
