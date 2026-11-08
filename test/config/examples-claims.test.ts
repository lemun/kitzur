import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { loadConfig } from '../../src/config/load.js';
import { computeBudget } from '../../src/config/derived.js';
import { resolveModelConfig } from '../../src/config/models.js';

const dir = join(ROOT, 'examples/config');
const load = (f: string) => loadConfig({ configPath: join(dir, f), env: {} });

test('single-model-32k: a 32000-token window with 8000 reserved for the reply', () => {
  const b = computeBudget(load('single-model-32k.jsonc').config);
  assert.equal(b.window, 32000);
  assert.equal(b.planMaxTokens, 8000);
});

test('ci-automation: a short plan, nothing persisted, a free port, fail closed, capture off', () => {
  const ci = load('ci-automation.jsonc').config;
  assert.equal(ci.budget.planMaxTokens, 4000);
  assert.equal(ci.store.persist, false);
  assert.equal(ci.listen.port, 0);
  assert.equal(ci.oversize.headPolicy, 'error');
  assert.equal(ci.debug.capture.path, null);
  assert.equal(ci.stateDir, join(dir, 'build/kitzur/state'));
  // more of the window is prompt: the budget grows by exactly the plan it no longer reserves
  const single = computeBudget(load('single-model-32k.jsonc').config);
  const b = computeBudget(ci);
  assert.equal(b.window, single.window);
  assert.equal(b.margin, single.margin);
  assert.equal(b.budget - single.budget, single.planMaxTokens - b.planMaxTokens);
});

test('multi-model-gateway: profiles inherit the root settings they do not override', () => {
  const l = load('multi-model-gateway.jsonc');
  const large = resolveModelConfig(l.config, l.models, 'org/large-model');
  const small = resolveModelConfig(l.config, l.models, 'org/small-model');
  for (const p of [large, small]) {
    assert.equal(p.upstream.origin, l.config.upstream.origin);
    assert.equal(p.server.type, 'vllm');
  }
  assert.equal(large.tokenizer.path, l.config.tokenizer.path);
  assert.equal(large.tokenizer.mode, l.config.tokenizer.mode);
  assert.equal(small.tokenizer.mode, 'estimate');
  assert.equal(small.tokenizer.template.name, 'generic');
  assert.equal(large.client.outputLimit, large.budget.defaultMaxTokens);
  assert.equal(small.client.outputLimit, small.budget.defaultMaxTokens);
  assert.equal(computeBudget(small).window, 32000);
});

test('windows-intranet: loopback only and capture off', () => {
  const c = load('windows-intranet.jsonc').config;
  assert.equal(c.listen.host, '127.0.0.1');
  assert.equal(c.debug.capture.path, null);
});
