import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusTracker } from '../../src/proxy/status.js';
import { buildStatsRecord } from '../../src/proxy/stats.js';
import { testConfig } from './harness.js';
import { result } from './fake-engine.js';

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
