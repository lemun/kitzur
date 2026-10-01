import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import {
  budgetModeConflict, clampRange, computeBudget, floorFrac, planMaxTokens, requestMaxTokens, resolveBudgetMode, serverFits, snapshotRoom,
} from '../../src/config/derived.js';
import { loadConfig } from '../../src/config/load.js';
import { PRESET_TABLE } from '../../src/config/presets.js';
import { mulberry32 } from './rng.js';

const withPreset = (name: string): Config => loadConfig({ preset: name, env: {} }).config;

test('computeBudget: the DESIGN §3 preset table, from presets/*.json and the defaults', () => {
  // | Preset | budget | clientPoint | allowance | hard = trigger | target |
  const table: Record<string, [number, number, number, number, number]> = {
    '32k': [23_488, 24_000, 4_000, 20_000, 7_000],
    '64k': [47_360, 48_000, 7_000, 41_000, 14_350],
    '100k': [67_000, 68_000, 7_000, 61_000, 21_350],
    '128k': [94_720, 96_000, 7_000, 89_000, 31_150],
  };
  for (const [name, [budget, clientPoint, allowance, trigger, target]] of Object.entries(table)) {
    const cfg = withPreset(name);
    assert.equal(cfg.budget.window, PRESET_TABLE[name]!.window, name);
    assert.equal(cfg.budget.defaultMaxTokens, PRESET_TABLE[name]!.defaultMaxTokens, name);
    const b = computeBudget(cfg);
    assert.deepEqual(
      { budget: b.budget, clientPoint: b.clientPoint, allowance: b.allowance, hard: b.hard, trigger: b.trigger, target: b.target },
      { budget, clientPoint, allowance, hard: trigger, trigger, target },
      name,
    );
    assert.equal(b.mode, 'strict_total');
    assert.equal(b.byteLimit, null);
  }
  // the built-in defaults are the 100k/32k preset
  assert.deepEqual(computeBudget(DEFAULT_CONFIG), computeBudget(withPreset('100k')));
});

test('floorFrac: the 1e-9 epsilon (41,000 · 0.35 is 14,349.999… in IEEE)', () => {
  assert.equal(Math.floor(41_000 * 0.35), 14_349);
  assert.equal(floorFrac(41_000, 0.35), 14_350);
  assert.equal(floorFrac(89_000, 0.35), 31_150);
  assert.equal(floorFrac(-5, 0.5), -3);
});

test('computeBudget: admitTokens and summaryBudget with the reference head (DESIGN §5.5a)', () => {
  // "With the reference head of 9,376 tokens, this is 27,472 at 100k/32k, 18,045 at 64k/16k and 6,586 at 32k/8k."
  const expect: Record<string, number> = { '100k': 27_472, '64k': 18_045, '32k': 6_586 };
  for (const [name, admit] of Object.entries(expect)) {
    const b = computeBudget(withPreset(name), { counterFixedTokens: 9376 });
    assert.equal(b.admitTokens, admit, name);
  }
  const b = computeBudget(DEFAULT_CONFIG);
  assert.equal(b.admitTokens, null, 'unknown head -> null');
  assert.equal(b.summaryBudget, 2680); // floor(67,000 · 0.04)
  assert.equal(computeBudget(DEFAULT_CONFIG, { floorTokens: 5000 }).summaryBudget, 5000);
  assert.equal(computeBudget(DEFAULT_CONFIG, { floorTokens: 50_000 }).summaryBudget, 16_750, 'capped at summaryMaxFraction');
  assert.equal(b.headRoom, 67_000 - 2680 - 16_750);
  const off = structuredClone(DEFAULT_CONFIG);
  off.oversize.admission = false;
  assert.equal(computeBudget(off, { counterFixedTokens: 9376 }).admitTokens, null);
  off.oversize.admission = true;
  off.oversize.admitTokens = 5000;
  assert.equal(computeBudget(off).admitTokens, 5000);
});

