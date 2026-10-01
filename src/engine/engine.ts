// LeanEngine: engine.process(req, opts) — pure and synchronous, local counts only (DESIGN.md, §5).
//
//   digests → chain → P → fold over boundaries (memo) → assemble the live output → action and forwarded
//   max_tokens (§3) → §5.7 for a final plan over budget → guard (§5.8) → result
//
// Any exception or failed guard falls back per : attempt 1 forwards the original only if counting
// failed or serverFits(original, T_req); otherwise (and on every retry) the §5.7 400 is returned.
import type {
  Budget, ChatMessage, ChatRequest, Engine, EngineAction, EngineResult, EngineStats, LearnedEntry, Plan, PlanStore,
  ProcessOptions, TokenCounter,
} from '../types.js';
import type { Config } from '../config/schema.js';
import type { ResultKind, Summarizer, ToolRules } from './contracts.js';
import {
  clampClause, computeBudget, decideMaxTokens, maxTokensFields, requestedMaxTokens, serverFits, serverLimit,
  type MaxTokensDecision,
} from './budget.js';
import { chainAt, chainKeys, DigestCache, inputsHash } from './canonical.js';
import { Counting, TextTokenCache, type MessageCaches } from './count.js';
import { InjectedFault, parseFaults, shouldThrow, type Faults } from './faults.js';
import { guardCheck } from './guard.js';
import { contextLengthExceeded, fixedPromptTooLarge, type ErrorBody } from './impossible.js';
import {
  configPlanHash, correctionPct, defaultLearnedEntry, learnedKey, learnedValid, planningInputs, templateKwargs, tokenizerShaFromId,
} from './learned.js';
import { Lru } from './lru.js';
import { roleOf } from './message.js';
import { admitTokensFor } from './admission.js';
import { evaluate, fold, headInfo, type FoldEnv, type HeadInfo, type StepKind } from './plan.js';
import { MemoryPlanStore } from './store.js';
import { headEnd } from './units.js';

export interface EngineDeps {
  counter: TokenCounter;
  summarizer: Summarizer;
  rules: ToolRules;
  /** memo store (default: an in-memory LRU with the config caps and no persistence) */
  store?: PlanStore;
  /** clock in milliseconds for engineMs (default performance.now) */
  now?: () => number;
  /** tokenizer identity for P (default: parsed from counter.id) */
  tokenizerSha256?: string | null;
  /** fault spec (default: process.env.KITZUR_TEST_FAULTS) */
  faults?: string | null;
}

export interface EngineOptions extends EngineDeps {
  config: Config;
}

/** Diagnostics of the last process() call (tests and benchmarks; never content). */
export interface EngineTrace {
  steps: number;
  evaluations: number;
  summaryRenders: number;
  measures: number;
  resumedAt: number;
  boundaries: number;
  stepKind: StepKind | null;
  /** hash(P) of the request (an I6 epoch ends when it changes) */
  pHash: string;
}

const EMPTY_USER: ChatMessage = Object.freeze({ role: 'user', content: '' }) as ChatMessage;

const validMessages = (msgs: unknown): msgs is ChatMessage[] =>
  Array.isArray(msgs) &&
  msgs.length > 0 &&
  msgs.every((m) => typeof m === 'object' && m !== null && !Array.isArray(m) && typeof (m as ChatMessage).role === 'string');

// Text/size/byte caches are a pure function of (counter, key), so engines built on the same counter
// share them (a restarted engine in tests, several engines in one process).
const cachesByCounter = new WeakMap<TokenCounter, MessageCaches>();
function cachesFor(counter: TokenCounter, cap: number): MessageCaches {
  let c = cachesByCounter.get(counter);
  if (!c) {
    c = { size: new Lru(cap), bytes: new Lru(cap), text: new TextTokenCache(32 * 1024 * 1024, cap) };
    cachesByCounter.set(counter, c);
  }
  return c;
}

const planChangesSomething = (p: Plan): boolean =>
  p.summary !== null || Object.keys(p.rewrites).length > 0 || Object.keys(p.headRewrites).length > 0;

