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
