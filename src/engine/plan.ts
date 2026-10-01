// The fold and its step (DESIGN.md–§5.7).
//
//   f(H, P) = fold(step, emptyPlan(H, P), boundaries(H))
//
// step(plan, b) looks only at the virtual request H[0..b): head truncation (§5.7, once per (head, P)),
// admission (§5.5a), eager stubs (§5.5 ablation), then reuse when the assembled candidate fits (§3
// fits(c) and the byte limit), else the compaction step (§5.4): rewrite set, cut walk against target,
// summary at summaryBudget, the fit loop R1–R8, and the no-gain check (). Every step is a pure
// function of (plan, H[0..b), P); the memo store only skips steps (I5).
import type { Budget, ChatMessage, Plan, Rewrite } from '../types.js';
import { ENGINE_ALGO_VERSION } from '../types.js';
import type { Config } from '../config/schema.js';
import type { Summarizer, SummaryOptions, SummaryRender, ToolRules } from './contracts.js';
import { SUMMARY_HEADER } from './contracts.js';
import { assemble, type PlanShape } from './assemble.js';
import { fits, summaryBudgetFor } from './budget.js';
import { chainAt, planKey } from './canonical.js';
import type { Counting } from './count.js';
import type { Lru } from './lru.js';
import { hasReasoning, imageCount, isToolResult, isUnitStart, roleOf, withoutReasoning } from './message.js';
import {
  carryImageOmissions, contentTokens, cutAssistant, omitOneImage, slimText, truncateText,
} from './oversize.js';
import { admissionRewrites } from './admission.js';
import { isSnapshotResult, stubFor, supersededSnapshots, type ResultsEnv } from './results.js';
import { boundaries, headEnd, keptStart, unitsOf, type Unit } from './units.js';

/** Head rewrites and count(head) of one (head, P) (§5.7 head truncation, ). */
export interface HeadInfo {
  headRewrites: Record<number, Rewrite>;
  /** corrected count of the head as forwarded, template overhead (generation prompt, …) included */
  count: number;
}

export interface FoldDiag {
  steps: number;
  evaluations: number;
  summaryRenders: number;
  /** of the last compaction step */
  summaryBudget: number | null;
  floorTokens: number | null;
  /** count(head) at the last step */
  headCount: number | null;
}

/** Everything one fold needs; built per request by the engine. */
export interface FoldEnv {
  cfg: Config;
  rules: ToolRules;
  summarizer: Summarizer;
  cnt: Counting;
  bud: Budget;
  msgs: readonly ChatMessage[];
  digests: readonly string[];
  K: readonly string[];
  pHash: string;
  noClamp: boolean;
  res: ResultsEnv;
  headCache: Lru<string, HeadInfo>;
  diag: FoldDiag;
}

/** What a step did: nothing (reuse), admission only, a head truncation, eager stubs, or a compaction. */
export type StepKind = 'reuse' | 'admit' | 'head' | 'stub' | 'compact';

export interface StepResult {
  plan: Plan;
  kind: StepKind;
}

/** Evaluation of an assembled candidate. */
export interface Eval {
  out: ChatMessage[];
  ds: string[];
  /** per-message raw counts of `out` (the counter's attribution) and the rest */
  perMessage: number[];
  overhead: number;
  raw: number;
  count: number;
  bytes: number;
}

/** Converts a byte overshoot into tokens to cut (conservative: ~3 bytes per token). */
const BYTES_PER_TOKEN = 3;
/** Attempts per candidate in the room-based rungs (each is one evaluation). */
const MAX_TRIES = 6;

const EMPTY_USER: ChatMessage = Object.freeze({ role: 'user', content: '' }) as ChatMessage;

const KIND_RANK: Record<Rewrite['kind'], number> = { stub: 6, slim: 5, truncate: 4, image: 3, args: 2, reasoning: 1 };
const strongest = (a: Rewrite['kind'], b: Rewrite['kind'] | undefined): Rewrite['kind'] =>
  b !== undefined && KIND_RANK[b] > KIND_RANK[a] ? b : a;

