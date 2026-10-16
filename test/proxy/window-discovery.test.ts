import { test } from 'node:test';
import { buildEngine } from '../../src/app.js';
import { learnFromOverflow } from '../../src/proxy/recovery.js';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { Upstream, type UpstreamResponse } from '../../src/proxy/upstream.js';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { isAutoWindow, modelWindow } from '../../src/config/window.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { StateStore } from '../../src/proxy/state.js';
import { StatsWriter } from '../../src/proxy/stats.js';
import { computeBudget } from '../../src/engine/budget.js';
import { computeBudget as configBudget } from '../../src/config/derived.js';
import { defaultLearnedEntry } from '../../src/engine/learned.js';
import { FakeEngine, result } from './fake-engine.js';
import { fakeUpstream, jsonRes, charCounter, testConfig, okCompletion } from './harness.js';

const discoveryCases = [
  ['vLLM', { data: [{ id: 'small', max_model_len: 32768 }, { id: 'large', max_model_len: 131072 }] }, {}, { small: 32768, large: 131072 }],
  ['llama.cpp active props overrides training', { data: [{ id: 'local', meta: { n_ctx_train: 262144 } }] }, { default_generation_settings: { n_ctx: 40960 }, total_slots: 4 }, { local: 40960 }],
  ['llama.cpp metadata active context', { data: [{ id: 'local', meta: { n_ctx: 32768, n_ctx_train: 262144 } }] }, {}, { local: 32768 }],
  ['llama.cpp training metadata', { data: [{ id: 'local', meta: { n_ctx_train: 32768 } }] }, {}, { local: 32768 }],
  ['llama.cpp props only', {}, { model_path: 'local.gguf', n_ctx: 32768 }, { 'local.gguf': 32768 }],
  ['unknown shape', { models: [{ name: 'local', context_length: 32768 }], n_ctx: 99 }, {}, undefined],
  ['invalid numbers', { data: [null, {}, { id: 'a', max_model_len: '32768' }, { id: 'b', max_model_len: -1 }, { id: 'c', meta: { n_ctx: 2.5 } }] }, {}, undefined],
  ['ambiguous props', { data: [{ id: 'one' }, { id: 'two' }] }, { n_ctx: 32768 }, undefined],
] as const;

for (const [name, models, props, expected] of discoveryCases) {
  test(`probe discovers ${name} defensively`, async () => {
    const upstream = await fakeUpstream((hit, res) => jsonRes(res, 200, hit.url === '/props' ? props : models));
    const u = new Upstream({ ...testConfig().upstream, origin: upstream.origin });
    try {
      const p = await u.probe();
      assert.equal(p.ok, true);
      assert.deepEqual(p.discovered_window, expected);
      if (name === 'vLLM') assert.equal(upstream.hits.length, 1);
    } finally { u.close(); await upstream.close(); }
  });
}

test('malformed or unavailable metadata does not fail a reachable probe', async () => {
  const upstream = await fakeUpstream((hit, res) => jsonRes(res, hit.url === '/props' ? 404 : 200, '{bad json'));
  const u = new Upstream({ ...testConfig().upstream, origin: upstream.origin });
  try { assert.deepEqual(await u.probe(), { ok: true, status: 200 }); }
  finally { u.close(); await upstream.close(); }
});

for (const mode of ['auto', 100000] as const) {
  test(`proxy ${mode}: per-model status, warnings, planning and persistence`, async () => {
    const upstream = await fakeUpstream((hit, res) => jsonRes(res, 200, hit.url === '/v1/models'
      ? { data: [{ id: 'small', max_model_len: 32768 }, { id: 'large', max_model_len: 131072 }] }
      : okCompletion()));
    const cfg = loadConfig({ env: {}, object: { upstream: { origin: upstream.origin }, listen: { port: 0 }, budget: { window: mode, defaultMaxTokens: 4096 } } }).config;
    const counter = charCounter();
    const state = new StateStore({ dir: null, configuredWindow: cfg.budget.window, counterId: counter.id });
    const log: string[] = [];
    const engine = new FakeEngine((req, opts) => {
      assert.equal(opts.learned?.window, mode === 'auto' && req.model !== 'unknown' ? modelWindow(cfg, req.model) : null);
      return result(req, req, false);
    });
    const proxy = createProxyServer(cfg, { counter, state, engine, stats: new StatsWriter(null), log: (_level, message) => log.push(message) });
    try {
      const { port } = await proxy.listen();
      await proxy.probe();
      const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as Record<string, unknown>;
      assert.deepEqual(status.discovered_window, { small: 32768, large: 131072 });
      assert.equal((status.warnings as unknown[]).length, 2);
      assert.equal(log.filter((s) => s.includes('reports context window')).length, 2);
      for (const model of ['small', 'large', 'unknown']) {
        const expected = mode === 'auto' ? model === 'small' ? 32768 : model === 'large' ? 131072 : 100000 : 100000;
        const entry = defaultLearnedEntry(cfg, counter.id);
        assert.equal(computeBudget(cfg, entry, 0, 4096, model).window, expected);
        assert.equal(configBudget(cfg, { model }).window, expected);
        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }) });
        assert.equal(response.status, 200);
        await response.text();
      }
      assert.equal(engine.calls.length, 3);
      assert.ok(Object.values(state.entries()).every((e) => e.window === null), 'discovery must not become persisted overflow learning');
      if (mode === 'auto') assert.ok((proxy.snapshot().warnings as Array<{ key: string }>).some((w) => w.key === 'window_auto_fallback'));
    } finally { await proxy.close(); await upstream.close(); }
  });
}

