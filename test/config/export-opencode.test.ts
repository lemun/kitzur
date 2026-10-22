import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/config/load.js';
import { buildModelProfiles } from '../../src/config/models.js';
import { exportOpenCode } from '../../src/config/export-opencode.js';
import { enableAutoWindow } from '../../src/config/window.js';

test('exports exact model IDs, numeric limits, symbolic key, and small model default', () => {
  const root = defaultConfig();
  const profiles = buildModelProfiles(root, new Map([
    ['org/qwen.v1', new Map([['budget.window', 252000]])],
    ['org/gpt-oss', new Map([['budget.window', 131071]])],
  ]), [], []);
  const value = JSON.parse(exportOpenCode(root, profiles, { model: 'org/qwen.v1' }));
  assert.equal(value.model, 'kitzur/org/qwen.v1');
  assert.equal(value.small_model, value.model);
  assert.equal(value.provider.kitzur.options.apiKey, '{env:OPENAI_API_KEY}');
  assert.deepEqual(value.provider.kitzur.models['org/gpt-oss'].limit, { context: 131071, output: 32000 });
});

test('uses explicit small model and rejects missing profile IDs', () => {
  const root = defaultConfig();
  const profiles = buildModelProfiles(root, new Map([['a', new Map()]]), [], []);
  const value = JSON.parse(exportOpenCode(root, profiles, { model: 'a', smallModel: 'a' }));
  assert.equal(value.small_model, 'kitzur/a');
  assert.throws(() => exportOpenCode(root, profiles, { model: 'missing' }), /no configured profile/);
});

test('auto profiles carry a labelled numeric fallback', () => {
  const root = defaultConfig();
  enableAutoWindow(root, 64000);
  const profiles = buildModelProfiles(root, new Map([['auto-model', new Map()]]), [], []);
  const value = JSON.parse(exportOpenCode(root, profiles, { model: 'auto-model' }));
  assert.equal(value.provider.kitzur.models['auto-model'].limit.context, 64000);
  assert.match(value.provider.kitzur.models['auto-model'].description, /fallback: 64000/);
});

test('exports the declared output cap for a non-default window', () => {
  const root = defaultConfig();
  const profiles = buildModelProfiles(root, new Map([['wide', new Map([['budget.window', 40000]])]]), [], []);
  const value = JSON.parse(exportOpenCode(root, profiles, { model: 'wide' }));
  assert.deepEqual(value.provider.kitzur.models.wide.limit, { context: 40000, output: 32000 });
});

test('rejects conflicting explicit output reservations across profiles', () => {
  const root = defaultConfig();
  const built = buildModelProfiles(root, new Map([['a', new Map()], ['b', new Map()]]), [], []);
  const profiles = Object.fromEntries(Object.entries(built).map(([id, cfg], index) => [id, {
    ...cfg, client: { ...cfg.client, reservedTokens: index === 0 ? 1000 : 2000 },
  }]));
  assert.throws(() => exportOpenCode(root, profiles, { model: 'a' }), /conflicting explicit output reservations/);
});
