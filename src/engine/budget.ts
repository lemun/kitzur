// Budget quantities (DESIGN.md): T_req, T_plan, W, margin, budget, clientPoint, allowance, hard,
// trigger, target, the byte limit, the server budget mode (with its precedence, ), serverFits (),
// the step's fit predicate with the opt-in clamp clause (), and the forwarded max_tokens ().
import type { Budget, ChatRequest, LearnedEntry } from '../types.js';
import type { BudgetMode, Config } from '../config/schema.js';

/** floor(x · fraction) as DESIGN §3 defines it: Math.floor(x * f + 1e-9) (41,000 · 0.35 = 14,350). */
export const ffloor = (x: number, f: number): number => Math.floor(x * f + 1e-9);

/** Server budget mode, by precedence: explicit mode, then limitCountsMaxTokens, then server.type (§3, ). */
export function budgetMode(cfg: Config): BudgetMode {
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

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** T_req: the max of the defined, positive max_tokens / max_completion_tokens; else budget.defaultMaxTokens. */
export function requestedMaxTokens(req: ChatRequest, cfg: Config): number {
  const a = req.max_tokens;
  const b = req.max_completion_tokens;
  let t = cfg.budget.defaultMaxTokens;
  if (positive(a) && positive(b)) t = Math.max(a, b);
  else if (positive(a)) t = a;
  else if (positive(b)) t = b;
  return Math.max(1, Math.floor(t));
}

/** Every §3 quantity for one request. `summaryBudget`, `admitTokens` start at their base values. */
export function computeBudget(cfg: Config, E: LearnedEntry, extraTighten: number, tReq: number): Budget {
  const b = cfg.budget;
  const tPlan = b.planMaxTokens ?? b.defaultMaxTokens;
  const W = E.window ?? b.window;
  const margin = Math.max(b.safetyMarginTokens, Math.ceil(b.safetyMarginFraction * W - 1e-9));
  const tighten = Math.max(0, E.tighten) + Math.max(0, extraTighten);
  const byPrompt = E.maxPrompt === null ? Infinity : E.maxPrompt - margin;
  const budget = Math.min(W - tPlan - margin, byPrompt) - tighten;
  const c = cfg.client;
  const clientPoint = c.compactionPointTokens ?? W - Math.min(c.outputLimit ?? tPlan, c.outputTokenMax);
  const allowance = c.outputAllowanceTokens ?? Math.min(7000, Math.floor(tPlan / 2));
  const hard = Math.min(budget, clientPoint - allowance);
  const k = cfg.compaction;
  const trigger = Math.min(k.triggerTokens ?? ffloor(hard, k.triggerFraction), hard);
  const target = Math.min(k.targetTokens ?? ffloor(trigger, k.targetFraction), trigger - 1);
  const limits = [cfg.upstream.maxBodyBytes, E.maxBodyBytes].filter((x): x is number => typeof x === 'number');
  const byteLimit = limits.length ? Math.min(...limits) : null;
  return {
    window: W,
    maxTokensRequested: tReq,
    planMaxTokens: tPlan,
    margin,
    budget,
    clientPoint,
    allowance,
    hard,
    trigger,
    target,
    mode: budgetMode(cfg),
    tighten,
    byteLimit,
    summaryBudget: baseSummaryBudget(cfg, budget),
    admitTokens: cfg.oversize.admitTokens,
    headRoom: headRoom(cfg, budget),
  };
}

/** summaryBudget before the ledger floor is known: min(floor(budget·summaryFraction), floor(budget·summaryMaxFraction)). */
export function baseSummaryBudget(cfg: Config, budget: number): number {
  return Math.max(0, Math.min(ffloor(budget, cfg.compaction.summaryFraction), ffloor(budget, cfg.compaction.summaryMaxFraction)));
}

/** summaryBudget = min(max(floorTokens, floor(budget·summaryFraction)), floor(budget·summaryMaxFraction)) (§6.4). */
export function summaryBudgetFor(cfg: Config, budget: number, floorTokens: number): number {
  const k = cfg.compaction;
  return Math.max(0, Math.min(Math.max(floorTokens, ffloor(budget, k.summaryFraction)), ffloor(budget, k.summaryMaxFraction)));
}

/** headRoom = budget − floor(budget·summaryFraction) − (minTailTokens ?? floor(0.25·budget)) (§5.7, ). */
export function headRoom(cfg: Config, budget: number): number {
  return budget - ffloor(budget, cfg.compaction.summaryFraction) - (cfg.oversize.minTailTokens ?? ffloor(budget, 0.25));
}

/** W − margin − tighten: the server's real limit as far as we know it. */
export const serverLimit = (b: Budget): number => b.window - b.margin - b.tighten;

/** serverFits(x, M) with count(x) = c (§3, ). */
export function serverFits(b: Budget, c: number, M: number): boolean {
  const lim = serverLimit(b);
  switch (b.mode) {
    case 'strict_total':
      return c + M <= lim;
    case 'tgi':
      return c + Math.min(M, 1024) <= lim;
    default:
      return c <= lim;
  }
}

/** The clamp clause of fits(c) (§3, ). */
export function clampClause(cfg: Config, b: Budget, c: number, noClamp: boolean): boolean {
  const cl = cfg.budget.maxTokensClamp;
  return (
    !noClamp && cl.enabled && b.mode === 'strict_total' && c <= serverLimit(b) - cl.floorTokens && c + b.allowance < b.clientPoint
  );
}

/** fits(c) := c ≤ min(trigger, budget) ∨ clampClause(c). */
export function fits(cfg: Config, b: Budget, c: number, noClamp: boolean): boolean {
  return c <= Math.min(b.trigger, b.budget) || clampClause(cfg, b, c, noClamp);
}

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

/** Fields the client sent with a numeric value; the rewrite sets all of them, or adds max_tokens (§3). */
export function maxTokensFields(req: ChatRequest): MaxTokensField[] {
  const out: MaxTokensField[] = [];
  if (typeof req.max_tokens === 'number') out.push('max_tokens');
  if (typeof req.max_completion_tokens === 'number') out.push('max_completion_tokens');
  return out.length ? out : ['max_tokens'];
}

/** What happens to max_tokens for an output of count c. */
export interface MaxTokensDecision {
  /** the value forwarded (T_req when unchanged) */
  value: number;
  kind: 'unchanged' | 'fit' | 'restore' | 'clamp';
}

/**
 * Forwarded max_tokens (§3): the always-on fit clamp (strict_total, tgi), the opt-in restore, or the
 * clamp value when the clamp clause decided (`clamped`).
 */
export function decideMaxTokens(cfg: Config, b: Budget, c: number, clamped: boolean): MaxTokensDecision {
  const T = b.maxTokensRequested;
  const room = serverLimit(b) - c;
  if (clamped) {
    const v = Math.min(T, room);
    return v < T ? { value: v, kind: 'clamp' } : { value: T, kind: 'unchanged' };
  }
  if (b.mode === 'strict_total' && c + T > serverLimit(b)) return { value: room, kind: 'fit' };
  if (b.mode === 'tgi' && c + Math.min(T, 1024) > serverLimit(b)) return { value: room, kind: 'fit' };
  const rs = cfg.budget.maxTokensRestore;
  if (rs.enabled) {
    const to = rs.toTokens ?? b.planMaxTokens;
    if (T < to) {
      const v = Math.min(to, room);
      if (v > T) return { value: v, kind: 'restore' };
    }
  }
  return { value: T, kind: 'unchanged' };
}
