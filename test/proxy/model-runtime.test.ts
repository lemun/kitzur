import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/load.js';
import { modelWindow } from '../../src/config/window.js';
import { ModelRuntimeMap, type ModelRuntime } from '../../src/proxy/model-runtime.js';
import type { Engine, LearnedEntry } from '../../src/types.js';

test('model runtimes own learned state and discovered windows by exact model ID', () => {
  const loaded = loadConfig({ env: {}, object: { models: { alpha: { budget: { window: 'auto' } }, beta: { budget: { window: 'auto' } } } } });
  const rootLearned: string[] = [];
  const alphaLearned: string[] = [];
  const betaLearned: string[] = [];
  const runtime = (cfg: typeof loaded.config, learned: string[]): ModelRuntime => ({
    cfg,
    counter: {} as ModelRuntime['counter'],
    engine: { setLearned: (key: string) => learned.push(key) } as unknown as Engine,
  });
  const root = runtime(loaded.config, rootLearned);
  const alpha = runtime(loaded.models['alpha']!, alphaLearned);
  const beta = runtime(loaded.models['beta']!, betaLearned);
  const runtimes = new ModelRuntimeMap(root, loaded.models, new Map([['alpha', alpha], ['beta', beta]]));

  runtimes.setLearned('alpha', 'origin|alpha', {} as LearnedEntry);
  runtimes.setLearned('beta', 'origin|beta', {} as LearnedEntry);
  runtimes.setLearned('unknown', 'origin|unknown', {} as LearnedEntry);
  runtimes.setDiscoveredWindows({ alpha: 9000, beta: 7000, unknown: 8000 });

  assert.deepEqual(alphaLearned, ['origin|alpha']);
  assert.deepEqual(betaLearned, ['origin|beta']);
  assert.deepEqual(rootLearned, ['origin|unknown']);
  assert.equal(modelWindow(alpha.cfg, 'alpha'), 9000);
  assert.equal(modelWindow(beta.cfg, 'beta'), 7000);
  assert.equal(modelWindow(root.cfg, 'unknown'), loaded.config.budget.window);
  assert.equal(runtimes.forModel('Alpha'), root, 'IDs are matched exactly');
});
