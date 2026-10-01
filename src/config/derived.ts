// Budget quantities of DESIGN.md, computed from the config (plus the request's T_req, the learned
// entry and, when known, the head size). Pure, no I/O.
//
// This is a standalone implementation for `kitzur config show|validate`, the startup warnings and
// import-eval reporting. The engine has its own (src/engine/budget.ts); both must follow §3 exactly,
// and test/config/derived.test.ts pins the §3 preset table so a drift is caught.
import type { Budget, ChatRequest, LearnedEntry } from '../types.js';
import type { BudgetMode, Config } from './schema.js';

/** `floor(x · fraction)` as DESIGN §3 defines it: with a 1e-9 epsilon (41,000 · 0.35 = 14,349.999… in IEEE). */
export function floorFrac(x: number, fraction: number): number {
  return Math.floor(x * fraction + 1e-9);
}

/**
 * Effective server budget mode ( precedence): an explicit server.budgetMode wins; else
 * budget.limitCountsMaxTokens decides (true: strict_total, or tgi for type tgi; false: prompt_only, or
 * silent_truncate for type ollama); else server.type decides.
 */
export function resolveBudgetMode(cfg: Pick<Config, 'server' | 'budget'>): BudgetMode {
  if (cfg.server.budgetMode) return cfg.server.budgetMode;
  const type = cfg.server.type;
  const lc = cfg.budget.limitCountsMaxTokens;
  if (lc === true) return type === 'tgi' ? 'tgi' : 'strict_total';
  if (lc === false) return type === 'ollama' ? 'silent_truncate' : 'prompt_only';
  switch (type) {
    case 'llamacpp':
    case 'lmstudio':
      return 'prompt_only';
    case 'tgi':
      return 'tgi';
    case 'ollama':
      return 'silent_truncate';
    default:
      return 'strict_total'; // vllm, sglang, litellm, unknown
  }
}

/**
 * The  conflict between an explicit server.budgetMode and budget.limitCountsMaxTokens, as an error
 * message, or null when they agree (or either is unset).
 */
export function budgetModeConflict(cfg: Pick<Config, 'server' | 'budget'>): string | null {
  const m = cfg.server.budgetMode;
  const lc = cfg.budget.limitCountsMaxTokens;
  if (m === null || lc === null) return null;
  const counts = m === 'strict_total' || m === 'tgi';
  if (counts === lc) return null;
  return `server.budgetMode '${m}' ${counts ? 'counts' : 'does not count'} max_tokens, but budget.limitCountsMaxTokens is ${lc}: remove one of them`;
}

/** T_plan = budget.planMaxTokens ?? budget.defaultMaxTokens (config only; , ADR-7). */
export function planMaxTokens(cfg: Pick<Config, 'budget'>): number {
  return cfg.budget.planMaxTokens ?? cfg.budget.defaultMaxTokens;
}

/** T_req: the max of the defined, positive max_tokens / max_completion_tokens; else budget.defaultMaxTokens. */
export function requestMaxTokens(req: Pick<ChatRequest, 'max_tokens' | 'max_completion_tokens'>, cfg: Pick<Config, 'budget'>): number {
  let t = 0;
  for (const v of [req.max_tokens, req.max_completion_tokens]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) t = Math.max(t, v);
  }
  // a positive fraction (0.5) is still a value the client sent: at least 1, as the engine does
  return t > 0 ? Math.max(1, Math.floor(t)) : cfg.budget.defaultMaxTokens;
}

export interface BudgetInputs {
  /** T_req of the request; null/undefined = budget.defaultMaxTokens */
  tReq?: number | null;
  /** learned entry E for (origin, model); the caller has already applied invalidation (§8) */
  learned?: Pick<LearnedEntry, 'window' | 'maxPrompt' | 'maxBodyBytes' | 'tighten'> | null;
  /** count(head) when known (admitTokens needs it); null = unknown */
  counterFixedTokens?: number | null;
  /** ProcessOptions.extraTighten (request-local, retries only) */
  extraTighten?: number;
  /** rendered size of the ledger floor (§6.4), for summaryBudget; default 0 */
  floorTokens?: number;
}

/**
 * All §3 quantities (types.ts Budget). Values can be <= 0 for an unusable config; validate.ts turns that
 * into an error. `admitTokens` is null when admission is off or the head size is unknown and not configured.
 */
