import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { loadConfig } from '../../src/config/load.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';

const dir = join(ROOT, 'examples/config');
const load = (f: string) => loadConfig({ configPath: join(dir, f), env: {} });

test('flaky-gateway-retry: retry is on with the values written in the example', () => {
  const r = load('flaky-gateway-retry.jsonc').config.upstream.retry;
  assert.deepEqual(r, {
    enabled: true,
    maxAttempts: 4,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    maxTotalDelayMs: 30000,
    honorRetryAfter: true,
    jitter: true,
  });
  assert.ok(r.maxTotalDelayMs >= r.maxDelayMs);
  assert.equal(DEFAULT_CONFIG.upstream.retry.enabled, false);
});

test('flaky-gateway-retry: only the origin, server type, preset budget and retry differ from the defaults', () => {
  const c = load('flaky-gateway-retry.jsonc').config;
  const strip = (x: typeof c) => ({
    ...x,
    upstream: { ...x.upstream, origin: '', retry: null },
    server: { ...x.server, type: null },
    budget: { ...x.budget, window: 0, defaultMaxTokens: 0 },
  });
  assert.deepEqual(strip(c), strip(DEFAULT_CONFIG));
  assert.equal(c.upstream.origin, 'https://llm.example.com');
  assert.equal(c.server.type, 'vllm');
  assert.equal(c.budget.window, 32000);
  assert.equal(c.budget.defaultMaxTokens, 8000);
  assert.notDeepEqual(c.upstream.retry, DEFAULT_CONFIG.upstream.retry);
});
