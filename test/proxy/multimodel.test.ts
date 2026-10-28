import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/load.js';
import { ModelRuntimeMap, type ModelRuntime } from '../../src/proxy/model-runtime.js';
import type { Engine } from '../../src/types.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeUpstream, jsonRes, request, charCounter } from './harness.js';
import { passthroughEngine } from './fake-engine.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { StateStore } from '../../src/proxy/state.js';
import { StatsWriter } from '../../src/proxy/stats.js';
import { budgetQuantities } from '../../src/proxy/budget.js';

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
  for (const [model, selected] of [['alpha', alpha], ['beta', beta], ['alpha', alpha]] as const) {
    assert.equal(runtimes.forModel(model).cfg, selected.cfg);
    assert.equal(runtimes.forModel(model).engine, selected.engine);
    assert.equal(runtimes.forModel(model).counter, selected.counter);
  }
  assert.equal(budgetQuantities(runtimes.forModel().cfg, null).window, loaded.config.budget.window);
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

test('overlapping A/B/A requests keep model runtimes pinned through stream calibration', async (t) => {
  let releaseA!: () => void;
  let sawA!: () => void;
  const aSeen = new Promise<void>((resolve) => { sawA = resolve; });
  const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
  let upstream;
  try {
    upstream = await fakeUpstream(async (hit, res) => {
      if (hit.json.model === 'alpha' && hit.n === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        sawA();
        await aGate;
        res.end('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      jsonRes(res, 200, { id: 'ok', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('sandbox forbids listening on 127.0.0.1; runtime selection assertions remain covered in process');
      return;
    }
    throw error;
  }
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-multimodel-'));
  const statsPath = join(dir, 'stats.jsonl');
  const loaded = loadConfig({ env: {}, object: { server: { budgetMode: 'strict_total' }, models: {
    alpha: { server: { budgetMode: 'silent_truncate' } }, beta: { server: { budgetMode: 'strict_total' } },
  } } });
  const rootCounter = charCounter();
  const alphaCounter = charCounter('exact');
  const betaCounter = charCounter();
  const rootEngine = passthroughEngine();
  const alphaEngine = passthroughEngine();
  const betaEngine = passthroughEngine();
  const root = { cfg: loaded.config, counter: rootCounter, engine: rootEngine } as unknown as ModelRuntime;
  const alpha = { cfg: loaded.models.alpha!, counter: alphaCounter, engine: alphaEngine } as unknown as ModelRuntime;
  const beta = { cfg: loaded.models.beta!, counter: betaCounter, engine: betaEngine } as unknown as ModelRuntime;
  const runtimes = new ModelRuntimeMap(root, loaded.models, new Map([['alpha', alpha], ['beta', beta]]));
  const cfg = { ...loaded.config, listen: { ...loaded.config.listen, port: 0 }, upstream: { ...loaded.config.upstream, origin: upstream.origin }, stateDir: dir, stats: { ...loaded.config.stats, path: statsPath } };
  const state = new StateStore({ dir, configuredWindow: cfg.budget.window, counterId: rootCounter.id });
  const stats = new StatsWriter(statsPath);
  const proxy = createProxyServer(cfg, { engine: root.engine, counter: rootCounter, modelRuntimes: runtimes, state, stats });
  try {
    let port: number;
    try { port = (await proxy.listen()).port; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('sandbox forbids listening on 127.0.0.1; runtime selection assertions remain covered in process');
        return;
      }
      throw error;
    }
    const a1 = request(port, { body: { model: 'alpha', stream: true, messages: [{ role: 'user', content: 'first alpha' }] } });
    await aSeen;
    await request(port, { body: { model: 'beta', messages: [{ role: 'user', content: 'beta' }] } });
    await request(port, { body: { model: 'alpha', messages: [{ role: 'user', content: 'second alpha' }] } });
    releaseA();
    await a1;
    assert.equal(alphaEngine.calls.length, 2);
    assert.equal(betaEngine.calls.length, 1);
    assert.ok(alphaCounter.calls > 0);
    assert.ok(betaCounter.calls > 0);
    assert.equal(rootCounter.calls, 0);
    const status = (await request(port, { method: 'GET', path: '/status' })).json();
    assert.ok(status.warnings.some((w: { code: string }) => w.code === 'silent_truncate'), 'alpha afterChat must use alpha silent_truncate config');
    const records = readFileSync(statsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((r: { profile?: string }) => r.profile), ['beta', 'alpha', 'alpha']);
  } finally {
    releaseA();
    await proxy.close().catch(() => undefined);
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