export function computeBudget(cfg: Config, inputs: BudgetInputs = {}): Budget {
  const E = inputs.learned ?? null;
  const tPlan = planMaxTokens(cfg);
  const tReq = inputs.tReq != null && inputs.tReq > 0 ? inputs.tReq : cfg.budget.defaultMaxTokens;
  const W = E?.window ?? cfg.budget.window;
  // ceil with the same 1e-9 epsilon as the floors: 0.03 · 100 is 3.0000000000000004 in IEEE
  const margin = Math.max(cfg.budget.safetyMarginTokens, Math.ceil(cfg.budget.safetyMarginFraction * W - 1e-9));
  const tighten = Math.max(0, E?.tighten ?? 0) + Math.max(0, inputs.extraTighten ?? 0);
  const maxPrompt = E?.maxPrompt ?? null;
  const budget = Math.min(W - tPlan - margin, maxPrompt === null ? Infinity : maxPrompt - margin) - tighten;
  const clientPoint =
    cfg.client.compactionPointTokens ?? W - Math.min(cfg.client.outputLimit ?? tPlan, cfg.client.outputTokenMax);
  const allowance = cfg.client.outputAllowanceTokens ?? Math.min(7000, Math.floor(tPlan / 2));
  const hard = Math.min(budget, clientPoint - allowance);
  const trigger = Math.min(cfg.compaction.triggerTokens ?? floorFrac(hard, cfg.compaction.triggerFraction), hard);
  const target = Math.min(cfg.compaction.targetTokens ?? floorFrac(trigger, cfg.compaction.targetFraction), trigger - 1);
  const limits = [cfg.upstream.maxBodyBytes, E?.maxBodyBytes ?? null].filter((x): x is number => x !== null);
  const byteLimit = limits.length ? Math.min(...limits) : null;
  const summaryBase = floorFrac(budget, cfg.compaction.summaryFraction);
  const summaryBudget = Math.max(0, Math.min(Math.max(inputs.floorTokens ?? 0, summaryBase), floorFrac(budget, cfg.compaction.summaryMaxFraction)));
  const head = inputs.counterFixedTokens ?? null;
  const admitTokens = !cfg.oversize.enabled || !cfg.oversize.admission
    ? null
    : cfg.oversize.admitTokens ?? (head === null ? null : Math.floor((budget - head - summaryBase) / 2));
  const headRoom = budget - summaryBase - (cfg.oversize.minTailTokens ?? floorFrac(budget, 0.25));
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
    mode: resolveBudgetMode(cfg),
    tighten,
    byteLimit,
    summaryBudget,
    admitTokens,
    headRoom,
  };
}

/** serverFits(x, M) of §3 for a counted prompt `count` and a forwarded max_tokens `M`. */
export function serverFits(b: Pick<Budget, 'mode' | 'window' | 'margin' | 'tighten'>, count: number, maxTokens: number): boolean {
  const limit = b.window - b.margin - b.tighten;
  switch (b.mode) {
    case 'strict_total':
      return count + maxTokens <= limit;
    case 'tgi':
      return count + Math.min(maxTokens, 1024) <= limit;
    default:
      return count <= limit;
  }
}

/**
 * Where the max_tokens clamp (§3, ) can decide: prompt counts c with min(trigger, budget) < c <= hi,
 * hi = min(W − margin − tighten − floorTokens, clientPoint − allowance − 1). `reachable` is false when the
 * range is empty or the mode is not strict_total; `reason` then says why.
 */
export function clampRange(cfg: Config, b: Budget): { lo: number; hi: number; reachable: boolean; reason: string | null } {
  const lo = Math.min(b.trigger, b.budget);
  const hi = Math.min(b.window - b.margin - b.tighten - cfg.budget.maxTokensClamp.floorTokens, b.clientPoint - b.allowance - 1);
  if (b.mode !== 'strict_total') return { lo, hi, reachable: false, reason: `server budget mode is ${b.mode}, the clamp needs strict_total` };
  if (hi <= lo) return { lo, hi, reachable: false, reason: `range (${lo}, ${hi + 1}) is empty` };
  return { lo, hi, reachable: true, reason: null };
}

/**
 * One-snapshot-per-epoch check (§3, ): room = trigger − (head + summaryBudget). `warn` when the room is
 * below the snapshot size, i.e. at most one snapshot fits per compaction epoch.
 */
export function snapshotRoom(b: Budget, headTokens: number, snapshotTokens: number): { room: number; warn: boolean } {
  const room = b.trigger - (headTokens + b.summaryBudget);
  return { room, warn: room < snapshotTokens };
}