/** The engine (types.ts Engine). One instance serves every session; plans are keyed by content. */
export class LeanEngine implements Engine {
  readonly config: Config;
  readonly counter: TokenCounter;
  readonly store: PlanStore;
  /** diagnostics of the last call */
  lastTrace: EngineTrace | null = null;
  private readonly summarizer: Summarizer;
  private readonly rules: ToolRules;
  private readonly now: () => number;
  private readonly tokenizerSha: string | null;
  private readonly faults: Faults | null;
  private readonly learnedMap = new Map<string, LearnedEntry>();
  private readonly digests = new DigestCache();
  private readonly msgCaches: MessageCaches;
  private readonly classify: Lru<string, ResultKind>;
  private readonly stubs: Lru<string, ChatMessage | null>;
  private readonly headCache: Lru<string, HeadInfo>;
  /** chain key of a processed boundary -> hash(P) it was planned under (replan diagnostics) */
  private readonly chainIndex: Lru<string, string>;
  /** configPlanHash with and without noClamp (the config is fixed for the engine's lifetime) */
  private readonly configHash: [string, string];

  constructor(o: EngineOptions) {
    if (o.counter.mode === 'remote') {
      throw new Error("kitzur engine: counter mode 'remote' is a calibration source only; the engine needs 'exact' or 'estimate' (DESIGN §4, )");
    }
    this.config = o.config;
    this.counter = o.counter;
    this.summarizer = o.summarizer;
    this.rules = o.rules;
    this.store = o.store ?? new MemoryPlanStore({ maxPlans: o.config.store.maxPlans, maxBytes: o.config.store.maxBytes });
    this.now = o.now ?? (() => performance.now());
    this.tokenizerSha = o.tokenizerSha256 ?? tokenizerShaFromId(o.counter.id);
    this.faults = parseFaults(o.faults === undefined ? process.env['KITZUR_TEST_FAULTS'] : o.faults);
    const cap = Math.max(1024, Math.min(200_000, o.config.tokenizer.cacheEntries));
    this.msgCaches = cachesFor(o.counter, cap);
    this.classify = new Lru(cap);
    this.stubs = new Lru(4096);
    this.headCache = new Lru(256);
    this.chainIndex = new Lru(Math.max(1024, o.config.store.maxPlans * 4));
    this.configHash = [configPlanHash(o.config, o.counter.id, false), configPlanHash(o.config, o.counter.id, true)];
  }

  learned(key: string): LearnedEntry {
    const e = this.learnedMap.get(key);
    return e && learnedValid(e, this.config, this.counter.id) ? e : defaultLearnedEntry(this.config, this.counter.id);
  }

  setLearned(key: string, e: LearnedEntry): void {
    this.learnedMap.set(key, e);
  }

