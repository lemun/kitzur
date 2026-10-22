import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { loadConfig } from '../../src/config/load.js';
import { enableAutoWindow, modelWindow } from '../../src/config/window.js';
import { ModelRuntimeMap, type ModelRuntime } from '../../src/proxy/model-runtime.js';
import { Upstream, type UpstreamResponse } from '../../src/proxy/upstream.js';
import { freshLearnedEntry } from '../../src/proxy/state.js';
import { testConfig } from './harness.js';
import type { Engine } from '../../src/types.js';
import { declaredOutputCapWarning } from '../../src/proxy/server.js';

test('declared output cap warns when below either planning or client output limit', () => {
  assert.match(declaredOutputCapWarning('alpha', 1000, 2000, 3000)!, /you configured 2000 and 3000/);
  assert.match(declaredOutputCapWarning('alpha', 2500, 2000, 3000)!, /you configured 3000/);
  assert.equal(declaredOutputCapWarning('alpha', 3000, 2000, 2500), undefined);
});

function response(body: unknown, status = 200): UpstreamResponse {
  return {
    status, statusMessage: 'OK', rawHeaders: [], headers: {}, headerMs: 0, reused: false, retried: false,
    body: Readable.from([Buffer.from(JSON.stringify(body))]) as UpstreamResponse['body'],
  };
}

test('probe reads documented per-model limits and ignores invalid values', async () => {
  const upstream = new Upstream({ ...testConfig().upstream, origin: 'http://127.0.0.1:1' });
  upstream.request = async () => response({ data: [
    { id: 'alpha', max_model_len: 32768, max_input_tokens: 12000, max_output_tokens: 4000 },
    { id: 'beta', n_ctx: 65536, max_prompt_tokens: 24000, top_provider: { max_completion_tokens: 9000 } },
    { id: 'invalid', max_model_len: -1, max_input_tokens: 2.5, max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ] });
  try {
    const p = await upstream.probe();
    assert.deepEqual({ ...p.discovered_limits }, {
      alpha: { window: 32768, maxPrompt: 12000, maxOutput: 4000 },
      beta: { window: 65536, maxPrompt: 24000, maxOutput: 9000 },
    });
    assert.deepEqual(p.discovered_window, { alpha: 32768, beta: 65536 });
  } finally { upstream.close(); }
});

test('prompt caps are transient per model and windows only affect auto profiles', () => {
  const loaded = loadConfig({ env: {}, object: { budget: { window: 100000 }, models: {
    automatic: { budget: { window: 'auto' } }, fixed: { budget: { window: 50000 } },
  } } });
  const automatic = structuredClone(loaded.models.automatic!);
  const fixed = structuredClone(loaded.models.fixed!);
  enableAutoWindow(automatic, 100000);
  const runtime = (cfg: typeof loaded.config): ModelRuntime => ({ cfg, counter: {} as ModelRuntime['counter'], engine: {} as Engine });
  const map = new ModelRuntimeMap(runtime(loaded.config), loaded.models, new Map([
    ['automatic', runtime(automatic)], ['fixed', runtime(fixed)],
  ]));
  map.setDiscoveredLimits({ automatic: { window: 32768, maxPrompt: 12000 }, fixed: { window: 65536, maxPrompt: 24000 } });
  map.setDiscoveredWindows({ automatic: 32768, fixed: 65536 });
  const stored = freshLearnedEntry(100000, 'test');
  assert.equal(map.learnedFor('automatic', stored).maxPrompt, 12000);
  assert.equal(stored.maxPrompt, null, 'declaration is never persisted into learned state');
  assert.equal(map.learnedFor('fixed', stored).maxPrompt, 24000);
  assert.equal(modelWindow(automatic, 'automatic'), 32768);
  assert.equal(fixed.budget.window, 50000);
});

test('401 and 403 are reachable but do not yield model declarations', async () => {
  for (const status of [401, 403]) {
    const upstream = new Upstream({ ...testConfig().upstream, origin: 'http://127.0.0.1:1' });
    upstream.request = async () => response({}, status);
    try {
      const p = await upstream.probe();
      assert.equal(p.ok, true);
      assert.equal(p.status, status);
      assert.equal(p.discovered_limits, undefined);
    } finally { upstream.close(); }
  }
});
