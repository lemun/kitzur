import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/config/load.js';
import { doctor } from '../../src/diagnostics/doctor.js';
import { buildModelProfiles } from '../../src/config/models.js';
import { StatusTracker } from '../../src/proxy/status.js';
import { testConfig } from '../proxy/harness.js';

test('doctor checks selected profile budget and tokenizer/template pair offline', async () => {
  const root = defaultConfig();
  const profiles = buildModelProfiles(root, new Map([['alpha', new Map([['tokenizer.mode', 'estimate']])], ['beta', new Map()]]), [], []);
  const result = await doctor(root, { models: profiles, model: 'alpha' });
  assert.ok(result.checks.some((c) => c.code === 'model.alpha.budget'));
  assert.ok(result.checks.some((c) => c.code === 'model.alpha.tokenizer'));
  assert.ok(!result.checks.some((c) => c.code.startsWith('model.beta.')));
  assert.ok(!result.checks.some((c) => c.code === 'upstream.reachable'));
});

test('doctor warns when --model does not exactly match a configured profile', async () => {
  const result = await doctor(defaultConfig(), { models: {}, model: 'unknown' });
  assert.ok(result.checks.some((c) => c.code === 'model.unknown.profile' && c.status === 'warn'));
  assert.ok(!result.checks.some((c) => c.code.startsWith('model.') && c.code !== 'model.unknown.profile'));
});

test('status model counters cap named models and aggregate overflow under other', () => {
  const tracker = new StatusTracker(testConfig(), 'test');
  for (let i = 0; i < 66; i++) tracker.recordRequest({ action: 'passthrough', tokens: { in: 1, out: 1, trigger: null }, model: `m${i}`, ms: 1 });
  tracker.modelRetry('m0');
  const counts = tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} }).model_counters as Record<string, { actions: Record<string, number>; retries: number }>;
  assert.equal(Object.keys(counts).length, 65);
  assert.equal(counts.other!.actions.passthrough, 2);
  assert.equal(counts.m0!.retries, 1);
});
