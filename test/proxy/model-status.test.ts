import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusTracker } from '../../src/proxy/status.js';
import { buildStatsRecord, StatsWriter } from '../../src/proxy/stats.js';
import { charCounter, fakeUpstream, jsonRes, request, testConfig } from './harness.js';
import { passthroughEngine, result } from './fake-engine.js';
import { loadConfig } from '../../src/config/load.js';
import { ModelRuntimeMap, type ModelRuntime } from '../../src/proxy/model-runtime.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { StateStore } from '../../src/proxy/state.js';
import { budgetQuantities } from '../../src/proxy/budget.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const legacyStatusKeys = [
  'paths', 'client_compactions', 'last_client_compaction', 'completion_tokens_p99', 'discovered_window',
  'discovered_limits', 'last_compaction', 'recent_requests', 'name', 'version', 'uptime_s', 'config',
  'budget', 'budget_by_key', 'counter', 'model_tokenizers', 'learned', 'counters', 'actions', 'model_counters',
  'error_kinds', 'guard', 'replan', 'upstream_rejected_rewrite', 'recent_rejections', 'fail_open_reasons',
  'warnings', 'sessions', 'latency_ms', 'memory', 'upstream', 'state', 'stats',
];

function statsInput(profile?: string) {
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'synthetic' }] };
  const r = result(req, req, false, { action: 'passthrough', tokensIn: 10, tokensOut: 10 });
  return {
    seq: 1, ts: new Date('2026-01-01T00:00:00Z'), path: '/v1/chat/completions', first: r, last: r,
    action: 'passthrough' as const, attempts: [], clientStatus: 200, tokensIn: 10, correction: 1,
    engineMs: 0, totalMs: 0, compacted: false, shadow: false, forwarded: 'engine' as const,
    usage: null, usageMismatch: false, rewriteRejected: false, ...(profile ? { profile } : {}),
  };
}

test('legacy status and stats preserve their golden keys; profiles are opt-in', () => {
  const tracker = new StatusTracker(testConfig(), 'test');
  const snapshot = tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} });
  assert.deepEqual(Object.keys(snapshot), legacyStatusKeys);
  assert.equal(Object.hasOwn(snapshot, 'profiles'), false);

  const legacyStats = buildStatsRecord(statsInput());
  assert.equal(Object.hasOwn(legacyStats, 'profile'), false);
  assert.deepEqual(Object.keys(legacyStats), [
    'seq', 'ts', 'session', 'path', 'action', 'messages_in', 'messages_out', 'tokens_in', 'tokens_out', 'budget',
    'trigger', 'attempts', 'engine_ms', 'total_ms', 'client_status', 'compacted', 'reused_prefix', 'rung',
    'over_budget', 'est_tokens_in', 'est_tokens_out', 'est_summary_tokens', 'carry_chars', 'threshold_tokens', 'ratio_permille',
  ]);

  const profiles = { reasoning: { W: 100_000, T_plan: 8_000, hard: 80_000, trigger: 72_000, counter_mode: 'exact' } };
  const profiled = tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {}, profiles });
  assert.deepEqual(profiled.profiles, profiles);
  assert.equal(buildStatsRecord(statsInput('reasoning')).profile, 'reasoning');
});

test('proxy status and stats expose the request profile only when models are configured', async () => {
  const upstream = await fakeUpstream((_hit, res) => jsonRes(res, 200, { id: 'ok', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'kitzur-profile-status-'));
    const statsPath = join(dir, 'stats.jsonl');
    const loaded = loadConfig({ env: {}, object: { models: { reasoning: { budget: { window: 100_000, defaultMaxTokens: 8_000 } } } } });
    const cfg = { ...loaded.config, listen: { ...loaded.config.listen, port: 0 }, upstream: { ...loaded.config.upstream, origin: upstream.origin }, stateDir: dir, stats: { ...loaded.config.stats, path: statsPath } };
    const rootCounter = charCounter();
    const profileCounter = charCounter('exact');
    const root = { cfg: loaded.config, counter: rootCounter, engine: passthroughEngine() } as unknown as ModelRuntime;
    const profCfg = loaded.models.reasoning!;
    const profile = { cfg: profCfg, counter: profileCounter, engine: passthroughEngine() } as unknown as ModelRuntime;
    const runtimes = new ModelRuntimeMap(root, loaded.models, new Map([['reasoning', profile]]));
    const state = new StateStore({ dir, configuredWindow: cfg.budget.window, counterId: rootCounter.id });
    const stats = new StatsWriter(statsPath);
    const proxy = createProxyServer(cfg, { counter: rootCounter, engine: root.engine, modelRuntimes: runtimes, state, stats });
    try {
      const { port } = await proxy.listen();
      const status = (await request(port, { method: 'GET', path: '/status' })).json();
      const quantities = budgetQuantities(profCfg, null);
      assert.deepEqual(status.profiles.reasoning, {
        W: profCfg.budget.window, T_plan: profCfg.budget.defaultMaxTokens, hard: quantities.hard, trigger: quantities.trigger, counter_mode: 'exact',
      });
      await request(port, { body: { model: 'reasoning', messages: [{ role: 'user', content: 'hello' }] } });
      await proxy.close();
      const records = readFileSync(statsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records[0].profile, 'reasoning');
    } finally {
      await proxy.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }

  const legacyDir = mkdtempSync(join(tmpdir(), 'kitzur-legacy-status-'));
  const legacyStatsPath = join(legacyDir, 'stats.jsonl');
  const legacyCfg = testConfig({ upstream: { origin: upstream.origin }, stateDir: legacyDir, stats: { path: legacyStatsPath } });
  const legacyCounter = charCounter();
  const legacyState = new StateStore({ dir: legacyDir, configuredWindow: legacyCfg.budget.window, counterId: legacyCounter.id });
  const legacyStats = new StatsWriter(legacyStatsPath);
  const legacyProxy = createProxyServer(legacyCfg, { counter: legacyCounter, engine: passthroughEngine(), state: legacyState, stats: legacyStats });
  try {
    const { port } = await legacyProxy.listen();
    const status = (await request(port, { method: 'GET', path: '/status' })).json();
    assert.equal(Object.hasOwn(status, 'profiles'), false);
    await request(port, { body: { model: 'reasoning', messages: [{ role: 'user', content: 'hello' }] } });
    await legacyProxy.close();
    const records = readFileSync(legacyStatsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(Object.hasOwn(records[0], 'profile'), false);
    } finally {
      await legacyProxy.close().catch(() => undefined);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  } finally {
    await upstream.close();
  }
});