  process(req: ChatRequest, opts: ProcessOptions): EngineResult {
    const t0 = this.now();
    const cfg = this.config;
    const attempt = Math.max(1, Math.floor(opts?.attempt ?? 1));
    const noClamp = opts?.noClamp === true;
    const given = opts?.learned;
    const E = given && learnedValid(given, cfg, this.counter.id) ? given : this.learned(learnedKey(cfg, req));
    const tReq = requestedMaxTokens(req, cfg);
    const bud = computeBudget(cfg, E, opts?.extraTighten ?? 0, tReq);
    const msgs = req.messages;
    this.lastTrace = null;

    // ---- count the original (a failure here is "counting failed", §5.8)
    let cnt: Counting;
    let digests: string[];
    let countIn: number;
    let P: ReturnType<typeof planningInputs>;
    try {
      if (!validMessages(msgs)) throw new Error('invalid messages');
      P = planningInputs({
        cfg, counter: this.counter, tokenizerSha256: this.tokenizerSha, req, E, tighten: bud.tighten, window: bud.window,
        tPlan: bud.planMaxTokens, byteLimit: bud.byteLimit, noClamp, configHash: this.configHash[noClamp ? 1 : 0],
      });
      const kw = templateKwargs(cfg, req);
      cnt = new Counting({
        counter: this.counter,
        tools: Array.isArray(req.tools) ? req.tools : undefined,
        kwargs: Object.keys(kw).length ? kw : null,
        corrPct: correctionPct(E),
        fixedBytes: P.fixedBytes,
        imageTokens: cfg.tokenizer.imageTokens,
        headShare: cfg.oversize.headShare,
        digests: this.digests,
        caches: this.msgCaches,
      });
      digests = this.digests.all(msgs);
      countIn = cnt.count(cnt.measure(msgs, digests).total);
    } catch {
      return this.fallback(req, attempt, bud, null, t0, 'counting_failed');
    }

    try {
      const n = msgs.length;
      const K = chainKeys(digests);
      if (shouldThrow(this.faults, chainAt(K, n), attempt)) throw new InjectedFault();
      const pHash = inputsHash(P);
      const env: FoldEnv = {
        cfg, rules: this.rules, summarizer: this.summarizer, cnt, bud, msgs, digests, K, pHash, noClamp,
        res: { msgs, digests, rules: this.rules, classify: this.classify, size: (m) => cnt.size(m), stubs: this.stubs },
        headCache: this.headCache,
        diag: { steps: 0, evaluations: 0, summaryRenders: 0, summaryBudget: null, floorTokens: null, headCount: null },
      };
      const fr = fold(env, this.store, opts?.dryRun === true);

      // replan diagnostics (): why the memo did not resume at the previous boundary
      let replan: EngineResult['replan'];
      if (fr.resumedAt < fr.boundaries.length - 2) {
        let other = false;
        let same = false;
        for (const b of fr.boundaries) {
          const ph = this.chainIndex.peek(chainAt(K, b));
          if (ph === undefined) continue;
          if (ph === pHash) same = true;
          else other = true;
        }
        replan = other ? 'inputs_changed' : same ? 'client_mutation' : 'new_session';
      }
      if (!opts?.dryRun) for (const b of fr.boundaries) this.chainIndex.set(chainAt(K, b), pHash);

      // ---- the live output
      const h = headEnd(msgs, n, cfg.client);
      const hi = headInfo(env, h);
      const ev = evaluate(env, fr.plan, n, h);
      const out = ev.out;
      const cOut = ev.count;
      bud.admitTokens = admitTokensFor(env, hi.count);
      if (env.diag.summaryBudget !== null) bud.summaryBudget = env.diag.summaryBudget;

      let action: EngineAction;
      let mt: MaxTokensDecision;
      let overBudgetAllowed = false;
      const lastWasReuse = fr.kind === 'reuse' || fr.kind === 'admit';
      const clampOk = clampClause(cfg, bud, cOut, noClamp);
      const stepAction = (): EngineAction =>
        fr.kind === 'admit' ? 'admit' : fr.kind === 'reuse' ? (planChangesSomething(fr.plan) ? 'reuse' : 'passthrough') : 'compact';
      let error: EngineResult['error'];
      let impossibleKind: EngineResult['impossibleKind'];
      if (cOut <= bud.budget) {
        const clamped = lastWasReuse && cOut > Math.min(bud.trigger, bud.budget) && clampOk;
        mt = decideMaxTokens(cfg, bud, cOut, clamped);
        action = clamped && mt.kind === 'clamp' ? 'clamp' : stepAction();
        if (action !== 'clamp' && mt.kind === 'restore' && (action === 'reuse' || action === 'passthrough')) action = 'restore';
      } else if (lastWasReuse && clampOk) {
        mt = decideMaxTokens(cfg, bud, cOut, true);
        action = 'clamp';
        overBudgetAllowed = true;
      } else {
        // §5.7: the final plan is over budget
        const floorT = cfg.budget.maxTokensClamp.floorTokens;
        const lim = serverLimit(bud);
        let aOk: boolean;
        let Mp: number;
        if (bud.mode === 'strict_total') {
          Mp = Math.min(tReq, lim - cOut);
          aOk = Mp >= Math.min(floorT, tReq) && Mp > 0;
        } else {
          Mp = tReq;
          aOk = serverFits(bud, cOut, tReq);
        }
        if (aOk) {
          action = 'truncate';
          mt = { value: Mp, kind: Mp < tReq ? 'fit' : 'unchanged' };
          overBudgetAllowed = true;
        } else {
          action = 'impossible';
          mt = { value: tReq, kind: 'unchanged' };
          const fixed = this.fixedCount(cnt, msgs, digests);
          const fixedReserve = bud.mode === 'strict_total' ? floorT : bud.mode === 'tgi' ? Math.min(floorT, 1024) : 0;
          let body: ErrorBody;
          if (!serverFits(bud, fixed, floorT)) {
            impossibleKind = 'fixed';
            body = fixedPromptTooLarge(fixed, lim - fixedReserve, bud.window, fixedReserve);
          } else {
            impossibleKind = 'content';
            const reserve = bud.mode === 'strict_total' ? Math.min(floorT, tReq) : bud.mode === 'tgi' ? Math.min(tReq, 1024) : 0;
            body = contextLengthExceeded(cOut, lim - reserve, bud.window, reserve);
          }
          error = { status: 400, body };
        }
      }

      // a final plan over budget (§5.7) is reported as such; the memo keeps the plan as the fold made it
      const plan = cOut > bud.budget && action !== 'clamp' && fr.plan.fit !== 'over_budget' ? { ...fr.plan, fit: 'over_budget' as const } : fr.plan;
      const maxTokens = mt.kind === 'unchanged' ? null : { value: mt.value, fields: maxTokensFields(req) };
      const msgsChanged = out.length !== n || out.some((m, i) => m !== msgs[i]);
      const stats = this.stats(n, out.length, countIn, cOut, bud, plan, ev, h, fr.steps, fr.resumedAt >= 0 ? 1 : 0, t0);
      this.lastTrace = {
        steps: fr.steps, evaluations: env.diag.evaluations, summaryRenders: env.diag.summaryRenders, measures: cnt.measures,
        resumedAt: fr.resumedAt, boundaries: fr.boundaries.length, stepKind: fr.kind, pHash,
      };
      const sessionKey = chainAt(K, h);

      if (action === 'impossible') {
        if (cfg.shadow) return this.shadow(req, plan, sessionKey, stats, replan, 'impossible');
        return {
          action, request: null, changed: false, maxTokens: null, plan, sessionKey, stats, error, impossibleKind,
          reason: `impossible:${impossibleKind}`, ...(replan ? { replan } : {}),
        };
      }

      // ---- guard (§5.8)
      const exempt = new Set<number>(Object.keys(plan.headRewrites).map(Number));
      if (plan.summary !== null && cfg.compaction.summaryRole === 'merge-into-first-user') {
        const j = out.findIndex((m) => roleOf(m) === 'user');
        if (j >= 0 && j < h) exempt.add(j);
      }
      const bytesIn = cnt.bytes(msgs, digests);
      const bytesOut = msgsChanged ? cnt.bytes(out, ev.ds) : bytesIn;
      const g = guardCheck({
        input: msgs, output: out, inDigests: digests, outDigests: ev.ds, hEnd: h, exempt, countIn, countOut: cOut,
        bytesIn, bytesOut, budget: bud, maxTokens: maxTokens?.value ?? tReq, overBudgetAllowed,
      });
      if (g !== null) {
        stats.guard = g;
        return this.fallback(req, attempt, bud, countIn, t0, 'guard:' + g, plan, replan);
      }
      if (cfg.shadow) return this.shadow(req, plan, sessionKey, stats, replan, action);

      let request: ChatRequest = req;
      if (msgsChanged || maxTokens) {
        request = { ...req, messages: msgsChanged ? out : msgs };
        if (maxTokens) for (const f of maxTokens.fields) request[f] = maxTokens.value;
      }
      stats.engineMs = this.now() - t0;
      return {
        action, request, changed: request !== req, maxTokens, plan, sessionKey, stats,
        reason: `${action}${plan.fit !== 'ok' ? ':' + plan.fit : ''}`, ...(replan ? { replan } : {}),
      };
    } catch (e) {
      const why = e instanceof InjectedFault ? 'engine:fault' : 'engine:exception';
      return this.fallback(req, attempt, bud, countIn, t0, why);
    }
  }

