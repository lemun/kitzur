import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultConfig } from '../../src/config/load.js';
import { buildModelProfiles } from '../../src/config/models.js';
import { computeBudget } from '../../src/config/derived.js';
import { computeBudget as computeEngineBudget } from '../../src/engine/budget.js';
import { defaultLearnedEntry } from '../../src/engine/learned.js';
import { budgetQuantities } from '../../src/proxy/budget.js';
import { clientConfigChecks } from '../../src/diagnostics/client-config.js';

test('checks each wire model against its profile and qualifies messages', () => {
  const cfg = defaultConfig();
  cfg.listen.port = 8787;
  const issues: string[] = [];
  const profiles = buildModelProfiles(cfg, new Map([
    ['org/qwen.v1', new Map([['budget.window', 252_000], ['client.compactionPointTokens', 200_000]])],
    ['org/gpt-oss', new Map([['budget.window', 131_071], ['budget.planMaxTokens', 32_000]])],
  ]), issues, []);
  assert.deepEqual(issues, []);
  const input = JSON.parse(readFileSync('test/fixtures/client-config/multimodel.opencode.json', 'utf8'));
  const checks = clientConfigChecks(cfg, input, profiles);
  assert.deepEqual(checks.map((c) => c.code), ['client.compatible']);
  assert.ok(!checks.some((c) => c.code === 'client.profile'));
  assert.equal(computeBudget(profiles['org/qwen.v1']!).clientPoint, 200_000);
  assert.equal(computeBudget(profiles['org/qwen.v1']!).hard, 193_000);
  assert.equal(computeBudget(profiles['org/gpt-oss']!).planMaxTokens, 32_000);
  assert.equal(computeBudget(profiles['org/gpt-oss']!).hard, 92_071);
  for (const [id, clientPoint, hard] of [['org/qwen.v1', 200_000, 193_000], ['org/gpt-oss', 99_071, 92_071]] as const) {
    const profile = profiles[id]!;
    const derived = computeBudget(profile);
    const engine = computeEngineBudget(profile, defaultLearnedEntry(profile, 'test'), 0, profile.budget.defaultMaxTokens);
    const proxy = budgetQuantities(profile, defaultLearnedEntry(profile, 'test'));
    assert.deepEqual([derived.clientPoint, derived.hard, derived.planMaxTokens, engine.clientPoint, engine.hard, engine.planMaxTokens, proxy.clientPoint, proxy.hard, proxy.planMaxTokens],
      [clientPoint, hard, 32_000, clientPoint, hard, 32_000, clientPoint, hard, 32_000], id);
  }
});

test('routing accepts wire id and reports unresolved small_model safely', () => {
  const cfg = defaultConfig(); cfg.listen.port = 8787;
  const base = { provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:8787/v1' }, models: { alias: { id: 'wire/model', limit: { context: 100_000, output: 32_000 } } } } }, model: 'local/wire/model' };
  assert.ok(!clientConfigChecks(cfg, { ...base, small_model: 'local/wire/model' }).some((c) => c.code === 'client.routing'));
  const external = { ...base, provider: { ...base.provider, elsewhere: { ...base.provider.local, options: { baseURL: 'https://example.com/v1' }, models: { other: { id: 'wire/model' } } } }, small_model: 'elsewhere/other' };
  assert.ok(clientConfigChecks(cfg, external).some((c) => c.code === 'client.routing'));
  const warning = clientConfigChecks(cfg, { ...base, small_model: 'missing/\u001b[31msecret' }).find((c) => c.code === 'client.routing');
  assert.ok(warning);
  assert.ok(!warning.message.includes('\u001b'));
  assert.ok(warning.message.length < 200);
});

test('unknown wire model is reported while its own client limits are checked', () => {
  const cfg = defaultConfig(); cfg.listen.port = 8787;
  const checks = clientConfigChecks(cfg, { provider: { local: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:8787/v1' },
    models: { unknown: { limit: { context: 100_000, output: 32_000 } } },
  } } }, { known: cfg });
  assert.ok(checks.some((c) => c.code === 'client.profile' && c.message.includes('unknown')));
});
