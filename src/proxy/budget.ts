// The §3 budget quantities the proxy needs on its own: when the engine threw (I7), for the rewrite-
// rejection resend (), for the max_tokens_too_large retry value and for the near-budget test of
// ambiguous errors (§8). Normally these come from EngineResult.stats.budget; this module computes the
// same numbers from config and the learned entry so the proxy never depends on an engine result.
import type { Config, BudgetMode } from '../config/schema.js';
import type { LearnedEntry } from '../types.js';

/** floor(x · f) with the §3 epsilon (41,000 · 0.35 must be 14,350). */
export const floorFrac = (x: number, f: number): number => Math.floor(x * f + 1e-9);
/** ceil(x · f) with the same epsilon, downwards (0.01 · 100,000 must be 1,000). */
export const ceilFrac = (x: number, f: number): number => Math.ceil(x * f - 1e-9);
/** count(x) = ceil(raw(x) · correction) (§4). */
export const corrected = (raw: number, correction: number): number => Math.ceil(raw * correction - 1e-9);

/** §3 precedence (): explicit mode, then limitCountsMaxTokens, then the server type. */
export function budgetModeOf(cfg: Config): BudgetMode {
  if (cfg.server.budgetMode) return cfg.server.budgetMode;
  const t = cfg.server.type;
  const lc = cfg.budget.limitCountsMaxTokens;
  if (lc === true) return t === 'tgi' ? 'tgi' : 'strict_total';
  if (lc === false) return t === 'ollama' ? 'silent_truncate' : 'prompt_only';
  switch (t) {
    case 'llamacpp':
    case 'lmstudio':
      return 'prompt_only';
    case 'tgi':
      return 'tgi';
    case 'ollama':
      return 'silent_truncate';
    default:
      return 'strict_total';
  }
}

export interface ServerLimits {
  mode: BudgetMode;
  /** W = E.window ?? budget.window */
  window: number;
  margin: number;
  /** effective tighten = E.tighten + request-local extra */
  tighten: number;
  /** T_plan */
  planMaxTokens: number;
  /** budget₀ = W − T_plan − margin (§8) */
  budget0: number;
  /** the §3 budget */
  budget: number;
  /** hard = min(budget, clientPoint − allowance) */
  hard: number;
}

export function serverLimits(cfg: Config, e: LearnedEntry | null, extraTighten = 0): ServerLimits {
  const b = cfg.budget;
  const W = e?.window ?? b.window;
  const tPlan = b.planMaxTokens ?? b.defaultMaxTokens;
  const margin = Math.max(b.safetyMarginTokens, ceilFrac(W, b.safetyMarginFraction));
  const tighten = (e?.tighten ?? 0) + Math.max(0, extraTighten);
  const budget0 = W - tPlan - margin;
  const budget = Math.min(budget0, (e?.maxPrompt ?? Infinity) - margin) - tighten;
  const c = cfg.client;
  const clientPoint = c.compactionPointTokens ?? W - Math.min(c.outputLimit ?? tPlan, c.outputTokenMax);
  const allowance = c.outputAllowanceTokens ?? Math.min(7000, Math.floor(tPlan / 2));
  return { mode: budgetModeOf(cfg), window: W, margin, tighten, planMaxTokens: tPlan, budget0, budget, hard: Math.min(budget, clientPoint - allowance) };
}

/** serverFits(x, M) of §3 on an already corrected count. */
export function serverFits(count: number, maxTokens: number, lim: Pick<ServerLimits, 'mode' | 'window' | 'margin' | 'tighten'>): boolean {
  const room = lim.window - lim.margin - lim.tighten;
  switch (lim.mode) {
    case 'strict_total':
      return count + maxTokens <= room;
    case 'tgi':
      return count + Math.min(maxTokens, 1024) <= room;
    default:
      return count <= room;
  }
}

/** All §3 quantities for /status (T_req-independent: planning uses T_plan). */
export interface BudgetQuantities extends ServerLimits {
  clientPoint: number;
  allowance: number;
  trigger: number;
  target: number;
  /** min(upstream.maxBodyBytes, E.maxBodyBytes); null = none */
  byteLimit: number | null;
  correction: number;
}

export function budgetQuantities(cfg: Config, e: LearnedEntry | null): BudgetQuantities {
  const lim = serverLimits(cfg, e);
  const c = cfg.client;
  const clientPoint = c.compactionPointTokens ?? lim.window - Math.min(c.outputLimit ?? lim.planMaxTokens, c.outputTokenMax);
  const allowance = c.outputAllowanceTokens ?? Math.min(7000, Math.floor(lim.planMaxTokens / 2));
  const k = cfg.compaction;
  const trigger = Math.min(k.triggerTokens ?? floorFrac(lim.hard, k.triggerFraction), lim.hard);
  const target = Math.min(k.targetTokens ?? floorFrac(trigger, k.targetFraction), trigger - 1);
  const bl = Math.min(cfg.upstream.maxBodyBytes ?? Infinity, e?.maxBodyBytes ?? Infinity);
  return { ...lim, clientPoint, allowance, trigger, target, byteLimit: Number.isFinite(bl) ? bl : null, correction: e?.correction ?? 1 };
}
