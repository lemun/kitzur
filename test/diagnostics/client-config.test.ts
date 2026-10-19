import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultConfig } from '../../src/config/load.js';
import { clientConfigChecks } from '../../src/diagnostics/client-config.js';
import { parseJsonc } from '../../src/config/jsonc.js';

for (const [fixture, code] of [
  ['valid', 'compatible'], ['context', 'context'], ['npm', 'npm'], ['output', 'output'],
  ['base-url', 'base_url'], ['usable', 'usable'], ['input', 'usable'],
]) {
  test(`OpenCode fixture: ${fixture}`, () => {
    const cfg = defaultConfig();
    cfg.listen.port = 8787;
    const input = parseJsonc(readFileSync(`test/fixtures/client-config/${fixture}.opencode.json`, 'utf8'));
    const checks = clientConfigChecks(cfg, input);
    assert.ok(checks.some((c) => c.code === 'client.' + code), JSON.stringify(checks));
    assert.equal(checks.every((c) => c.status === 'ok'), fixture === 'valid');
  });
}

test('client configuration diagnostics do not echo credentials', () => {
  const checks = clientConfigChecks(defaultConfig(), { provider: { secret: { options: { baseURL: 'http://SECRET@localhost:1' } } } });
  assert.doesNotMatch(JSON.stringify(checks), /SECRET/);
});

for (const scenario of [
  { name: '100000/66000/32000 defaults to 46000', input: 66_000, output: 32_000, point: 46_000 },
  { name: 'explicit reservation', input: 66_000, reserved: 10_000, point: 56_000 },
  { name: 'zero reservation', input: 66_000, reserved: 0, point: 66_000 },
  { name: 'small output reservation', input: 66_000, output: 8_000, point: 58_000 },
  { name: 'output cap bounds reservation', input: 66_000, cap: 12_000, point: 54_000 },
  { name: 'no-input fallback ignores reserved', reserved: 0, point: 68_000 },
  { name: 'zero-input fallback', input: 0, point: 68_000 },
  { name: 'no-input fallback uses output cap', output: 90_000, point: 68_000 },
  { name: 'no-input fallback uses small output', output: 8_000, point: 92_000 },
  { name: 'input reservation clamps at zero', input: 10_000, reserved: 20_000, point: 0 },
  { name: 'context fallback clamps at zero', context: 10_000, point: 0 },
]) {
  test(`OpenCode overflow threshold: ${scenario.name}`, () => {
    // Check both sides of the boundary, including a nonzero output allowance.
    for (const allowance of [0, 1_000]) {
      for (const delta of [-1, 0, 1]) {
        if (scenario.point - allowance + delta < 1) continue;
        const cfg = defaultConfig();
        cfg.budget.window = 200_000;
        cfg.client.compactionPointTokens = 200_000;
        cfg.client.outputAllowanceTokens = allowance;
        cfg.client.outputTokenMax = scenario.cap ?? 32_000;
        cfg.compaction.triggerTokens = scenario.point - allowance + delta;
        const checks = clientConfigChecks(cfg, {
          compaction: { reserved: scenario.reserved },
          provider: { local: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `http://localhost:${cfg.listen.port}/v1` },
            models: { local: { limit: { context: scenario.context ?? 100_000, input: scenario.input, output: scenario.output ?? 32_000 } } },
          } },
        });
        const warning = checks.find((c) => c.code === 'client.usable');
        assert.equal(Boolean(warning), delta > 0, JSON.stringify({ scenario, allowance, delta, checks }));
        if (warning && scenario.input && scenario.reserved !== undefined) assert.match(warning.fix ?? '', new RegExp(`client.inputLimit: ${scenario.input}.*client.reservedTokens: ${scenario.reserved}`));
        if (warning && scenario.output === 8_000) assert.match(warning.fix ?? '', /client.outputLimit: 8000/);
        if (warning) assert.match(warning.message, new RegExp(`OpenCode compacts at ${scenario.point}, Kitzur triggers at ${cfg.compaction.triggerTokens}`));
      }
    }

  });
}

for (const [name, compaction, context] of [
  ['disabled auto', { auto: false }, 100_000],
  ['zero context', {}, 0],
] as const) {
  test(`OpenCode skips overflow comparison: ${name}`, () => {
    const cfg = defaultConfig();
    const checks = clientConfigChecks(cfg, { compaction, provider: { local: {
      npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://localhost:${cfg.listen.port}/v1` },
      models: { local: { limit: { context, input: 1, output: 32_000 } } },
    } } });
    assert.equal(checks.some((c) => c.code === 'client.usable'), false);
    assert.deepEqual(checks.map((c) => c.code), ['client.compatible']);
  });
}

test('shipped Windows 100k client has no warnings', () => {
  const cfg = defaultConfig(); cfg.listen.port = 8270;
  const input = parseJsonc(readFileSync('test/fixtures/client-config/default-100k.opencode.json', 'utf8'));
  assert.deepEqual(input, JSON.parse(readFileSync('deploy/windows/opencode.template.json', 'utf8')));
  assert.ok(clientConfigChecks(cfg, input).every((c) => c.status === 'ok'));
});

test('usable fix overrides an existing client output limit even when output matches the plan', () => {
  const cfg = defaultConfig(); cfg.listen.port = 8270;
  cfg.client.outputLimit = 8_000;
  const input = parseJsonc(readFileSync('test/fixtures/client-config/default-100k.opencode.json', 'utf8'));
  const warning = clientConfigChecks(cfg, input).find((c) => c.code === 'client.usable');
  assert.ok(warning);
  const outputLimit = /client.outputLimit: (\d+)/.exec(warning.fix ?? '');
  assert.ok(outputLimit, warning.fix);
  cfg.client.outputLimit = Number(outputLimit[1]);
  assert.ok(clientConfigChecks(cfg, input).every((c) => c.status === 'ok'));
});
