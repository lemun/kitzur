import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';

function withFile<T>(layer: unknown, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-retry-'));
  try {
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify(layer));
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upstream.retry defaults: off, 3 attempts, 500 ms base, 8 s cap, 20 s total, Retry-After and jitter on', () => {
  assert.deepEqual(DEFAULT_CONFIG.upstream.retry, {
    enabled: false, maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000, maxTotalDelayMs: 20_000, honorRetryAfter: true, jitter: true,
  });
  assert.deepEqual(loadConfig({ env: {} }).config.upstream.retry, DEFAULT_CONFIG.upstream.retry);
});

test('upstream.retry: every leaf loads from a file, and --set parses like other leaves', () => {
  const retry = { enabled: true, maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 1000, maxTotalDelayMs: 5000, honorRetryAfter: false, jitter: false };
  withFile({ upstream: { retry } }, (file) => {
    const r = loadConfig({ configPath: file, env: {} });
    assert.deepEqual(r.config.upstream.retry, retry);
    assert.equal(r.provenance['upstream.retry.maxDelayMs'], `file:${file}`);
  });
  const r = loadConfig({ env: {}, sets: ['upstream.retry.enabled=true', 'upstream.retry.maxAttempts=5'] });
  assert.equal(r.config.upstream.retry.enabled, true);
  assert.equal(r.config.upstream.retry.maxAttempts, 5);
  assert.equal(r.provenance['upstream.retry.maxAttempts'], 'cli:--set');
  // a base above the cap is allowed (every wait is then the cap)
  const c = loadConfig({ env: {}, sets: ['upstream.retry.baseDelayMs=9000', 'upstream.retry.maxDelayMs=100'] }).config;
  assert.equal(c.upstream.retry.baseDelayMs, 9000);
});

test('upstream.retry: out-of-range or mistyped values are rejected naming the full key', () => {
  const errorsFor = (set: string): string[] => {
    const l = loadConfig({ env: {}, sets: [set] });
    return validateConfig(l.config, { provenance: l.provenance }).errors;
  };
  assert.deepEqual(errorsFor('upstream.retry.maxAttempts=3'), []);
  assert.match(errorsFor('upstream.retry.maxAttempts=0').join('\n'), /upstream\.retry\.maxAttempts/);
  assert.match(errorsFor('upstream.retry.maxAttempts=11').join('\n'), /upstream\.retry\.maxAttempts/);
  assert.match(errorsFor('upstream.retry.baseDelayMs=-1').join('\n'), /upstream\.retry\.baseDelayMs/);
  assert.throws(() => loadConfig({ env: {}, sets: ['upstream.retry.enabled=maybe'] }), /upstream\.retry\.enabled: expected true or false/);
  withFile({ upstream: { retry: { enabled: 'yes' } } }, (file) => {
    const l = loadConfig({ configPath: file, env: {} });
    assert.match(validateConfig(l.config, { provenance: l.provenance }).errors.join('\n'), /upstream\.retry\.enabled/);
  });
});

test('upstream.retry: a misspelled leaf gets a did-you-mean hint', () => {
  assert.throws(() => loadConfig({ env: {}, sets: ['upstream.retry.maxAttempt=4'] }),
    /unknown config key upstream\.retry\.maxAttempt \(did you mean upstream\.retry\.maxAttempts\?\)/);
  withFile({ upstream: { retry: { maxAttempt: 4 } } }, (file) => {
    assert.throws(() => loadConfig({ configPath: file, env: {} }), /did you mean upstream\.retry\.maxAttempts\?/);
  });
});

test('upstream.retry: the effective config JSON lists the section with a source per leaf', () => {
  const r = loadConfig({ env: {} });
  const json = JSON.parse(JSON.stringify(r.config)) as { upstream: { retry: Record<string, unknown> } };
  const leaves = ['enabled', 'maxAttempts', 'baseDelayMs', 'maxDelayMs', 'maxTotalDelayMs', 'honorRetryAfter', 'jitter'];
  assert.deepEqual(Object.keys(json.upstream.retry), leaves);
  for (const leaf of leaves) assert.equal(r.provenance[`upstream.retry.${leaf}`], 'default');
});
