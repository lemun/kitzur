import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { doctor, renderDoctor } from '../../src/diagnostics/doctor.js';
import { StateStore, freshLearnedEntry } from '../../src/proxy/state.js';
import { main, type CliIO } from '../../src/cli.js';

async function withStateDir(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-doctor-state-'));
  try { await f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function stateFileRow(dir: string) {
  const cfg = defaultConfig();
  cfg.stateDir = dir;
  cfg.listen.port = 0;
  const result = await doctor(cfg, { env: {} });
  return { result, row: result.checks.find((c) => c.code === 'state.file') };
}

test('doctor reports a missing learned state file as ok', () =>
  withStateDir(async (dir) => {
    const { row } = await stateFileRow(dir);
    assert.deepEqual(row, { code: 'state.file', status: 'ok', message: 'No learned state file yet.' });
  }));

test('doctor reports a learned state file written by the proxy as readable', () =>
  withStateDir(async (dir) => {
    const store = new StateStore({ dir, configuredWindow: 1000, counterId: 'estimate' });
    store.set('https://llm.example.com|m', freshLearnedEntry(1000, 'estimate'));
    await store.close();
    const { row } = await stateFileRow(dir);
    assert.deepEqual(row, { code: 'state.file', status: 'ok', message: 'Learned state file is readable.' });
  }));

test('doctor warns about a damaged learned state file without quoting it', () =>
  withStateDir(async (dir) => {
    writeFileSync(join(dir, 'learned.json'), '{not json');
    const { result, row } = await stateFileRow(dir);
    assert.equal(row?.status, 'warn');
    assert.match(row?.message ?? '', /cannot be read; Kitzur ignores it and learns limits from scratch/);
    assert.equal(row?.fix, "Run 'kitzur state reset' to move it aside, or delete the file.");
    assert.doesNotMatch(row?.message ?? '', /not json|\{|JSON|position|Expected/);
    assert.ok(!row?.message.includes(dir));
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(renderDoctor(result), /\{not json/);
  }));

test('doctor handles a folder named learned.json without throwing', () =>
  withStateDir(async (dir) => {
    mkdirSync(join(dir, 'learned.json'));
    const { row } = await stateFileRow(dir);
    assert.equal(row?.status, 'warn');
    assert.ok(!row?.message.includes(dir));
  }));

test('doctor skips the state file check while the state directory does not exist', () =>
  withStateDir(async (dir) => {
    const { result, row } = await stateFileRow(join(dir, 'missing'));
    assert.equal(row, undefined);
    assert.ok(result.checks.some((c) => c.code === 'state.directory'));
  }));

test('doctor --json lists the state file check', () =>
  withStateDir(async (dir) => {
    writeFileSync(join(dir, 'kitzur.json'), JSON.stringify({ upstream: { origin: 'https://llm.example.com' }, listen: { port: 0 } }));
    writeFileSync(join(dir, 'learned.json'), '{not json');
    const out: string[] = [];
    const io: CliIO = { stdout: (s) => void out.push(s), stderr: () => undefined, env: {}, cwd: dir, onSignal: () => undefined };
    await main(['doctor', '--json', '--config', 'kitzur.json', '--state-dir', dir], io);
    const o = JSON.parse(out.join('')) as { checks: { code: string; status: string; message: string }[] };
    const row = o.checks.find((c) => c.code === 'state.file');
    assert.equal(row?.status, 'warn');
    assert.doesNotMatch(out.join(''), /\{not json/);
  }));
