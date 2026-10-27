import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { main, UsageError, type CliIO } from '../../src/cli.js';
import { cmdImportEval } from '../../src/cli/commands/import-eval.js';
import { ROOT } from '../helpers.js';

interface Bundle { sets: Record<string, Record<string, string>> }
const bundle = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'gateway-probes', 'fixtures.json.gz'))).toString('utf8')) as Bundle;

function extract(set: string, dir: string, edit: (files: Record<string, string>) => void = () => undefined): string {
  const d = join(dir, set);
  mkdirSync(d, { recursive: true });
  const files = { ...bundle.sets[set]! };
  edit(files);
  for (const [f, txt] of Object.entries(files)) writeFileSync(join(d, f), txt);
  return d;
}

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = argv[0] === 'config' ? await main(argv, io) : await cmdImportEval(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

async function withTmp(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-import-eval-'));
  try { await f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('cmdImportEval: a clean import exits 0 and writes the config and its sidecar', () =>
  withTmp(async (dir) => {
    const r = await run([extract('mock-vllm', dir), '--out', 'imp.json'], dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /wrote .*imp\.json and .*imp\.provenance\.json/);
    assert.equal((JSON.parse(readFileSync(join(dir, 'imp.json'), 'utf8')) as { budget: { window: number } }).budget.window, 100_000);
  }));

test('cmdImportEval: usage errors (exit 2 through main)', () =>
  withTmp(async (dir) => {
    await assert.rejects(run([], dir), (e: Error) => e instanceof UsageError && /needs gateway-probes result directories/.test(e.message));
    const none = await run(['config', 'import-eval'], dir);
    assert.equal(none.code, 2);
    assert.match(none.err, /import-eval needs gateway-probes result directories or files/);
    const port = await run(['config', 'import-eval', extract('mock-vllm', dir), '--port', 'x', '--dry-run'], dir);
    assert.equal(port.code, 2);
    assert.match(port.err, /--port must be a port number/);
  }));

test('cmdImportEval: a safety-critical knob falling back to a default exits 10', () =>
  withTmp(async (dir) => {
    const r = await run([extract('only-gateway502', dir), '--dry-run', '--json-report'], dir);
    assert.equal(r.code, 10, r.err);
    const rep = JSON.parse(r.out) as { exitCode: number; unsafe: string[]; out: string | null };
    assert.equal(rep.exitCode, 10);
    assert.ok(rep.unsafe.length > 0);
    assert.equal(rep.out, null, 'dry run');
  }));

test('cmdImportEval: conflicting measured windows exit 11', () =>
  withTmp(async (dir) => {
    const conflict = extract('mock-vllm', dir, (files) => {
      delete files['probe.out']; // the same probe_gateway result as a RESULT block
      const probe = JSON.parse(files['probe_gateway.json']!) as { tests: Record<string, unknown> };
      probe.tests['models'] = { status: 200, ids: ['qwen-test'], max_model_len: [98304], owned_by: ['vllm'], error: null };
      files['probe_gateway.json'] = JSON.stringify(probe, null, 1) + '\n';
    });
    const r = await run([conflict, '--dry-run', '--json-report'], dir);
    assert.equal(r.code, 11, r.err);
    const rep = JSON.parse(r.out) as { exitCode: number; conflicts: string[] };
    assert.equal(rep.exitCode, 11);
    assert.match(rep.conflicts[0]!, /measured windows differ/);
  }));