test('computeBudget: learned entry, tighten, maxPrompt, byte limit, T_req', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.upstream.maxBodyBytes = 1_048_576;
  const b = computeBudget(cfg, { tReq: 16_000, learned: { window: 98_304, maxPrompt: null, maxBodyBytes: 900_000, tighten: 512 }, extraTighten: 256 });
  assert.equal(b.window, 98_304);
  assert.equal(b.margin, 984); // ceil(0.01 · 98,304)
  assert.equal(b.tighten, 768);
  assert.equal(b.budget, 98_304 - 32_000 - 984 - 768);
  assert.equal(b.maxTokensRequested, 16_000);
  assert.equal(b.planMaxTokens, 32_000, 'T_req never changes T_plan (ADR-7)');
  assert.equal(b.byteLimit, 900_000);
  const mp = computeBudget(cfg, { learned: { window: null, maxPrompt: 50_000, maxBodyBytes: null, tighten: 0 } });
  assert.equal(mp.budget, 49_000);
  assert.equal(mp.byteLimit, 1_048_576);
});

test('requestMaxTokens / planMaxTokens (§3 T_req, T_plan)', () => {
  assert.equal(requestMaxTokens({}, DEFAULT_CONFIG), 32_000);
  assert.equal(requestMaxTokens({ max_tokens: 1024 }, DEFAULT_CONFIG), 1024);
  assert.equal(requestMaxTokens({ max_tokens: 1024, max_completion_tokens: 4096 }, DEFAULT_CONFIG), 4096);
  assert.equal(requestMaxTokens({ max_tokens: 0, max_completion_tokens: null }, DEFAULT_CONFIG), 32_000);
  assert.equal(requestMaxTokens({ max_tokens: -5 }, DEFAULT_CONFIG), 32_000);
  const cfg = structuredClone(DEFAULT_CONFIG);
  assert.equal(planMaxTokens(cfg), 32_000);
  cfg.budget.planMaxTokens = 12_000;
  assert.equal(planMaxTokens(cfg), 12_000);
});

test('resolveBudgetMode:  precedence and conflicts', () => {
  const mk = (type: Config['server']['type'], mode: Config['server']['budgetMode'], lc: boolean | null) => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.server.type = type;
    c.server.budgetMode = mode;
    c.budget.limitCountsMaxTokens = lc;
    return c;
  };
  const byType: Record<string, string> = {
    vllm: 'strict_total', sglang: 'strict_total', litellm: 'strict_total', unknown: 'strict_total',
    llamacpp: 'prompt_only', lmstudio: 'prompt_only', tgi: 'tgi', ollama: 'silent_truncate',
  };
  for (const [t, m] of Object.entries(byType)) assert.equal(resolveBudgetMode(mk(t as Config['server']['type'], null, null)), m, t);
  assert.equal(resolveBudgetMode(mk('llamacpp', null, true)), 'strict_total');
  assert.equal(resolveBudgetMode(mk('tgi', null, true)), 'tgi');
  assert.equal(resolveBudgetMode(mk('vllm', null, false)), 'prompt_only');
  assert.equal(resolveBudgetMode(mk('ollama', null, false)), 'silent_truncate');
  assert.equal(resolveBudgetMode(mk('vllm', 'prompt_only', null)), 'prompt_only', 'explicit mode wins');
  assert.equal(budgetModeConflict(mk('vllm', 'strict_total', false))?.includes('limitCountsMaxTokens'), true);
  assert.equal(budgetModeConflict(mk('vllm', 'tgi', false)) !== null, true);
  assert.equal(budgetModeConflict(mk('vllm', 'prompt_only', true)) !== null, true);
  assert.equal(budgetModeConflict(mk('vllm', 'silent_truncate', true)) !== null, true);
  assert.equal(budgetModeConflict(mk('vllm', 'strict_total', true)), null);
  assert.equal(budgetModeConflict(mk('vllm', 'prompt_only', false)), null);
  assert.equal(budgetModeConflict(mk('vllm', null, false)), null);
});

test('serverFits per mode (§3)', () => {
  const b = { window: 32_000, margin: 512, tighten: 0 };
  assert.equal(serverFits({ ...b, mode: 'strict_total' }, 23_488, 8000), true);
  assert.equal(serverFits({ ...b, mode: 'strict_total' }, 23_489, 8000), false);
  assert.equal(serverFits({ ...b, mode: 'tgi' }, 30_000, 8000), true); // 30,000 + 1,024 <= 31,488
  assert.equal(serverFits({ ...b, mode: 'tgi' }, 30_465, 8000), false);
  assert.equal(serverFits({ ...b, mode: 'prompt_only' }, 31_488, 32_000), true);
  assert.equal(serverFits({ ...b, mode: 'silent_truncate' }, 31_489, 0), false);
  assert.equal(serverFits({ ...b, tighten: 100, mode: 'prompt_only' }, 31_400, 0), false);
});

