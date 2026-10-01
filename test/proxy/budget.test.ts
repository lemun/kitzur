import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetModeOf, budgetQuantities, serverFits, serverLimits } from '../../src/proxy/budget.js';
import { freshLearnedEntry } from '../../src/proxy/state.js';
import { testConfig } from './harness.js';

test('§3 quantities reproduce the DESIGN preset table (32k/8k, 64k/16k, 100k/32k, 128k/32k)', () => {
  const rows: Array<[number, number, number, number, number, number, number]> = [
    // window, T_plan, budget, clientPoint, allowance, hard=trigger, target
    [32_000, 8000, 23_488, 24_000, 4000, 20_000, 7000],
    [64_000, 16_000, 47_360, 48_000, 7000, 41_000, 14_350],
    [100_000, 32_000, 67_000, 68_000, 7000, 61_000, 21_350],
    [128_000, 32_000, 94_720, 96_000, 7000, 89_000, 31_150],
  ];
  for (const [W, T, budget, clientPoint, allowance, hard, target] of rows) {
    const q = budgetQuantities(testConfig({ budget: { window: W, defaultMaxTokens: T } }), null);
    assert.deepEqual([q.budget, q.clientPoint, q.allowance, q.hard, q.trigger, q.target], [budget, clientPoint, allowance, hard, hard, target], `${W}/${T}`);
  }
});

test('learned entry and tighten enter the budget; serverFits per mode', () => {
  const cfg = testConfig();
  const e = { ...freshLearnedEntry(100_000, 'c'), window: 89_000, tighten: 512, maxPrompt: 60_000 };
  const l = serverLimits(cfg, e, 256);
  // W = 89k, margin = max(512, 890) = 890; budget = min(89000-32000-890, 60000-890) - 768
  assert.deepEqual([l.window, l.margin, l.tighten, l.budget], [89_000, 890, 768, 56_110 - 768]);
  const lim = { window: 10_000, margin: 500, tighten: 0 };
  assert.equal(serverFits(5000, 4500, { ...lim, mode: 'strict_total' }), true);
  assert.equal(serverFits(5000, 4501, { ...lim, mode: 'strict_total' }), false);
  assert.equal(serverFits(8000, 4501, { ...lim, mode: 'tgi' }), true, 'tgi counts min(M, 1024)');
  assert.equal(serverFits(8476, 4501, { ...lim, mode: 'tgi' }), true);
  assert.equal(serverFits(8477, 4501, { ...lim, mode: 'tgi' }), false);
  assert.equal(serverFits(9500, 99_999, { ...lim, mode: 'prompt_only' }), true);
  assert.equal(serverFits(9501, 0, { ...lim, mode: 'silent_truncate' }), false);
});

test('budget mode precedence ()', () => {
  assert.equal(budgetModeOf(testConfig({ server: { type: 'llamacpp', budgetMode: 'strict_total' } })), 'strict_total');
  assert.equal(budgetModeOf(testConfig({ server: { type: 'tgi' }, budget: { limitCountsMaxTokens: true } })), 'tgi');
  assert.equal(budgetModeOf(testConfig({ server: { type: 'vllm' }, budget: { limitCountsMaxTokens: false } })), 'prompt_only');
  assert.equal(budgetModeOf(testConfig({ server: { type: 'ollama' }, budget: { limitCountsMaxTokens: false } })), 'silent_truncate');
  assert.equal(budgetModeOf(testConfig({ server: { type: 'lmstudio' } })), 'prompt_only');
  assert.equal(budgetModeOf(testConfig({ server: { type: 'unknown' } })), 'strict_total');
  assert.equal(budgetModeOf(testConfig({ server: { type: 'ollama' } })), 'silent_truncate');
});