test('auto from object, environment and CLI retains the preset fallback', () => {
  for (const options of [{ object: { budget: { window: 'auto' } } }, { env: { KITZUR_WINDOW: 'auto' } }, { sets: ['budget.window=auto'] }]) {
    const cfg = loadConfig({ env: {}, preset: '32k', ...options }).config;
    assert.equal(isAutoWindow(cfg), true);
    assert.equal(modelWindow(cfg, 'missing'), 32000);
    assert.deepEqual(validateConfig(cfg).errors, []);
  }
  assert.throws(() => loadConfig({ env: {}, sets: ['budget.window=automatic'] }));
});

// Exercise the same probe body path without sockets for restricted environments.
function mockMetadata(models: unknown, props: unknown): Upstream {
  const upstream = new Upstream(testConfig({ upstream: { origin: 'http://127.0.0.1:1' } }).upstream);
  upstream.request = async (request): Promise<UpstreamResponse> => ({
    status: 200, statusMessage: 'OK', rawHeaders: [], headers: {}, headerMs: 0, reused: false, retried: false,
    body: Readable.from([Buffer.from(JSON.stringify(request.path === '/props' ? props : models))]) as IncomingMessage,
  });
  return upstream;
}

for (const [name, models, props, expected] of discoveryCases) {
  test(`offline probe: ${name}`, async () => {
    const upstream = mockMetadata(models, props);
    try { assert.deepEqual((await upstream.probe()).discovered_window, expected); }
    finally { upstream.close(); }
  });
}

for (const known of [true, false]) {
  test(`offline auto budget and status with ${known ? 'known' : 'unknown'} metadata`, async () => {
    const upstream = mockMetadata(known ? { data: [{ id: 'small', max_model_len: 32768 }, { id: 'large', max_model_len: 131072 }] } : {}, {});
    const cfg = loadConfig({ env: {}, object: { upstream: { origin: upstream.origin.origin }, budget: { window: 'auto', defaultMaxTokens: 4096 } } }).config;
    const counter = charCounter();
    const state = new StateStore({ dir: null, configuredWindow: cfg.budget.window, counterId: counter.id });
    const logs: string[] = [];
    const proxy = createProxyServer(cfg, { upstream, state, counter, engine: new FakeEngine((req) => result(req, req, false)), stats: new StatsWriter(null), log: (_level, msg) => logs.push(msg) });
    try {
      await proxy.probe();
      assert.deepEqual(proxy.snapshot().discovered_window, known ? { small: 32768, large: 131072 } : {});
      assert.equal((proxy.snapshot().config as { window_mode: string }).window_mode, 'auto');
      assert.equal((proxy.snapshot().warnings as unknown[]).length, known ? 2 : 1);
      assert.equal(logs.length, known ? 2 : 1);
      const entry = defaultLearnedEntry(cfg, counter.id);
      const real = await buildEngine(cfg);
      for (const model of ['small', 'large', 'unknown', 'constructor', '__proto__']) {
        const expected = known && model === 'small' ? 32768 : known && model === 'large' ? 131072 : 100000;
        assert.equal(computeBudget(cfg, entry, 0, 4096, model).window, expected);
        assert.equal(configBudget(cfg, { model }).window, expected);
        const planned = real.engine.process({ model, messages: [{ role: 'user', content: 'hi' }] }, { attempt: 1 });
        assert.equal(planned.stats.budget.window, expected);
      }
      assert.deepEqual(state.entries(), {});
    } finally { await proxy.close(); }
  });
}

test('offline overflow learning tightens both small and discovered large windows', () => {
  const cfg = loadConfig({ env: {} }).config;
  const fresh = defaultLearnedEntry(cfg, 'test');
  const classification = { kind: 'overflow_prompt' as const, status: 400, inStream: false, numbersInMessage: true, window: 32768, promptTokens: 40000 };
  const small = learnFromOverflow(fresh, classification, 40000, cfg, 'estimate', new Date());
  assert.equal(small.entry.window, 32768);
  const large = learnFromOverflow({ ...fresh, window: 131072 }, { ...classification, window: 110000, promptTokens: 120000 }, 120000, cfg, 'estimate', new Date());
  assert.equal(large.entry.window, 110000);
});