// ---------------------------------------------------------------- empty plan, derive

/** The fold's initial plan: nothing summarized, no rewrites (§5.2). The head truncation is added by
 *  the first step, which knows the head. */
export function emptyPlan(env: FoldEnv): Plan {
  return {
    version: 2, engine: ENGINE_ALGO_VERSION, n: 0, hEnd: 0, cut: 0, summary: null,
    headRewrites: {}, rewrites: {}, compactions: 0, fit: 'ok',
    key: planKey(chainAt(env.K, 0), env.pHash),
  };
}

function derive(env: FoldEnv, p: Plan, b: number, h: number, patch: Partial<Plan>, kind: StepKind): Plan {
  return {
    ...p, ...patch, n: b, hEnd: h, cut: Math.max(patch.cut ?? p.cut, h),
    key: planKey(chainAt(env.K, b), env.pHash),
    meta: { ...(patch.meta ?? {}), step: kind },
  };
}

// ---------------------------------------------------------------- evaluation

/** Assembles `shape` onto H[0..b) and counts it as a standalone request. */
export function evaluate(env: FoldEnv, shape: PlanShape, b: number, h: number): Eval {
  env.diag.evaluations++;
  const a = assemble(shape, env.msgs, b, h, env.cfg);
  const ds = a.messages.map((m, k) => {
    const o = a.origin[k]!;
    return o >= 0 && m === env.msgs[o] ? env.digests[o]! : env.cnt.digest(m);
  });
  const meas = env.cnt.measure(a.messages, ds);
  const bytes = env.bud.byteLimit !== null ? env.cnt.bytes(a.messages, ds) : 0;
  return {
    out: a.messages, ds, perMessage: meas.perMessage, overhead: meas.overhead, raw: meas.total,
    count: env.cnt.count(meas.total), bytes,
  };
}

const bytesOver = (env: FoldEnv, ev: Eval): boolean => env.bud.byteLimit !== null && ev.bytes > env.bud.byteLimit;

/** Raw tokens to cut so that count ≤ F (and, with bytes, the byte limit holds); 0 when it fits. */
function overBy(env: FoldEnv, ev: Eval, F: number, withBytes: boolean): number {
  let o = ev.count > F ? env.cnt.rawOf(ev.count - F) : 0;
  if (withBytes && bytesOver(env, ev)) o = Math.max(o, Math.ceil((ev.bytes - env.bud.byteLimit!) / BYTES_PER_TOKEN));
  return o;
}

/** The step's reuse test: fits(c) (§3, with the clamp clause) and the byte limit. */
export const fitsNow = (env: FoldEnv, ev: Eval): boolean =>
  fits(env.cfg, env.bud, ev.count, env.noClamp) && !bytesOver(env, ev);

// ---------------------------------------------------------------- head (§5.7, )

/** Head truncation and count(head), computed once per (head, P) from the head alone. */
export function headInfo(env: FoldEnv, h: number): HeadInfo {
  const key = chainAt(env.K, h) + '|' + env.pHash;
  const hit = env.headCache.get(key);
  if (hit) return hit;
  const { cnt, msgs } = env;
  // The head is counted as a request of its own followed by an empty user message, so that templates
  // that need a user query (qwen3) accept a head without one; that message's piece is not counted.
  const measureHead = (hr: Record<number, Rewrite>): number => {
    const ms: ChatMessage[] = [];
    const ds: string[] = [];
    for (let i = 0; i < h; i++) {
      const m = hr[i]?.message ?? msgs[i]!;
      ms.push(m);
      ds.push(m === msgs[i] ? env.digests[i]! : cnt.digest(m));
    }
    ms.push(EMPTY_USER);
    ds.push(cnt.digest(EMPTY_USER));
    const meas = cnt.measure(ms, ds);
    let raw = meas.overhead;
    for (let i = 0; i < h; i++) raw += meas.perMessage[i]!;
    return cnt.count(raw);
  };
  let count = measureHead({});
  let hr: Record<number, Rewrite> = {};
  const room = env.bud.headRoom;
  if (env.cfg.oversize.headPolicy === 'truncate' && count > room) {
    let j = -1;
    for (let i = 0; i < h; i++) {
      if (roleOf(msgs[i]) === 'user') {
        j = i;
        break;
      }
    }
    if (j >= 0) {
      const orig = msgs[j]!;
      let over = cnt.rawOf(count - room);
      for (let t = 0; t < 4; t++) {
        const e = truncateText(orig, over, cnt);
        if (!e || !cnt.smaller(e.message, orig)) break;
        const cand: Record<number, Rewrite> = { [j]: { kind: 'truncate', stage: 'compaction', message: e.message } };
        const c2 = measureHead(cand);
        hr = cand;
        count = c2;
        if (c2 <= room || e.markerOnly) break;
        over += cnt.rawOf(c2 - room);
      }
    }
  }
  const info: HeadInfo = { headRewrites: hr, count };
  env.headCache.set(key, info);
  return info;
}

