import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/load.js';
import { ModelRuntimeMap, type ModelRuntime } from '../../src/proxy/model-runtime.js';
import type { Engine } from '../../src/types.js';

test('model runtime selection is exact, stable, and preserves runtimeFor compatibility', () => {
  const loaded = loadConfig({ env: {}, object: { models: { alpha: {}, beta: {} } } });
  const runtime = (cfg: typeof loaded.config): ModelRuntime => ({
    cfg,
    counter: {} as ModelRuntime['counter'],
    engine: {} as Engine,
  });
  const root = runtime(loaded.config);
  const alpha = runtime(loaded.models.alpha!);
  const beta = runtime(loaded.models.beta!);
  const runtimes = new ModelRuntimeMap(root, loaded.models, new Map([['alpha', alpha], ['beta', beta]]));

  assert.equal(runtimes.runtimeFor('missing'), root);
  assert.equal(runtimes.runtimeFor(), root);
  assert.equal(runtimes.runtimeFor('alpha'), alpha);
  assert.equal(runtimes.forModel('alpha'), alpha);
  assert.equal(runtimes.forModel('beta'), beta);
  assert.equal(runtimes.forModel('Alpha'), root);
});

test('unknown model warnings are bounded and emitted once per ID', () => {
  const loaded = loadConfig({ env: {}, object: { models: { alpha: {} } } });
  const root: ModelRuntime = { cfg: loaded.config, counter: {} as ModelRuntime['counter'], engine: {} as Engine };
  const alpha: ModelRuntime = { cfg: loaded.models.alpha!, counter: {} as ModelRuntime['counter'], engine: {} as Engine };
  const runtimes = new ModelRuntimeMap(root, loaded.models, new Map([['alpha', alpha]]));

  assert.equal(runtimes.shouldWarnUnknown('alpha'), false);
  assert.equal(runtimes.shouldWarnUnknown('missing'), true);
  assert.equal(runtimes.shouldWarnUnknown('missing'), false);
  for (let i = 0; i < 100; i++) runtimes.shouldWarnUnknown(`unknown-${i}`);
  assert.equal(runtimes.shouldWarnUnknown('another'), false);
});