test('clampRange: unreachable with truthful presets, reachable with a declared-large client window ()', () => {
  for (const name of Object.keys(PRESET_TABLE)) {
    const cfg = withPreset(name);
    cfg.budget.maxTokensClamp.enabled = true;
    assert.equal(clampRange(cfg, computeBudget(cfg)).reachable, false, name);
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.budget.maxTokensClamp.enabled = true;
  cfg.client.compactionPointTokens = 100_000; // e.g. OpenCode limit.input 1000000
  const b = computeBudget(cfg);
  const r = clampRange(cfg, b);
  assert.equal(r.reachable, true);
  assert.equal(r.lo, 67_000);
  assert.equal(r.hi, Math.min(100_000 - 1000 - 8192, 100_000 - 7000 - 1));
  cfg.server.type = 'llamacpp';
  assert.equal(clampRange(cfg, computeBudget(cfg)).reachable, false, 'prompt_only mode');
});

test('snapshotRoom: at most one snapshot per epoch at 32k/8k with the reference head ()', () => {
  const b32 = computeBudget(withPreset('32k'));
  assert.equal(snapshotRoom(b32, 9376, 17_438).warn, true);
  const b100 = computeBudget(withPreset('100k'));
  const r = snapshotRoom(b100, 9376, 17_438);
  assert.equal(r.room, 61_000 - 9376 - 2680);
  assert.equal(r.warn, false);
});

test('property: trigger <= hard <= budget and target < trigger for any config, learned window and tighten ()', () => {
  const rnd = mulberry32(0xc10);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let checked = 0;
  for (let i = 0; i < 5000; i++) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.budget.window = pick([32_000, 64_000, 100_000, 128_000, 8192 + Math.floor(rnd() * 250_000)]);
    cfg.budget.defaultMaxTokens = 1 + Math.floor(rnd() * cfg.budget.window * 0.6);
    cfg.budget.planMaxTokens = rnd() < 0.3 ? 1 + Math.floor(rnd() * cfg.budget.window * 0.5) : null;
    cfg.budget.safetyMarginTokens = Math.floor(rnd() * 3000);
    cfg.budget.safetyMarginFraction = rnd() * 0.05;
    cfg.client.outputLimit = rnd() < 0.3 ? 1 + Math.floor(rnd() * 64_000) : null;
    cfg.client.compactionPointTokens = rnd() < 0.3 ? 1 + Math.floor(rnd() * cfg.budget.window * 2) : null;
    cfg.client.outputAllowanceTokens = rnd() < 0.3 ? Math.floor(rnd() * 20_000) : null;
    cfg.compaction.triggerFraction = rnd() < 0.5 ? 1.0 : 0.01 + rnd() * 0.99;
    cfg.compaction.targetFraction = 0.01 + rnd() * 0.98;
    cfg.compaction.triggerTokens = rnd() < 0.3 ? 1 + Math.floor(rnd() * 150_000) : null;
    cfg.compaction.targetTokens = rnd() < 0.3 ? 1 + Math.floor(rnd() * 150_000) : null;
    const learned = rnd() < 0.5
      ? { window: rnd() < 0.5 ? Math.floor(cfg.budget.window * (0.5 + rnd() * 0.5)) : null, maxPrompt: rnd() < 0.2 ? Math.floor(rnd() * cfg.budget.window) : null, maxBodyBytes: null, tighten: Math.floor(rnd() * 20_000) }
      : null;
    const b = computeBudget(cfg, { learned, extraTighten: rnd() < 0.2 ? Math.floor(rnd() * 5000) : 0 });
    assert.ok(b.hard <= b.budget, `hard ${b.hard} > budget ${b.budget}`);
    assert.ok(b.trigger <= b.hard, `trigger ${b.trigger} > hard ${b.hard}`);
    assert.ok(b.target < b.trigger, `target ${b.target} >= trigger ${b.trigger}`);
    assert.ok(Math.min(b.trigger, b.budget) === b.trigger);
    if (cfg.compaction.triggerTokens === null && cfg.compaction.triggerFraction === 1) assert.equal(b.trigger, b.hard);
    checked++;
  }
  assert.equal(checked, 5000);
});