function sameRewrites(env: FoldEnv, a: Record<number, Rewrite>, b: Record<number, Rewrite> | Map<number, Rewrite>): boolean {
  const bm = b instanceof Map ? b : new Map(Object.entries(b).map(([k, v]) => [Number(k), v] as const));
  const ak = Object.keys(a);
  if (ak.length !== bm.size) return false;
  for (const k of ak) {
    const x = a[Number(k)]!;
    const y = bm.get(Number(k));
    if (!y || x.kind !== y.kind || (x.message !== y.message && env.cnt.digest(x.message) !== env.cnt.digest(y.message))) return false;
  }
  return true;
}

// ---------------------------------------------------------------- step (§5.2)

/** One fold step at boundary b; pb = the previous boundary (0 for the first). */
export function step(env: FoldEnv, plan: Plan, b: number, pb: number): StepResult {
  env.diag.steps++;
  const cfg = env.cfg;
  const h = headEnd(env.msgs, b, cfg.client);
  const hi = headInfo(env, h);
  env.diag.headCount = hi.count;
  let p = plan;
  let kind: StepKind = 'reuse';
  if (!sameRewrites(env, p.headRewrites, hi.headRewrites)) {
    kind = 'head';
    p = derive(env, p, b, h, { headRewrites: hi.headRewrites }, kind);
  }
  // 0. admission (§5.5a)
  const adm = admissionRewrites(env, p, b, Math.max(pb, h), hi.count);
  if (adm) {
    if (kind === 'reuse') kind = 'admit';
    p = derive(env, p, b, h, { rewrites: { ...p.rewrites, ...adm } }, kind);
  }
  // eager stubs (§5.5): the only I6 exception
  if (cfg.rules.snapshot.stub === 'eager') {
    const st = eagerStubs(env, p, b, h);
    if (st) {
      kind = 'stub';
      p = derive(env, p, b, h, { rewrites: { ...p.rewrites, ...st } }, kind);
    }
  }
  if (!cfg.compaction.enabled) return { plan: p, kind };
  // 1-2. reuse when the candidate fits
  const ev = evaluate(env, p, b, h);
  if (fitsNow(env, ev)) return { plan: p, kind };
  // 3. compaction
  return compact(env, p, b, h, ev, kind);
}

/** Stubs for snapshots in [cut, mandatory start) newly superseded at b (rules.snapshot.stub = 'eager'). */
function eagerStubs(env: FoldEnv, p: Plan, b: number, h: number): Record<number, Rewrite> | null {
  const units = unitsOf(env.msgs, h, b);
  const s = keptStart(units, 1, h);
  const from = Math.max(p.cut, h);
  let out: Record<number, Rewrite> | null = null;
  for (const i of supersededSnapshots(env.res, units, s)) {
    if (i < from || p.rewrites[i]?.kind === 'stub') continue;
    const m = stubFor(env.res, i);
    if (m) (out ??= {})[i] = { kind: 'stub', stage: 'compaction', message: m };
  }
  return out;
}

// ---------------------------------------------------------------- compaction step (§5.4)

