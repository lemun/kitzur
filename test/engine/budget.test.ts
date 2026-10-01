import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetMode, clampClause, computeBudget, decideMaxTokens, ffloor, fits, maxTokensFields, requestedMaxTokens, serverFits,
  serverLimit,
} from '../../src/engine/budget.js';
import { defaultLearnedEntry } from '../../src/engine/learned.js';
import { presetConfig, testConfig } from './stubs.js';

const E = (cfg: ReturnType<typeof testConfig>) => defaultLearnedEntry(cfg, 'c');

test('ffloor avoids IEEE drift (41,000 · 0.35 = 14,350)', () => {
  assert.equal(Math.floor(41_000 * 0.35), 14_349);
  assert.equal(ffloor(41_000, 0.35), 14_350);
});

test('presets reproduce the DESIGN §3 table', () => {
  const rows: Array<[string, number, number, number, number, number]> = [
    ['32k', 23_488, 24_000, 4_000, 20_000, 7_000],
    ['64k', 47_360, 48_000, 7_000, 41_000, 14_350],
    ['100k', 67_000, 68_000, 7_000, 61_000, 21_350],
    ['128k', 94_720, 96_000, 7_000, 89_000, 31_150],
  ];
  for (const [p, budget, clientPoint, allowance, hard, target] of rows) {
    const cfg = presetConfig(p);
    const b = computeBudget(cfg, E(cfg), 0, cfg.budget.defaultMaxTokens);
    assert.deepEqual([b.budget, b.clientPoint, b.allowance, b.hard, b.trigger, b.target], [budget, clientPoint, allowance, hard, hard, target], p);
  }
});

test('trigger/target clamps (), learned window, maxPrompt, tighten, byte limit', () => {
  const cfg = testConfig({ compaction: { triggerTokens: 66_000, targetTokens: 31_124 }, upstream: { maxBodyBytes: 1_000_000 } });
  const e = { ...E(cfg), window: 90_000, tighten: 512, maxBodyBytes: 800_000 };
  const b = computeBudget(cfg, e, 256, 32_000);
  assert.equal(b.window, 90_000);
  assert.equal(b.margin, 900);
  assert.equal(b.tighten, 768);
  assert.equal(b.budget, 90_000 - 32_000 - 900 - 768);
  assert.ok(b.trigger <= b.hard && b.hard <= b.budget);
  assert.ok(b.target < b.trigger);
  assert.equal(b.byteLimit, 800_000);
  const p = computeBudget(cfg, { ...E(cfg), maxPrompt: 50_000 }, 0, 32_000);
  assert.equal(p.budget, 50_000 - 1000);
});

test('T_req: max of positive max_tokens / max_completion_tokens, else default', () => {
  const cfg = testConfig();
  assert.equal(requestedMaxTokens({ messages: [] }, cfg), 32_000);
  assert.equal(requestedMaxTokens({ messages: [], max_tokens: 100, max_completion_tokens: 200 }, cfg), 200);
  assert.equal(requestedMaxTokens({ messages: [], max_tokens: 0, max_completion_tokens: null }, cfg), 32_000);
  assert.deepEqual(maxTokensFields({ messages: [] }), ['max_tokens']);
  assert.deepEqual(maxTokensFields({ messages: [], max_completion_tokens: 5 }), ['max_completion_tokens']);
  assert.deepEqual(maxTokensFields({ messages: [], max_tokens: 1, max_completion_tokens: 5 }), ['max_tokens', 'max_completion_tokens']);
});

