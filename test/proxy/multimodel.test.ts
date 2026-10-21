import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/load.js';
import { ModelRuntimeMap, type ModelRuntime } from '../../src/proxy/model-runtime.js';
import { budgetQuantities } from '../../src/proxy/budget.js';
import type { Engine } from '../../src/types.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { StatsWriter } from '../../src/proxy/stats.js';
import { fakeUpstream, jsonRes, request, chatBody, okCompletion, sseRes, chunk, DONE } from './harness.js';
import { FakeEngine, result } from './fake-engine.js';
import { charCounter } from './harness.js';
import { StateStore } from '../../src/proxy/state.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('proxy pins each model runtime across A/B/A requests and an interleaved stream', async () => {
  let aStarted!: () => void;
  const started = new Promise<void>((resolve) => { aStarted = resolve; });
  const up = await fakeUpstream(async (hit, res) => {
    if ((hit.json as { model?: string }).model === 'alpha' && hit.json.stream) {
      aStarted();
      await sseRes(res, [chunk('first'), chunk('last', 'stop'), DONE], { delayMs: 25 });
    } else jsonRes(res, 200, okCompletion(1));
  });
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-multimodel-'));
  const loaded = loadConfig({ env: {}, object: { upstream: { origin: up.origin }, stateDir: dir, models: {
    alpha: { budget: { window: 12_000 } },
    beta: { budget: { window: 22_000, limitCountsMaxTokens: false }, server: { type: 'ollama' } },
  } } });
  const calls = { root: 0, alpha: 0, beta: 0 };
  const countCalls = { root: 0, alpha: 0, beta: 0 };
  const runtime = (name: keyof typeof calls, cfg: typeof loaded.config): ModelRuntime => {
    const counter = charCounter();
    const countRequest = counter.countRequest.bind(counter);
    counter.countRequest = (req) => { countCalls[name]++; return countRequest(req); };
    const engine = new FakeEngine((req) => { calls[name]++; return result(req, req, false); });
    return { cfg, counter: counter as unknown as ModelRuntime['counter'], engine };
  };
  const root = runtime('root', loaded.config);
  const alpha = runtime('alpha', loaded.models.alpha!);
  const beta = runtime('beta', loaded.models.beta!);
  const runtimes = new ModelRuntimeMap(root, loaded.models, new Map([['alpha', alpha], ['beta', beta]]));
  const state = new StateStore({ dir, configuredWindow: loaded.config.budget.window, counterId: 'test' });
  const logs: string[] = [];
  const proxy = createProxyServer(loaded.config, { engine: root.engine, counter: root.counter, modelRuntimes: runtimes, state, stats: new StatsWriter(null), log: (_level, message) => logs.push(message) });
  const { port } = await proxy.listen();
  try {
    const a1 = await request(port, { body: chatBody('a1', { model: 'alpha' }) });
    const b = await request(port, { body: chatBody('b', { model: 'beta' }) });
    const a2 = await request(port, { body: chatBody('a2', { model: 'alpha' }) });
    assert.equal(a1.headers['x-kitzur-tokens'], a2.headers['x-kitzur-tokens']);
    assert.notEqual(a1.headers['x-kitzur-tokens'], b.headers['x-kitzur-tokens']);
    assert.equal(String(a1.headers['x-kitzur-tokens']).split('/')[2], String(budgetQuantities(alpha.cfg, null).trigger));
    assert.equal(String(b.headers['x-kitzur-tokens']).split('/')[2], String(budgetQuantities(beta.cfg, null).trigger));
    assert.deepEqual(calls, { root: 0, alpha: 2, beta: 1 });
    assert.ok(countCalls.alpha >= 2 && countCalls.beta >= 2, 'selected counter is used during processing and afterChat');
    assert.ok(logs.some((message) => message.includes('server truncates: window smaller than configured')), 'afterChat uses beta silent_truncate config');

    const streaming = request(port, { body: chatBody('stream', { model: 'alpha', stream: true }) });
    await started;
    const alphaCountWhileStreaming = countCalls.alpha;
    await request(port, { body: chatBody('during', { model: 'beta' }) });
    assert.equal(countCalls.alpha, alphaCountWhileStreaming, 'beta processing does not run alpha afterChat while its stream is in flight');
    await streaming;
    assert.deepEqual(calls, { root: 0, alpha: 3, beta: 2 });
    assert.ok(countCalls.alpha > alphaCountWhileStreaming, 'alpha afterChat resumes with alpha counter after its own stream ends');
    assert.ok(countCalls.alpha >= 3 && countCalls.beta >= 3, 'each selected counter runs in processing and afterChat');
  } finally {
    await proxy.close(2000);
    await up.close();
  }
});

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
