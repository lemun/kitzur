import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, buildEngine, createLogger, setupCounter, type AppModules } from '../../src/app.js';
import { loadConfig } from '../../src/config/load.js';
import { stateDirOf } from '../../src/config/paths.js';
import type { Engine, LearnedEntry, PlanStore } from '../../src/types.js';
import { testTokenizerPath } from '../helpers.js';

const cfgOf = (...sets: string[]) => loadConfig({ env: {}, sets }).config;

test('setupCounter: estimate without a tokenizer, exact with one, estimate with the reason when it fails to load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-app-'));
  try {
    const none = setupCounter(cfgOf());
    assert.equal(none.counter.mode, 'estimate');
    assert.equal(none.estimateReason, 'tokenizer.path is not set');
    const forced = setupCounter(cfgOf('tokenizer.mode=estimate', `tokenizer.path=${testTokenizerPath() ?? '/x'}`));
    assert.equal(forced.counter.mode, 'estimate');
    assert.match(forced.estimateReason!, /'estimate'/);
    writeFileSync(join(dir, 'bad.json'), '{"model": {"type": "WordPiece"}}');
    const logs: string[] = [];
    const bad = setupCounter(cfgOf(`tokenizer.path=${join(dir, 'bad.json')}`), { log: createLogger('debug', (s) => void logs.push(s)) });
    assert.equal(bad.counter.mode, 'estimate');
    assert.match(bad.estimateReason!, /failed to load/);
    assert.match(logs.join(''), /warn: counting with the per-class estimate/);
    const tp = testTokenizerPath();
    if (tp) {
      const ex = setupCounter(cfgOf(`tokenizer.path=${tp}`), { stateDir: dir });
      assert.equal(ex.counter.mode, 'exact');
      assert.equal(ex.estimateReason, null);
      assert.ok(ex.tokenizer?.sha256 && ex.counter.id.includes(ex.tokenizer.sha256));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildApp: the engine gets a local counter; the tokenize endpoint only reaches the proxy ()', async () => {
  const seen: Record<string, unknown> = {};
  const engine = { process: () => { throw new Error('unused'); }, learned: () => ({}) as LearnedEntry, setLearned: () => undefined } as Engine;
  const modules: AppModules = {
    createEngine: (_c, deps) => {
      seen['engineDeps'] = deps;
      return engine;
    },
    createSummarizer: (_c, counter) => {
      seen['summaryCounter'] = counter;
      return { render: () => { throw new Error('unused'); } };
    },
    createToolRules: () => ({}) as ReturnType<AppModules['createToolRules']>,
    createStore: (c, dir) => {
      seen['storeDir'] = dir;
      seen['storeCaps'] = [c.store.maxPlans, c.store.maxBytes];
      return { get: () => undefined, set: () => undefined, size: () => 0 } as PlanStore;
    },
    createState: (_c, dir, counterId) => {
      seen['state'] = [dir, counterId];
      return { entries: () => ({}) } as unknown as ReturnType<AppModules['createState']>;
    },
    createStats: (c) => {
      seen['stats'] = c.stats.path;
      return {} as ReturnType<AppModules['createStats']>;
    },
    createProxyServer: (_c, deps) => {
      seen['proxyDeps'] = deps;
      return { listen: async () => ({ host: '127.0.0.1', port: 1 }), close: async () => undefined } as unknown as ReturnType<AppModules['createProxyServer']>;
    },
  };
  const cfg = cfgOf('upstream.origin=http://127.0.0.1:9', 'tokenizer.endpoint.style=vllm', 'stateDir=/tmp/kitzur-app-state', 'stats.path=/tmp/x.jsonl');
  const logs: string[] = [];
  const app = await buildApp(cfg, { modules, log: createLogger('debug', (s) => void logs.push(s)) });
  const ed = seen['engineDeps'] as { counter: { mode: string }; store: unknown; summarizer: unknown; rules: unknown; tokenizerSha256: unknown };
  assert.equal(ed.counter.mode, 'estimate', 'never remote');
  assert.equal(ed.tokenizerSha256, null);
  assert.equal(seen['summaryCounter'], ed.counter, 'the summarizer counts with the engine counter');
  const pd = seen['proxyDeps'] as { engine: unknown; counter: unknown; remote: { style: string } | null; state: unknown; stats: unknown; log: (l: string, m: string) => void };
  assert.equal(pd.engine, engine);
  assert.equal(pd.counter, ed.counter);
  assert.equal(pd.remote?.style, 'vllm', 'the tokenize client is a calibration source for the proxy');
  assert.deepEqual(seen['state'], ['/tmp/kitzur-app-state', (ed.counter as unknown as { id: string }).id], 'learned entries are keyed to the counter id ()');
  assert.equal(seen['stats'], '/tmp/x.jsonl');
  assert.deepEqual(seen['storeCaps'], [4096, 64 * 1024 * 1024]);
  pd.log('warn', 'hello');
  assert.ok(logs.includes('kitzur: warn: hello\n'));
  assert.deepEqual(await app.listen(), { host: '127.0.0.1', port: 1 });
  assert.deepEqual(await app.probe(), { ok: true }, 'no probe on the server: nothing to check');
  app.remote?.close();
});

test('buildEngine: the real engine modules load and process a request', async () => {
  const setup = await buildEngine(cfgOf('stateDir=/tmp/kitzur-app-state'));
  assert.equal(setup.counter.mode, 'estimate');
  const r = setup.engine.process({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] }, { attempt: 1 });
  assert.equal(r.action, 'passthrough');
  assert.equal(r.changed, false);
});

test('stateDirOf: config, XDG_STATE_HOME (absolute only), ~/.local/state', () => {
  assert.equal(stateDirOf({ stateDir: '/s' }, { XDG_STATE_HOME: '/x' }), '/s');
  assert.equal(stateDirOf({ stateDir: null }, { XDG_STATE_HOME: '/x' }, '/h'), '/x/kitzur');
  assert.equal(stateDirOf({ stateDir: null }, { XDG_STATE_HOME: 'rel' }, '/h'), '/h/.local/state/kitzur');
  assert.equal(stateDirOf({ stateDir: null }, {}, '/h'), '/h/.local/state/kitzur');
});