test('budget mode precedence ()', () => {
  assert.equal(budgetMode(testConfig({ server: { type: 'llamacpp', budgetMode: 'strict_total' } })), 'strict_total');
  assert.equal(budgetMode(testConfig({ server: { type: 'tgi' }, budget: { limitCountsMaxTokens: true } })), 'tgi');
  assert.equal(budgetMode(testConfig({ server: { type: 'vllm' }, budget: { limitCountsMaxTokens: true } })), 'strict_total');
  assert.equal(budgetMode(testConfig({ server: { type: 'ollama' }, budget: { limitCountsMaxTokens: false } })), 'silent_truncate');
  assert.equal(budgetMode(testConfig({ server: { type: 'vllm' }, budget: { limitCountsMaxTokens: false } })), 'prompt_only');
  const byType: Array<[string, string]> = [
    ['vllm', 'strict_total'], ['sglang', 'strict_total'], ['litellm', 'strict_total'], ['unknown', 'strict_total'],
    ['llamacpp', 'prompt_only'], ['lmstudio', 'prompt_only'], ['tgi', 'tgi'], ['ollama', 'silent_truncate'],
  ];
  for (const [t, m] of byType) assert.equal(budgetMode(testConfig({ server: { type: t as 'vllm' } })), m, t);
});

test('serverFits per mode and the forwarded max_tokens ()', () => {
  const mk = (type: string) => {
    const cfg = testConfig({ server: { type: type as 'vllm' } });
    return { cfg, b: computeBudget(cfg, E(cfg), 0, 32_000) };
  };
  const s = mk('vllm');
  const lim = serverLimit(s.b);
  assert.equal(lim, 99_000);
  assert.ok(serverFits(s.b, lim - 32_000, 32_000));
  assert.ok(!serverFits(s.b, lim - 31_999, 32_000));
  const t = mk('tgi');
  assert.ok(serverFits(t.b, lim - 1024, 32_000));
  assert.ok(!serverFits(t.b, lim - 1023, 32_000));
  const p = mk('llamacpp');
  assert.ok(serverFits(p.b, lim, 1_000_000));
  assert.ok(!serverFits(p.b, lim + 1, 0));
  // fit clamp: strict_total forwards W − margin − tighten − count when prompt + T_req is over
  assert.deepEqual(decideMaxTokens(s.cfg, s.b, 67_000, false), { value: 32_000, kind: 'unchanged' });
  assert.deepEqual(decideMaxTokens(s.cfg, s.b, 67_001, false), { value: 31_999, kind: 'fit' });
  assert.deepEqual(decideMaxTokens(t.cfg, t.b, lim - 1000, false), { value: 1000, kind: 'fit' });
  assert.deepEqual(decideMaxTokens(p.cfg, p.b, lim - 10, false), { value: 32_000, kind: 'unchanged' });
});

test('restore raises a shrunken max_tokens (Kilo) up to toTokens within the server limit', () => {
  const cfg = testConfig({ budget: { maxTokensRestore: { enabled: true, toTokens: null } } });
  const b = computeBudget(cfg, E(cfg), 0, 1024);
  assert.deepEqual(decideMaxTokens(cfg, b, 20_000, false), { value: 32_000, kind: 'restore' });
  assert.deepEqual(decideMaxTokens(cfg, b, 90_000, false), { value: 9_000, kind: 'restore' });
});

test('clamp clause (): opt-in, strict_total, floor and client point', () => {
  const off = testConfig();
  const bo = computeBudget(off, E(off), 0, 32_000);
  assert.ok(!clampClause(off, bo, 70_000, false));
  // declared-large client window makes the clamp reachable
  const cfg = testConfig({ budget: { maxTokensClamp: { enabled: true, floorTokens: 8192 } }, client: { compactionPointTokens: 100_000 } });
  const b = computeBudget(cfg, E(cfg), 0, 32_000);
  assert.ok(clampClause(cfg, b, 80_000, false));
  assert.ok(fits(cfg, b, 80_000, false));
  assert.ok(!fits(cfg, b, 80_000, true), 'noClamp');
  assert.ok(!clampClause(cfg, b, 99_000 - 8191, false), 'floor');
  assert.deepEqual(decideMaxTokens(cfg, b, 80_000, true), { value: 19_000, kind: 'clamp' });
  const unreachable = presetConfig('100k', { budget: { maxTokensClamp: { enabled: true, floorTokens: 8192 } } });
  const bu = computeBudget(unreachable, E(unreachable), 0, 32_000);
  for (let c = bu.trigger + 1; c < bu.window; c += 97) assert.ok(!clampClause(unreachable, bu, c, false), `range empty at ${c}`);
});
