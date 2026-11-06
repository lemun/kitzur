import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { createSnapshot, maskSnapshotString } from '../../src/diagnostics/snapshot.js';
import type { DoctorResult } from '../../src/diagnostics/doctor.js';
import { main, type CliIO } from '../../src/cli.js';

const facts = { version: '0.2.1', node: 'v22', platform: 'linux', arch: 'x64', home: '/Users/alice', upstreamHost: 'gateway.example.com', tokenizerConfigured: false, tokenizerLoads: false };
const config = defaultConfig();
const checks: DoctorResult = { exitCode: 0, checks: [{ code: 'paths', status: 'warn', message: 'https://gateway.example.com and /Users/alice/cache C:\\Users\\bob\\data', fix: 'check upstream.headers' }] };

test('snapshot masks hosts and home paths in every diagnostic string and is deterministic', () => {
  config.upstream.origin = 'https://gateway.example.com';
  config.upstream.headers = { Authorization: 'CANARY_AUTH_TOKEN', 'x-probe': 'CANARY_PROBE_TOKEN' };
  const a = JSON.stringify(createSnapshot(checks, config, {}, facts));
  assert.equal(a, JSON.stringify(createSnapshot(checks, config, {}, facts)));
  assert.doesNotMatch(a, /CANARY|gateway\.example\.com|\/Users\/alice|C:\\\\Users\\\\bob/);
  assert.match(a, /<home>/);
  assert.match(maskSnapshotString('https://other.example/x C:\\Users\\bob\\x', facts), /host-[a-f0-9]{6}.*<home>/);
});

test('doctor snapshot refuses overwrite unless --force is supplied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-snapshot-'));
  try {
    const file = join(dir, 'support.json');
    writeFileSync(file, 'keep me');
    const io: CliIO = { stdout: () => {}, stderr: () => {}, env: {}, cwd: dir, onSignal: () => {} };
    assert.equal(await main(['doctor', '--snapshot', file], io), 1);
    assert.equal(readFileSync(file, 'utf8'), 'keep me');
    assert.equal(await main(['doctor', '--snapshot', file, '--force'], io), 0);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /keep me/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
