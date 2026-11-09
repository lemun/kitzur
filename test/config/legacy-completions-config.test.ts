import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';

test('legacyCompletions defaults: counted and warned about', () => {
  assert.deepEqual(DEFAULT_CONFIG.legacyCompletions, { count: true, warn: true });
  const r = loadConfig({ env: {} });
  assert.deepEqual(r.config.legacyCompletions, { count: true, warn: true });
  assert.equal(r.provenance['legacyCompletions.count'], 'default');
  assert.equal(r.provenance['legacyCompletions.warn'], 'default');
});

test('legacyCompletions: both leaves load from --set and from a file', () => {
  const r = loadConfig({ env: {}, sets: ['legacyCompletions.count=false', 'legacyCompletions.warn=false'] });
  assert.deepEqual(r.config.legacyCompletions, { count: false, warn: false });
  assert.equal(r.provenance['legacyCompletions.count'], 'cli:--set');
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-legacy-'));
  try {
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ legacyCompletions: { warn: false } }));
    const l = loadConfig({ configPath: file, env: {} });
    assert.deepEqual(l.config.legacyCompletions, { count: true, warn: false });
    assert.equal(l.provenance['legacyCompletions.warn'], `file:${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacyCompletions: a value that is not a boolean is rejected naming the full key', () => {
  assert.throws(() => loadConfig({ env: {}, sets: ['legacyCompletions.count=maybe'] }), /legacyCompletions\.count: expected true or false/);
  assert.throws(() => loadConfig({ env: {}, sets: ['legacyCompletions.warn=maybe'] }), /legacyCompletions\.warn: expected true or false/);
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-legacy-'));
  try {
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ legacyCompletions: { count: 'yes', warn: 0 } }));
    const l = loadConfig({ configPath: file, env: {} });
    const errors = validateConfig(l.config, { provenance: l.provenance }).errors.join('\n');
    assert.match(errors, /legacyCompletions\.count/);
    assert.match(errors, /legacyCompletions\.warn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => loadConfig({ env: {}, sets: ['legacyCompletions.counts=false'] }), /did you mean legacyCompletions\.count\?/);
});
