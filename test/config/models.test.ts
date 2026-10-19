import { main } from '../../src/cli.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { resolveModelConfig } from '../../src/config/models.js';
import { isAutoWindow, modelWindow, setDiscoveredWindows } from '../../src/config/window.js';
import { configPlanHash } from '../../src/engine/learned.js';

const load = (models: unknown, sets: string[] = []) => loadConfig({ object: { models }, env: {}, sets });

test('exact dotted/slashed/case-sensitive IDs resolve over the final root and freeze deeply', () => {
  const l = load({ 'org/model.v1': { budget: { window: 131071 } }, 'Org/model.v1': {}, small: { tokenizer: { mode: 'estimate', template: { name: 'generic' } } } }, ['budget.window=200000']);
  assert.equal(l.models['org/model.v1']!.budget.window, 131071);
  assert.equal(l.models['Org/model.v1']!.budget.window, 200000);
  assert.equal(resolveModelConfig(l.config, l.models, 'small').tokenizer.mode, 'estimate');
  assert.equal(resolveModelConfig(l.config, l.models, 'unknown'), l.config);
  assert.equal(resolveModelConfig(l.config, l.models), l.config);
  assert.throws(() => { l.models['org/model.v1']!.client.inputLimit = 1; }, TypeError);
  assert.ok(Object.isFrozen(l.models));
  assert.equal(Object.hasOwn(l.config, 'models'), false);
  assert.equal(Object.hasOwn(l.models['org/model.v1']!, 'models'), false);
});

test('absent/empty maps preserve root identity and equal overrides preserve plan hash', () => {
  for (const l of [loadConfig({ env: {} }), load({})]) {
    assert.equal(resolveModelConfig(l.config, l.models, 'anything'), l.config);
  }
  const l = load({ equal: { budget: { window: 100000 } } });
  assert.equal(configPlanHash(l.models['equal']!, 'counter', false), configPlanHash(l.config, 'counter', false));
});

test('auto is re-registered for inherited and explicit profiles; discoveries stay isolated', () => {
  const l = load({ inherit: {}, fixed: { budget: { window: 128000 } } }, ['budget.window=auto']);
  assert.ok(isAutoWindow(l.config));
  assert.ok(isAutoWindow(l.models['inherit']!));
  assert.equal(isAutoWindow(l.models['fixed']!), false);
  setDiscoveredWindows(l.models['inherit']!, { inherit: 64000 });
  assert.equal(modelWindow(l.models['inherit']!, 'inherit'), 64000);
  assert.equal(modelWindow(l.config, 'inherit'), l.config.budget.window);
  const explicit = load({ auto: { budget: { window: 'auto' }, client: { inputLimit: 64000 } } }, ['budget.window=128000']);
  assert.ok(isAutoWindow(explicit.models['auto']!));
  assert.equal(explicit.models['auto']!.budget.window, 128000);
  assert.ok(explicit.warnings.some((w) => /auto fallback.*client limit/.test(w)));
});

test('preset/file profiles merge by exact ID and leaf; null clears an inherited nullable leaf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-models-'));
  try {
    const preset = join(dir, 'preset.json');
    writeFileSync(preset, JSON.stringify({ client: { inputLimit: 90000 }, models: { a: { budget: { window: 128000 }, client: { outputLimit: 12000 } } } }));
    const l = loadConfig({ preset, env: {}, object: { models: { a: { client: { inputLimit: null } } } } });
    assert.equal(l.models['a']!.budget.window, 128000);
    assert.equal(l.models['a']!.client.outputLimit, 12000);
    assert.equal(l.models['a']!.client.inputLimit, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reject invalid maps, IDs, leaves, types, ranges, arrays and prototype paths with model context', () => {
  for (const models of [null, [], 1]) assert.throws(() => load(models), /models must be an object/);
  for (const id of ['', ' ', 'x'.repeat(257), 'x\n', '\u0085', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() => load(JSON.parse(`{${JSON.stringify(id)}:{}}`)), /invalid model ID/);
  }
  for (const override of [null, [], { preset: '32k' }, { upstream: { origin: 'http://localhost' } },
    { client: { summaryMarkers: [] } }, { budget: { observedFixedPromptTokens: 1 } },
    { budget: { window: 1 } }, { client: { inputLimit: '1' } }, { tokenizer: { path: 'other' } },
    { tokenizer: { template: { name: 'harmony' } } }, { 'budget.window': 128000 },
    JSON.parse('{"budget":{"__proto__":{}}}'), { budget: { maxTokensClamp: [] } }]) {
    assert.throws(() => load({ bad: override }), /models\["bad"\]/);
  }
  assert.throws(() => load({ bad: { client: { inputLimit: 100, reservedTokens: 1000 } } }), /models\["bad"\]/);
});

test('fallback warning is bounded independently of unknown client-controlled IDs', () => {
  const l = load({ known: {} });
  const warnings: string[] = [];
  for (let i = 0; i < 100; i++) assert.equal(resolveModelConfig(l.config, l.models, `unknown-${i}`, (w) => warnings.push(w)), l.config);
  resolveModelConfig(l.config, l.models, undefined, (w) => warnings.push(w));
  assert.equal(warnings.length, 1);
  const legacy = load({});
  resolveModelConfig(legacy.config, legacy.models, 'unknown', (w) => warnings.push(w));
  assert.equal(warnings.length, 1);
});


test('legacy config show and show --json are byte-identical with absent versus empty model maps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-legacy-'));
  const file = join(dir, 'config.json');
  try {
    const show = async (json: boolean): Promise<string> => {
      let out = '';
      const code = await main(['config', 'show', '--config', file, ...(json ? ['--json'] : [])], {
        stdout: (s) => { out += s; }, stderr: () => {}, env: {}, cwd: dir, onSignal: () => {},
      });
      assert.equal(code, 0);
      return out;
    };
    for (const object of [{}, { preset: '32k' }]) {
      writeFileSync(file, JSON.stringify(object));
      const text = await show(false), json = await show(true);
      writeFileSync(file, JSON.stringify({ ...object, models: {} }));
      assert.equal(await show(false), text);
      assert.equal(await show(true), json);
      assert.equal(Object.hasOwn(JSON.parse(json).config, 'models'), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