  /** count(system + tools): the system message (if first) and the tools block, no conversation. */
  private fixedCount(cnt: Counting, msgs: ChatMessage[], digests: string[]): number {
    const sys = msgs.length && (roleOf(msgs[0]) === 'system' || roleOf(msgs[0]) === 'developer');
    const ms = sys ? [msgs[0]!, EMPTY_USER] : [EMPTY_USER];
    const ds = sys ? [digests[0]!, cnt.digest(EMPTY_USER)] : [cnt.digest(EMPTY_USER)];
    const meas = cnt.measure(ms, ds);
    return cnt.count(meas.overhead + (sys ? meas.perMessage[0]! : 0));
  }

  private stats(
    nIn: number, nOut: number, tIn: number, tOut: number, bud: Budget, plan: Plan,
    ev: { perMessage: number[]; out: ChatMessage[] }, h: number, steps: number, hits: number, t0: number,
  ): EngineStats {
    let summaryTokens = 0;
    if (plan.summary !== null) {
      const k = ev.out.findIndex((m, i) => i >= h && roleOf(m) === 'user' && m.content === plan.summary);
      if (k >= 0) summaryTokens = ev.perMessage[k] ?? 0;
    }
    const lo = Math.max(plan.cut, h);
    let rewrites = Object.keys(plan.headRewrites).length;
    for (const k of Object.keys(plan.rewrites)) if (Number(k) >= lo && Number(k) < nIn) rewrites++;
    const floor = plan.meta?.['floorTokens'];
    return {
      messagesIn: nIn, messagesOut: nOut, tokensIn: tIn, tokensOut: tOut, budget: bud, compactions: plan.compactions,
      summaryTokens, ledgerTokens: typeof floor === 'number' ? floor : 0, rewrites, boundariesReplayed: steps,
      cacheHits: hits, engineMs: this.now() - t0,
    };
  }

