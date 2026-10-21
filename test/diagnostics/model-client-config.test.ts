import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/config/load.js';
import { buildModelProfiles } from '../../src/config/models.js';
import { clientConfigChecks } from '../../src/diagnostics/client-config.js';

test('checks each wire model against its profile and qualifies messages', () => {
  const cfg = defaultConfig();
  cfg.listen.port = 8787;
  cfg.client.outputTokenMax = 131_071;
  const issues: string[] = [];
  const profiles = buildModelProfiles(cfg, new Map([
    ['qwen', new Map([['budget.window', 252_000]])],
    ['gpt-oss', new Map([['budget.window', 131_071]])],
  ]), issues, []);
  assert.deepEqual(issues, []);
  const input = { provider: { local: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:8787/v1' },
    models: { qwen: { limit: { context: 252_000, output: 8_000 } }, gpt: { id: 'gpt-oss', limit: { context: 131_071, output: 131_071 } } },
  } }, model: 'local/qwen', small_model: 'local/gpt' };
  const checks = clientConfigChecks(cfg, input, profiles);
  assert.ok(checks.some((c) => c.message.includes('gpt') && /no usable context/.test(c.message)));
  assert.ok(!checks.some((c) => c.code === 'client.profile'));
});

test('unknown wire model is reported while its own client limits are checked', () => {
  const cfg = defaultConfig(); cfg.listen.port = 8787;
  const checks = clientConfigChecks(cfg, { provider: { local: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:8787/v1' },
    models: { unknown: { limit: { context: 100_000, output: 32_000 } } },
  } } }, { known: cfg });
  assert.ok(checks.some((c) => c.code === 'client.profile' && c.message.includes('unknown')));
});
