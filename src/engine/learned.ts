// Learned entries as the engine applies them (DESIGN.md) and the planning inputs P
// with their hash. The proxy owns learning and persistence; the engine only reads an
// entry, validates it against the current config and counter, and plans with it.
import type { ChatRequest, LearnedEntry, PlanningInputs, TokenCounter } from '../types.js';
import { ENGINE_ALGO_VERSION } from '../types.js';
import type { Config } from '../config/schema.js';
import { canonicalJSON, sha256Hex } from './canonical.js';

/** A fresh entry for the current config and counter (no learned limits, correction 1). */
export function defaultLearnedEntry(cfg: Config, counterId: string): LearnedEntry {
  return {
    configuredWindow: cfg.budget.window,
    counterId,
    window: null,
    maxPrompt: null,
    maxBodyBytes: null,
    tighten: 0,
    tightenLog: [],
    correction: 1,
    samples: 0,
    meanRatio: 1,
    ratios: [],
    pendingTighten: [],
    includeUsageRejected: false,
    updatedAt: null,
  };
}

/** An entry is discarded when it was learned under another window or counter. */
export function learnedValid(e: LearnedEntry, cfg: Config, counterId: string): boolean {
  return e.configuredWindow === cfg.budget.window && e.counterId === counterId;
}

/**
 * `${origin}|${model}`: the learned-state key of a request. The origin is normalised (URL
 * origin plus path without trailing slashes) so `http://H:80/v1/` and `http://h/v1` share one entry.
 */
export function learnedKey(origin: string | null, model: unknown): string {
  let o = origin ?? '';
  try {
    const u = new URL(o);
    o = u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    /* not a URL: used as is */
  }
  return `${o}|${typeof model === 'string' ? model : ''}`;
}

/** Correction as an integer percentage: ceil to 1%, never below 100 (correction ≥ 1). */
export function correctionPct(e: LearnedEntry): number {
  const c = typeof e.correction === 'number' && Number.isFinite(e.correction) ? e.correction : 1;
  return Math.max(100, Math.ceil(c * 100 - 1e-9));
}

/** Effective chat_template_kwargs: the request's booleans over tokenizer.template defaults. */
export function templateKwargs(cfg: Config, req: ChatRequest): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const t = cfg.tokenizer.template;
  if (t.enableThinking !== null) out['enable_thinking'] = t.enableThinking;
  if (t.preserveThinking !== null) out['preserve_thinking'] = t.preserveThinking;
  const kw = req['chat_template_kwargs'];
  if (typeof kw === 'object' && kw !== null && !Array.isArray(kw)) {
    const k = kw as Record<string, unknown>;
    if (typeof k['enable_thinking'] === 'boolean') out['enable_thinking'] = k['enable_thinking'];
    if (typeof k['preserve_thinking'] === 'boolean') out['preserve_thinking'] = k['preserve_thinking'];
  }
  return out;
}

/**
 * Hash of every config value that affects planning: budget, client, compaction, oversize,
 * rules, ledger, reasoning, the tokenizer template/fallback/image cost, the server mode inputs, and the
 * counter identity. `noClamp` (a ProcessOptions switch) changes the fit predicate, so it is folded in.
 */
export function configPlanHash(cfg: Config, counterId: string, noClamp: boolean): string {
  const t = cfg.tokenizer;
  return sha256Hex(
    canonicalJSON({
      budget: cfg.budget,
      client: cfg.client,
      compaction: cfg.compaction,
      oversize: cfg.oversize,
      rules: cfg.rules,
      ledger: cfg.ledger,
      reasoning: cfg.reasoning,
      server: cfg.server,
      tokenizer: { mode: t.mode, template: t.template, fallback: t.fallback, imageTokens: t.imageTokens },
      counterId,
      noClamp,
    }),
  );
}

/** tokenizer sha256 from the counter id (`…;tok=<sha>;…`), when the caller did not supply it. */
export function tokenizerShaFromId(counterId: string): string | null {
  const m = /;tok=([0-9a-f]{64})(?:;|$)/.exec(counterId);
  return m ? m[1]! : null;
}

/** bytes(canonical tools) + 512. */
export function fixedBytesOf(tools: unknown, canonicalTools?: string): number {
  if (!(Array.isArray(tools) && tools.length)) return 512;
  return Buffer.byteLength(canonicalTools ?? canonicalJSON(tools), 'utf8') + 512;
}

export interface InputsArgs {
  cfg: Config;
  /** configPlanHash(cfg, counter.id, noClamp), when the caller memoizes it */
  configHash?: string;
  counter: TokenCounter;
  tokenizerSha256: string | null;
  req: ChatRequest;
  E: LearnedEntry;
  tighten: number;
  window: number;
  tPlan: number;
  byteLimit: number | null;
  noClamp: boolean;
}

/** P for one request. T_req is deliberately absent. */
export function planningInputs(a: InputsArgs): PlanningInputs {
  const mode = a.counter.mode === 'exact' ? 'exact' : 'estimate';
  const tools = Array.isArray(a.req.tools) ? a.req.tools : null;
  const canonicalTools = canonicalJSON(tools);
  return {
    engineVersion: ENGINE_ALGO_VERSION,
    configPlanHash: a.configHash ?? configPlanHash(a.cfg, a.counter.id, a.noClamp),
    tokenizerSha256: mode === 'exact' ? a.tokenizerSha256 : null,
    counterMode: mode,
    templateName: a.cfg.tokenizer.template.name,
    templateKwargs: canonicalJSON(templateKwargs(a.cfg, a.req)),
    tPlan: a.tPlan,
    window: a.window,
    maxPrompt: a.E.maxPrompt,
    tighten: a.tighten,
    correction: correctionPct(a.E) / 100,
    maxBodyBytes: a.byteLimit,
    toolsDigest: sha256Hex(canonicalTools),
    fixedBytes: fixedBytesOf(tools, canonicalTools),
  };
}