interface Draft extends PlanShape {
  cut: number;
  summary: string | null;
  headRewrites: Record<number, Rewrite>;
  rewrites: Map<number, Rewrite>;
}

/** The compaction step at boundary b, where the candidate `cEv` of `planIn` does not fit. */
export function compact(env: FoldEnv, planIn: Plan, b: number, h: number, cEv: Eval, kindIn: StepKind): StepResult {
  const { cfg, cnt, msgs } = env;
  const bud = env.bud;
  const units = unitsOf(msgs, h, b);
  const s = keptStart(units, 1, h); // mandatory units start
  const ka = keptStart(units, cfg.compaction.keepRecent, h); // kept-always units start
  const V = msgs.slice(0, b);
  const Vd = env.digests.slice(0, b);
  const compaction = planIn.compactions + 1;
  const render = (cut: number, level: SummaryOptions): SummaryRender => {
    env.diag.summaryRenders++;
    const r = env.summarizer.render({ messages: V, digests: Vd, hEnd: h, cut, compaction }, level);
    // the plan's summary is null iff cut == hEnd (): never let a region go unsummarized
    return r.text === null ? { ...r, text: SUMMARY_HEADER } : r;
  };

  // summaryBudget, with floorTokens measured on [hEnd, s): the largest region this step can summarize
  // (budget 0: the render stops at the floor prefix, whose size is floorTokens; a larger budget would only search
  // longer prefixes that this call does not use)
  const floorTokens = s > h ? render(s, { budgetTokens: 0, allowFloorEviction: false, userShortenStep: 0 }).floorTokens : 0;
  const summaryBudget = summaryBudgetFor(cfg, bud.budget, floorTokens);
  env.diag.summaryBudget = summaryBudget;
  env.diag.floorTokens = floorTokens;

  // 1. rewrite set over [hEnd, b)
  const rw = new Map<number, Rewrite>();
  for (const [k, r] of Object.entries(planIn.rewrites)) {
    const i = Number(k);
    if (i >= h && i < b) rw.set(i, r);
  }
  const cur = (i: number): ChatMessage => rw.get(i)?.message ?? msgs[i]!;
  const setRw = (i: number, m: ChatMessage, kind: Rewrite['kind']): void => {
    rw.set(i, { kind: strongest(kind, rw.get(i)?.kind), stage: 'compaction', message: m });
  };
  if (cfg.rules.snapshot.stub !== 'off') {
    for (const i of supersededSnapshots(env.res, units, s)) {
      if (rw.get(i)?.kind === 'stub') continue;
      const m = stubFor(env.res, i);
      if (m) rw.set(i, { kind: 'stub', stage: 'compaction', message: m }); // stub > slim > truncate
    }
  }
  if (cfg.reasoning.tail === 'drop') {
    for (let i = h; i < b; i++) {
      if (roleOf(msgs[i]) === 'assistant' && hasReasoning(cur(i))) setRw(i, withoutReasoning(cur(i)), 'reasoning');
    }
  }

  // 2. cut walk: newest to oldest, keep the kept-always units, then older units while
  //    count(head) + summaryBudget + count(tail) ≤ target ()
  let cut: number;
  {
    // the candidate with the rewrite set and nothing summarized: position k is original index k
    const base = evaluate(env, { cut: h, summary: null, headRewrites: planIn.headRewrites, rewrites: rw }, b, h);
    const pm = base.perMessage;
    let headRaw = base.overhead;
    for (let i = 0; i < h; i++) headRaw += pm[i]!;
    const headCnt = cnt.count(headRaw);
    let tailRaw = 0;
    for (let i = ka; i < b; i++) tailRaw += pm[i]!;
    cut = ka;
    for (let u = units.findIndex((x) => x.start === ka) - 1; u >= 0; u--) {
      const unit = units[u]!;
      let add = 0;
      for (let i = unit.start; i < unit.end; i++) add += pm[i]!;
      if (headCnt + summaryBudget + cnt.count(tailRaw + add) > bud.target) break;
      tailRaw += add;
      cut = unit.start;
    }
    cut = Math.max(cut, planIn.cut, h);
  }
  const dropBelow = (c: number): void => {
    for (const i of [...rw.keys()]) if (i < c) rw.delete(i);
  };
  dropBelow(cut);

  // 3. summary of [hEnd, cut) at summaryBudget
  let level: SummaryOptions = { budgetTokens: summaryBudget, allowFloorEviction: false, userShortenStep: 0 };
  let S: SummaryRender | null = cut > h ? render(cut, level) : null;
  const draft: Draft = { cut, summary: S?.text ?? null, headRewrites: planIn.headRewrites, rewrites: rw };
  let ev = evaluate(env, draft, b, h);
  const rungs: string[] = [];
  const again = (): void => {
    draft.summary = S?.text ?? null;
    ev = evaluate(env, draft, b, h);
  };

  // 4. fit loop ()
  const F = bud.hard;
  const overF = (): number => overBy(env, ev, F, true);

  // R1: drop tail units, oldest first, down to the mandatory units; re-render S at the same level
  while (overF() > 0 && draft.cut < s) {
    const next = units.find((x) => x.start > draft.cut)?.start ?? s;
    draft.cut = Math.min(next, s);
    dropBelow(draft.cut);
    S = render(draft.cut, level);
    again();
    if (rungs[rungs.length - 1] !== 'R1') rungs.push('R1');
  }
  const r4 = (): void => {
    // R4: image parts of the mandatory units, oldest first
    for (let i = s; i < b && overF() > 0; i++) {
      while (overF() > 0 && imageCount(cur(i)) > 0) {
        const m = omitOneImage(cur(i));
        if (!m) break;
        setRw(i, m, 'image');
        again();
        if (!rungs.includes('R4')) rungs.push('R4');
      }
    }
  };
  // bytes drive the loop (tokens fit): R4 right after R1
  if (ev.count <= F && bytesOver(env, ev)) r4();

  // R2: evict tool log, then narrative tier 2 (the end of the priority order)
  while (S && overF() > 0) {
    const nb = Math.max(0, Math.min(level.budgetTokens - 1, S.tokens - overF()));
    const S2 = render(draft.cut, { ...level, budgetTokens: nb });
    if (S2.tokens >= S.tokens) break;
    // the level is the budget the summary now has: R2 cannot evict the floor, so a render asked for less than the
    // floor comes back at the floor size; recording the smaller request would make R6 (which starts from this
    // level) evict every floor item for an overshoot of a few tokens (; fuzz seed 4873)
    level = { ...level, budgetTokens: Math.max(nb, S2.tokens) };
    S = S2;
    again();
    if (!rungs.includes('R2')) rungs.push('R2');
  }

  // R3: oversize the tool results of the mandatory units: slim, then truncate, largest first
  if (cfg.oversize.enabled && overF() > 0) {
    const cands: Array<{ i: number; t: number }> = [];
    for (let i = s; i < b; i++) if (isToolResult(msgs[i]!)) cands.push({ i, t: contentTokens(cur(i), cnt) });
    cands.sort((x, y) => y.t - x.t || x.i - y.i);
    for (const { i } of cands) {
      if (overF() <= 0) break;
      const orig = msgs[i]!;
      let slimTried = false;
      let fullSlim: ChatMessage | null = null;
      for (let t = 0; t < MAX_TRIES && overF() > 0; t++) {
        const o = overF();
        const current = cur(i);
        const curT = contentTokens(current, cnt);
        if (!slimTried && cfg.rules.snapshot.slim && isSnapshotResult(env.res, i)) {
          slimTried = true;
          const sl = slimText(orig, curT - o, env.rules, cnt);
          if (sl && cnt.smaller(sl, current)) {
            setRw(i, sl, 'slim');
            again();
            if (!rungs.includes('R3')) rungs.push('R3');
            continue;
          }
          fullSlim = slimText(orig, Number.MAX_SAFE_INTEGER, env.rules, cnt);
        }
        const baseMsg = fullSlim ?? orig;
        const need = contentTokens(baseMsg, cnt) - (curT - o);
        if (need <= 0 && fullSlim && cnt.smaller(fullSlim, current)) {
          setRw(i, fullSlim, 'slim'); // the whole slim is enough
          again();
          if (!rungs.includes('R3')) rungs.push('R3');
          continue;
        }
        const e = truncateText(baseMsg, need, cnt);
        if (!e || !cnt.smaller(e.message, current)) break; // re-truncation keeps a smaller previous rewrite
        setRw(i, e.message, 'truncate');
        again();
        if (!rungs.includes('R3')) rungs.push('R3');
        if (e.markerOnly) break;
      }
    }
  }

  // R4 (token-driven)
  if (overF() > 0) r4();

  // R5: drop reasoning of the mandatory assistants (oldest first), then cut the newest assistant's
  //     content and tool-call argument strings
  if (overF() > 0) {
    let newest = -1;
    for (let i = s; i < b; i++) {
      if (roleOf(msgs[i]) !== 'assistant') continue;
      newest = i;
      if (overF() > 0 && hasReasoning(cur(i))) {
        setRw(i, withoutReasoning(cur(i)), 'reasoning');
        again();
        if (!rungs.includes('R5')) rungs.push('R5');
      }
    }
    for (let t = 0; newest >= 0 && t < MAX_TRIES && overF() > 0; t++) {
      const current = cur(newest);
      const base = withoutReasoning(carryImageOmissions(msgs[newest]!, current));
      const need = cnt.size(base) - (cnt.size(current) - overF());
      const m = cutAssistant(base, need, cnt);
      if (!m || !cnt.smaller(m, current)) break;
      setRw(newest, m, 'args');
      again();
      if (!rungs.includes('R5')) rungs.push('R5');
    }
  }

  // From here on only I2 matters: count(out) ≤ budget (the byte limit is soft)
  const B = bud.budget;
  const overB = (): number => overBy(env, ev, B, false);

  // R6: evict the ledger floor in reverse priority (narrative tier 1, rest, file, todo, decision)
  if (S && overB() > 0) {
    level = { ...level, allowFloorEviction: true };
    while (S && overB() > 0) {
      const nb = Math.max(0, Math.min(level.budgetTokens, S.tokens - overB()));
      const S2 = render(draft.cut, { ...level, budgetTokens: nb });
      if (S2.tokens >= S.tokens) break;
      level = { ...level, budgetTokens: nb };
      S = S2;
      again();
      if (!rungs.includes('R6')) rungs.push('R6');
    }
  }
  // R7: shorten user facts (userMaxChars → ½ → ¼); they are never evicted
  for (const st of [1, 2] as const) {
    if (!S || overB() <= 0) break;
    level = { ...level, allowFloorEviction: true, userShortenStep: st };
    S = render(draft.cut, level);
    again();
    if (!rungs.includes('R7')) rungs.push('R7');
  }
  // R8: truncate the text of the mandatory user units head+tail, largest first
  if (cfg.oversize.enabled && overB() > 0) {
    const cands: Array<{ i: number; t: number }> = [];
    for (let i = s; i < b; i++) {
      const m = msgs[i]!;
      if (isUnitStart(m) && roleOf(m) !== 'assistant') cands.push({ i, t: contentTokens(cur(i), cnt) });
    }
    cands.sort((x, y) => y.t - x.t || x.i - y.i);
    for (const { i } of cands) {
      for (let t = 0; t < MAX_TRIES && overB() > 0; t++) {
        const current = cur(i);
        const base = carryImageOmissions(msgs[i]!, current);
        const e = truncateText(base, contentTokens(base, cnt) - (contentTokens(current, cnt) - overB()), cnt);
        if (!e || !cnt.smaller(e.message, current)) break;
        setRw(i, e.message, 'truncate');
        again();
        if (!rungs.includes('R8')) rungs.push('R8');
        if (e.markerOnly) break;
      }
      if (overB() <= 0) break;
    }
  }

  const fit: Plan['fit'] = ev.count <= F ? 'ok' : ev.count <= B ? 'over_hard' : 'over_budget';

  // 4a. no-gain check (). DESIGN returns the input plan when count ≥ c and c ≤ budget; we also do
  // so when c > budget, so that a step never makes the candidate larger (I3).
  if (ev.count >= cEv.count) return { plan: planIn, kind: kindIn };
  // ... and never larger in bytes (I3 and the guard compare bytes too): on a tiny window the summary of a short
  // region can be longer in characters than the messages it replaces while a few tokens smaller, and the guard
  // then rejected the output (fuzz seeds 7205, 7248). Every later request carries the same byte offset.
  if (env.cnt.bytes(ev.out, ev.ds) > env.cnt.bytes(cEv.out, cEv.ds)) return { plan: planIn, kind: kindIn };
  const rewrites: Record<number, Rewrite> = {};
  for (const i of [...rw.keys()].sort((x, y) => x - y)) rewrites[i] = rw.get(i)!;
  const summary = S?.text ?? null;
  if (Math.max(planIn.cut, h) === draft.cut && planIn.summary === summary && sameRewrites(env, rewrites, planIn.rewrites)) {
    return { plan: planIn, kind: kindIn };
  }
  // 5. result
  const plan: Plan = {
    version: 2, engine: ENGINE_ALGO_VERSION, n: b, hEnd: h, cut: draft.cut, summary,
    headRewrites: planIn.headRewrites, rewrites, compactions: compaction, fit,
    key: planKey(chainAt(env.K, b), env.pHash),
    meta: {
      step: 'compact', count: ev.count, before: cEv.count, summaryBudget, floorTokens,
      summaryTokens: S?.tokens ?? 0, rungs: rungs.join(','), mandatoryStart: s,
    },
  };
  return { plan, kind: 'compact' };
}

