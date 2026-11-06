import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { createSnapshot, maskSnapshotString } from '../../src/diagnostics/snapshot.js';
import type { DoctorResult } from '../../src/diagnostics/doctor.js';
import { main, type CliIO } from '../../src/cli.js';

const facts = { version: '0.2.1', node: 'v22', platform: 'linux', arch: 'x64', home: '/Users/user', upstreamHost: 'gateway.example.com', tokenizerConfigured: false, tokenizerLoads: false };
const config = defaultConfig();
const checks: DoctorResult = { exitCode: 0, checks: [{ code: 'paths', status: 'warn', message: 'https://gateway.example.com and /Users/user/cache C:\\Users\\user\\data', fix: 'check upstream.headers' }] };

test('snapshot masks hosts and home paths in every diagnostic string and is deterministic', () => {
  config.upstream.origin = 'https://gateway.example.com';
  config.upstream.headers = { Authorization: 'CANARY_AUTH_TOKEN', 'x-probe': 'CANARY_PROBE_TOKEN' };
  const a = JSON.stringify(createSnapshot(checks, config, {}, facts));
  assert.equal(a, JSON.stringify(createSnapshot(checks, config, {}, facts)));
  assert.doesNotMatch(a, /CANARY|gateway\.example\.com|\/Users\/user|C:\\\\Users\\\\user/);
  assert.match(a, /<home>/);
  assert.match(maskSnapshotString('https://other.example/x C:\\Users\\user\\x', facts), /host-[a-f0-9]{6}.*<home>/);
  assert.match(maskSnapshotString('https://[fd00::1]:8443/a', facts), /https:\/\/host-[a-f0-9]{6}:8443/);
  assert.match(maskSnapshotString('C:\\Users\\user\\secret', facts), /^<home>\\secret$/);
});

test('doctor snapshot never includes KITZUR_PROBE_TOKEN from the environment', async () => {
  let output = '';
  const io: CliIO = { stdout: (s) => { output += s; }, stderr: () => {}, env: { KITZUR_PROBE_TOKEN: 'CANARY_ENV_PROBE_TOKEN' }, cwd: process.cwd(), onSignal: () => {} };
  assert.equal(await main(['doctor', '--snapshot', '-'], io), 0);
  assert.doesNotMatch(output, /CANARY_ENV_PROBE_TOKEN/);
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