  private shadow(
    req: ChatRequest, plan: Plan | null, sessionKey: string, stats: EngineStats, replan: EngineResult['replan'], would: EngineAction,
  ): EngineResult {
    return {
      action: 'shadow', request: req, changed: false, maxTokens: null, plan, sessionKey, stats,
      reason: `shadow:${would}`, ...(replan ? { replan } : {}),
    };
  }

  /**
   * : attempt 1 forwards the original when counting failed or serverFits(original, T_req); otherwise,
   * and on every retry, the §5.7 context_length_exceeded 400 (the proxy substitutes the last upstream
   * error on retries, §5.8).
   */
  private fallback(
    req: ChatRequest, attempt: number, bud: Budget, countIn: number | null, t0: number, reason: string,
    plan: Plan | null = null, replan?: EngineResult['replan'],
  ): EngineResult {
    const n = Array.isArray(req.messages) ? req.messages.length : 0;
    const tReq = bud.maxTokensRequested;
    const stats: EngineStats = {
      messagesIn: n, messagesOut: n, tokensIn: countIn ?? 0, tokensOut: countIn ?? 0, budget: bud,
      compactions: plan?.compactions ?? 0, summaryTokens: 0, ledgerTokens: 0, rewrites: 0, boundariesReplayed: 0,
      cacheHits: 0, engineMs: this.now() - t0, guard: reason,
    };
    const sessionKey = '';
    // shadow mode observes only: it never blocks a request
    if (this.config.shadow) return this.shadow(req, plan, sessionKey, stats, replan, attempt <= 1 && (countIn === null || serverFits(bud, countIn, tReq)) ? 'guard_fallback' : 'guard_reject');
    if (attempt <= 1 && (countIn === null || serverFits(bud, countIn, tReq))) {
      return { action: 'guard_fallback', request: req, changed: false, maxTokens: null, plan, sessionKey, stats, reason, ...(replan ? { replan } : {}) };
    }
    const lim = serverLimit(bud);
    const reserve = bud.mode === 'strict_total' ? tReq : bud.mode === 'tgi' ? Math.min(tReq, 1024) : 0;
    stats.messagesOut = 0;
    return {
      action: 'guard_reject', request: null, changed: false, maxTokens: null, plan, sessionKey, stats,
      error: { status: 400, body: contextLengthExceeded(countIn ?? 0, lim - reserve, bud.window, reserve) },
      reason, ...(replan ? { replan } : {}),
    };
  }
}

/** createEngine(config, deps): the engine for a loaded config. */
export function createEngine(config: Config, deps: EngineDeps): LeanEngine {
  return new LeanEngine({ config, ...deps });
}