// ---------------------------------------------------------------- fold

/** Store interface the fold needs (types.ts PlanStore). */
export interface FoldStore {
  get(key: string): Plan | undefined;
  set(key: string, plan: Plan): void;
}

export interface FoldResult {
  plan: Plan;
  /** what the step at the live boundary did ('reuse' when resumed there) */
  kind: StepKind;
  boundaries: number[];
  /** index into boundaries of the memo hit the fold resumed after (-1: from the empty plan) */
  resumedAt: number;
  steps: number;
}

/**
 * f(H, P): probes the memo at boundaries of H only, deepest first (), resumes after the first hit,
 * and stores the plan after every boundary it steps over (unless dryRun).
 */
export function fold(env: FoldEnv, store: FoldStore, dryRun: boolean): FoldResult {
  const bs = boundaries(env.msgs);
  let plan: Plan | undefined;
  let resumedAt = -1;
  for (let j = bs.length - 1; j >= 0; j--) {
    const p = store.get(planKey(chainAt(env.K, bs[j]!), env.pHash));
    if (p) {
      plan = p;
      resumedAt = j;
      break;
    }
  }
  let last: StepResult;
  if (plan && resumedAt === bs.length - 1) {
    // the live boundary itself was already planned (e.g. a repeated request)
    const k = plan.n === bs[resumedAt] ? plan.meta?.['step'] : 'reuse';
    last = { plan, kind: (typeof k === 'string' ? k : 'reuse') as StepKind };
  } else {
    last = { plan: plan ?? emptyPlan(env), kind: 'reuse' };
  }
  let steps = 0;
  for (let j = resumedAt + 1; j < bs.length; j++) {
    last = step(env, last.plan, bs[j]!, j > 0 ? bs[j - 1]! : 0);
    steps++;
    if (!dryRun) store.set(planKey(chainAt(env.K, bs[j]!), env.pHash), last.plan);
  }
  return { plan: last.plan, kind: last.kind, boundaries: bs, resumedAt, steps };
}

/** Units of H[0..b) (exported for tests and diagnostics). */
export function unitsAt(env: FoldEnv, b: number): { h: number; units: Unit[]; mandatory: number } {
  const h = headEnd(env.msgs, b, env.cfg.client);
  const units = unitsOf(env.msgs, h, b);
  return { h, units, mandatory: keptStart(units, 1, h) };
}