test('computeBudget agrees with the engine (src/engine/budget.ts) and the proxy (src/proxy/budget.ts) on random configs', async (t) => {
  type EngineBudget = { computeBudget(c: Config, e: unknown, x: number, tReq: number): Record<string, unknown> };
  type ProxyBudget = { serverLimits(c: Config, e: unknown, x: number): Record<string, unknown> };
  let eng: EngineBudget;
  let prx: ProxyBudget;
  try {
    eng = (await import(new URL('../../src/engine/budget.js', import.meta.url).href)) as EngineBudget;
    prx = (await import(new URL('../../src/proxy/budget.js', import.meta.url).href)) as ProxyBudget;
  } catch {
    t.skip('engine/proxy budget modules not in this build');
    return;
  }
  const rnd = mulberry32(0xb0d6e7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  for (let i = 0; i < 3000; i++) {
    const c = structuredClone(DEFAULT_CONFIG);
    c.budget.window = pick([32_000, 64_000, 100_000, 128_000, 1000 + Math.floor(rnd() * 300_000)]);
    c.budget.defaultMaxTokens = 1 + Math.floor(rnd() * c.budget.window * 0.6);
    c.budget.planMaxTokens = rnd() < 0.3 ? 1 + Math.floor(rnd() * 40_000) : null;
    c.budget.safetyMarginTokens = Math.floor(rnd() * 3000);
    c.budget.safetyMarginFraction = pick([0.01, 0.02, 0.03, 0.05, rnd() * 0.1]);
    c.client.outputLimit = rnd() < 0.3 ? 1 + Math.floor(rnd() * 64_000) : null;
    c.client.compactionPointTokens = rnd() < 0.3 ? Math.floor(rnd() * 200_000) : null;
    c.client.outputAllowanceTokens = rnd() < 0.3 ? Math.floor(rnd() * 20_000) : null;
    c.compaction.triggerFraction = pick([1, 0.92, 0.01 + rnd() * 0.99]);
    c.compaction.targetFraction = pick([0.35, 0.5, 0.005 + rnd() * 0.99]);
    c.compaction.triggerTokens = rnd() < 0.2 ? 1 + Math.floor(rnd() * 150_000) : null;
    c.compaction.targetTokens = rnd() < 0.2 ? 1 + Math.floor(rnd() * 150_000) : null;
    c.server.type = pick(['vllm', 'llamacpp', 'tgi', 'ollama', 'unknown'] as const);
    c.budget.limitCountsMaxTokens = pick([null, true, false]);
    c.upstream.maxBodyBytes = rnd() < 0.2 ? 1_048_576 : null;
    const E = {
      configuredWindow: c.budget.window, counterId: 'x', window: rnd() < 0.3 ? Math.floor(c.budget.window * (0.5 + rnd() * 0.5)) : null,
      maxPrompt: rnd() < 0.2 ? Math.floor(rnd() * c.budget.window) : null, maxBodyBytes: rnd() < 0.2 ? 900_000 : null,
      tighten: rnd() < 0.3 ? Math.floor(rnd() * 10_000) : 0, tightenLog: [], correction: 1, samples: 0, meanRatio: 1, ratios: [], pendingTighten: [],
      includeUsageRejected: false, updatedAt: null,
    };
    const x = rnd() < 0.2 ? Math.floor(rnd() * 3000) : 0;
    const tReq = 1 + Math.floor(rnd() * 40_000);
    const ours = computeBudget(c, { tReq, learned: E, extraTighten: x }) as unknown as Record<string, unknown>;
    const e = eng.computeBudget(c, E, x, tReq);
    for (const k of Object.keys(e)) if (k !== 'admitTokens') assert.equal(ours[k], e[k], `engine ${k} (case ${i})`);
    const p = prx.serverLimits(c, E, x);
    for (const k of ['mode', 'window', 'margin', 'tighten', 'planMaxTokens', 'budget', 'hard']) assert.equal(ours[k], p[k], `proxy ${k} (case ${i})`);
  }
});
