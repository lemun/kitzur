// The fuzz invariants (bench/README.md; DESIGN.md) over one live chain, with the production engine
// (createEngine + the real summarizer and tool rules) and the independent oracle of oracle.ts.
//
//   I1  output pairing-defect multiset ⊆ the input's (and pairing_intact(in) ⇒ pairing_intact(out))
//   I2  oracleCount(out) ≤ budget, or (clamp / §5.7 truncate) serverFits(out, forwarded M); an impossible or
//       attempt-1 guard_reject only when the original itself fails serverFits(original, T_req); the engine's
//       own count equals the oracle's
//   I3  tokens, messages and bytes of out ≤ those of the input
//   I4  head digests equal, except plan.headRewrites (and merge-into-first-user)
//   I5  live == a fresh engine for the same request; == a fresh engine replaying from a random midpoint with a
//       cold counter; == an engine restarted on the JSONL file store; == engines with store caps 1–4; : a
//       fresh engine on H[0..b) == the live fold's plan at b (dry run) for sampled boundaries b
//   I6  within an epoch (same hash(P), same compactions, append-only client) out_k's digests prefix out_{k+1}'s
//   I7  under engine-throw faults: a faulted attempt 1 forwards the original iff serverFits(original, T_req) (or
//       counting failed), else the 400; attempt 2 never forwards the original; unfaulted results == live
//    no floor ledger item is evicted while F − count(out) is at least its rendered cost (below the
//       summaryMaxFraction cap)
//
// Violations are collected (never thrown) so that a run reports all of them with seeds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Budget, ChatMessage, ChatRequest, EngineResult, LearnedEntry, Plan, PlanStore, TokenCounter } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { createEngine, type LeanEngine } from '../../src/engine/engine.js';
import { MemoryPlanStore } from '../../src/engine/store.js';
import { createFilePersistence } from '../../src/engine/store-file.js';
import { createSummarizerExt } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { ffloor } from '../../src/engine/budget.js';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import type { Tokenizer } from '../../src/tokenize/tokenizer.js';
import type { FuzzChain } from './gen.js';
import { Rng } from './gen.js';
import {
  bytesOf, corrected, corrPctOf, createOracle, defectSubset, digest, OracleCountError, oracleDefects, oracleHeadEnd, pairingIntact,
  type Oracle,
} from './oracle.js';

export interface Violation {
  inv: string;
  seed: number;
  request: number;
  detail: string;
}

/** Coverage flags of one chain (a path counts when any request of the chain took it). */
export const COVERAGE_KEYS = [
  'compact', 'admission', 'oversize', 'slim', 'stub', 'headTruncate', 'impossible', 'impossibleFixed', 'truncate', 'clamp', 'restore',
  'guard', 'guardFault', 'countingFailed', 'overBudget', 'overHard', 'multiCompact', 'reasoningDrop', 'image', 'args', 'bytes',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'i6pair', 'clientSummaryHead', 'mutation', 'clientCompact', 'learned', 'kwargs',
] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

export interface ChainOutcome {
  seed: number;
  requests: number;
  violations: Violation[];
  cov: Partial<Record<CoverageKey, true>>;
  /** checks performed (diagnostics) */
  checks: { fresh: number; boundaryReplay: number; i6pairs: number; faults: number; ledgerFit: number; retries: number };
  ms: number;
  window: number;
  template: string;
  mode: string;
  preset: string | null;
}

export interface CheckOptions {
  /** fresh-engine comparison every k-th request (and the last); 0 = none */
  freshEvery: number;
  /**  boundaries checked (evenly spread, the last included) */
  boundaryReplay: number;
  caps: boolean;
  restart: boolean;
  /** I7 fault pass with this engine-throw probability (0 = none) */
  faults: number;
  ledgerFit: boolean;
}

export const DEFAULT_CHECKS: CheckOptions = { freshEvery: 1, boundaryReplay: 6, caps: true, restart: true, faults: 0.01, ledgerFit: true };

/** What must be identical between a live chain and any replay (timing and memo diagnostics excluded). */
export const essence = (r: EngineResult): string =>
  canonicalJSON({
    action: r.action, request: r.request, maxTokens: r.maxTokens, plan: r.plan, error: r.error ?? null, impossibleKind: r.impossibleKind ?? null,
  });

const limOf = (b: Budget): number => b.window - b.margin - b.tighten;
function serverFits(b: Budget, c: number, M: number): boolean {
  if (b.mode === 'strict_total') return c + M <= limOf(b);
  if (b.mode === 'tgi') return c + Math.min(M, 1024) <= limOf(b);
  return c <= limOf(b);
}
export const tReqOf = (req: ChatRequest, def: number): number => {
  const v = [req.max_tokens, req.max_completion_tokens].filter((x): x is number => typeof x === 'number' && x > 0);
  return v.length ? Math.max(...v) : def;
};

export function counterFor(c: FuzzChain, tok: Tokenizer | null): TokenCounter {
  return counterFromConfig(c.cfg, { tokenizer: c.mode === 'exact' ? tok : null, tokenizerId: c.mode === 'exact' && tok ? 'fuzz-tokenizer' : null });
}

export function engineFor(cfg: Config, counter: TokenCounter, extra: { store?: PlanStore; faults?: string | null } = {}): LeanEngine {
  return createEngine(cfg, { counter, summarizer: createSummarizerExt(cfg, counter), rules: createToolRules(cfg), faults: null, ...extra });
}

const optsFor = (c: FuzzChain, k: number, counter: TokenCounter): { attempt: number; learned?: LearnedEntry } => {
  const l = c.learned[k];
  return l ? { attempt: 1, learned: { ...l, counterId: counter.id } } : { attempt: 1 };
};

/** Checks of one live chain. */
export function checkChain(c: FuzzChain, tok: Tokenizer | null, o: CheckOptions = DEFAULT_CHECKS): ChainOutcome {
  const t0 = performance.now();
  const violations: Violation[] = [];
  const cov: Partial<Record<CoverageKey, true>> = {};
  const checks = { fresh: 0, boundaryReplay: 0, i6pairs: 0, faults: 0, ledgerFit: 0, retries: 0 };
  const v = (inv: string, k: number, detail: string): void => {
    if (violations.length < 50) violations.push({ inv, seed: c.seed, request: k, detail: detail.slice(0, 600) });
  };
  const guard = <T>(inv: string, k: number, f: () => T): T | undefined => {
    try {
      return f();
    } catch (e) {
      v(inv, k, `threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      return undefined;
    }
  };
  const counter = counterFor(c, tok);
  const L = engineFor(c.cfg, counter);
  const oracle = createOracle(c.cfg, c.template, c.mode, tok);
  const tags = new Set(c.tags);
  if (tags.has('mutation')) cov.mutation = true;
  if (tags.has('client-compact')) cov.clientCompact = true;
  if (tags.has('learned')) cov.learned = true;
  if (tags.has('kwargs-toggle')) cov.kwargs = true;

  const live: string[] = [];
  const results: EngineResult[] = [];
  let prev: { out: string[]; pHash: string; compactions: number; n: number } | null = null;
  const origCount = new Map<number, number | null>();
  const oCount = (k: number, req: ChatRequest, corr: number): number | null => {
    if (origCount.has(k)) return origCount.get(k)!;
    let n: number | null;
    try {
      n = corrected(oracle.raw(req), corr);
    } catch (e) {
      if (!(e instanceof OracleCountError)) throw e;
      n = null;
    }
    origCount.set(k, n);
    return n;
  };

  for (let k = 0; k < c.requests.length; k++) {
    const req = c.requests[k]!;
    const opts = optsFor(c, k, counter);
    const res = guard('crash', k, () => L.process(req, opts));
    if (!res) return finish();
    results.push(res);
    live.push(essence(res));
    const corr = corrPctOf(opts.learned?.correction);
    const out = guard('check', k, () => checkOne(c, k, req, res, oracle, corr, oCount, v, cov));
    // coverage
    const p = res.plan;
    if (p && p.compactions > 0) cov.compact = true;
    if (p && p.compactions > 1) cov.multiCompact = true;
    for (const r of Object.values(p?.rewrites ?? {})) {
      if (r.stage === 'admission') cov.admission = true;
      if (r.kind === 'slim') cov.slim = true;
      if (r.kind === 'stub') cov.stub = true;
      if (r.kind === 'reasoning') cov.reasoningDrop = true;
      if (r.kind === 'image') cov.image = true;
      if (r.kind === 'args') cov.args = true;
      if (r.stage === 'compaction' && (r.kind === 'truncate' || r.kind === 'slim')) cov.oversize = true;
    }
    if (p && Object.keys(p.headRewrites).length) {
      cov.headTruncate = true;
      cov.oversize = true;
    }
    const rungs = p?.meta?.['rungs'];
    if (typeof rungs === 'string') for (const g of rungs.split(',')) if (/^R[1-8]$/.test(g)) cov[g as CoverageKey] = true;
    if (p?.fit === 'over_budget') cov.overBudget = true;
    if (p?.fit === 'over_hard') cov.overHard = true;
    if (res.action === 'impossible') cov.impossible = true;
    if (res.impossibleKind === 'fixed') cov.impossibleFixed = true;
    if (res.action === 'truncate') cov.truncate = true;
    if (res.action === 'clamp') cov.clamp = true;
    if (res.action === 'restore') cov.restore = true;
    if (res.action === 'guard_fallback' || res.action === 'guard_reject') cov.guard = true;
    if (res.reason === 'counting_failed') cov.countingFailed = true;
    if (res.stats.budget.byteLimit !== null && p && p.compactions > 0) cov.bytes = true;
    const firstA = req.messages.findIndex((m) => m.role === 'assistant');
    if (firstA >= 0 && oracleHeadEnd(req.messages, c.cfg.client) > firstA) cov.clientSummaryHead = true;

    // I6 (epoch-aware)
    const tr = L.lastTrace;
    if (out && p && tr && res.action !== 'guard_fallback' && res.request) {
      const ds = out.map(digest);
      // DESIGN §5.1: every client request ends at a boundary. A request that ends with an assistant message
      // which the next request follows with another assistant (a prefill-like client) did not: its plan is not
      // a fold state of the later history, so the pair is not one epoch.
      const pn = (prev as { n: number } | null)?.n ?? 0;
      const atBoundary = pn >= req.messages.length || !(req.messages[pn]?.role === 'assistant' && req.messages[pn - 1]?.role === 'assistant');
      if (prev && atBoundary && prev.pHash === tr.pHash && prev.compactions === p.compactions && !c.mutated[k] && c.cfg.rules.snapshot.stub !== 'eager') {
        checks.i6pairs++;
        cov.i6pair = true;
        const a = prev.out;
        let i = 0;
        while (i < a.length && a[i] === ds[i]) i++;
        if (i < a.length) v('I6', k, `prefix broken at index ${i} of ${a.length} (out ${ds.length}); action ${res.action} ${res.reason}`);
      }
      prev = { out: ds, pHash: tr.pHash, compactions: p.compactions, n: req.messages.length };
    } else prev = null;

    // I5: a fresh engine on the same request (shared counter; caches never change results)
    if (o.freshEvery > 0 && (k % o.freshEvery === 0 || k === c.requests.length - 1)) {
      checks.fresh++;
      const f = guard('I5-fresh', k, () => essence(engineFor(c.cfg, counter).process(req, opts)));
      if (f !== undefined && f !== live[k]) v('I5-fresh', k, diffEssence(f, live[k]!));
    }
  }

  // : a fresh engine on H[0..b) == the live fold's plan at b, for sampled boundaries of the final history
  const last = c.requests.length - 1;
  const H = c.requests[last]!.messages;
  const lastOpts = optsFor(c, last, counter);
  const bs: number[] = [];
  for (let b = 1; b <= H.length; b++) if (b === H.length || (H[b]!.role === 'assistant' && H[b - 1]!.role !== 'assistant')) bs.push(b);
  const stride = Math.max(1, Math.ceil(bs.length / Math.max(1, o.boundaryReplay)));
  for (let j = 0; j < bs.length; j++) {
    if (o.boundaryReplay <= 0 || (j % stride !== 0 && j !== bs.length - 1)) continue;
    const b = bs[j]!;
    const vr = { ...c.requests[last]!, messages: H.slice(0, b) };
    const a = guard('boundary-replay', last, () => L.process(vr, { ...lastOpts, dryRun: true }));
    const f = guard('boundary-replay', last, () => engineFor(c.cfg, counter).process(vr, lastOpts));
    checks.boundaryReplay++;
    if (a && f && canonicalJSON(f.plan) !== canonicalJSON(a.plan)) v('boundary-replay', last, `b=${b}: fresh plan != fold plan`);
  }

  const rng = new Rng(c.seed ^ 0x5bd1e995);
  // store caps 1–4
  if (o.caps) {
    const cap = 1 + rng.int(0, 3);
    const S = engineFor(c.cfg, counter, { store: new MemoryPlanStore({ maxPlans: cap, maxBytes: 1e9 }) });
    for (let k = 0; k < c.requests.length; k++) {
      const e = guard('I5-cap', k, () => essence(S.process(c.requests[k]!, optsFor(c, k, counter))));
      if (e !== undefined && e !== live[k]) {
        v('I5-cap', k, `cap ${cap}: ` + diffEssence(e, live[k]!));
        break;
      }
    }
  }
  // restart: from a random midpoint with a cold counter and no store; and through the JSONL file store
  if (o.restart && c.requests.length > 1) {
    const mid = rng.int(1, c.requests.length - 1);
    const dir = mkdtempSync(join(tmpdir(), 'kitzur-fuzz-'));
    try {
      const fileStore = (): MemoryPlanStore => new MemoryPlanStore({ maxPlans: 4096, maxBytes: 1e9, persistence: createFilePersistence({ dir }) });
      const A = engineFor(c.cfg, counter, { store: fileStore() });
      for (let k = 0; k < mid; k++) guard('I5-file', k, () => A.process(c.requests[k]!, optsFor(c, k, counter)));
      const B = engineFor(c.cfg, counter, { store: fileStore() });
      const cold = counterFor(c, tok);
      const R = engineFor(c.cfg, cold);
      let bad = { file: false, mid: false };
      for (let k = mid; k < c.requests.length; k++) {
        const eb = bad.file ? undefined : guard('I5-file', k, () => essence(B.process(c.requests[k]!, optsFor(c, k, counter))));
        if (eb !== undefined && eb !== live[k]) {
          v('I5-file', k, `restart at ${mid} on the file store: ` + diffEssence(eb, live[k]!));
          bad = { ...bad, file: true };
        }
        const er = bad.mid ? undefined : guard('I5-mid', k, () => essence(R.process(c.requests[k]!, optsFor(c, k, cold))));
        if (er !== undefined && er !== live[k]) {
          v('I5-mid', k, `cold replay from ${mid}: ` + diffEssence(er, live[k]!));
          bad = { ...bad, mid: true };
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // I7 under fault injection
  if (o.faults > 0) {
    const Fe = engineFor(c.cfg, counter, { faults: `engine-throw:${o.faults}` });
    for (let k = 0; k < c.requests.length; k++) {
      const req = c.requests[k]!;
      const opts = optsFor(c, k, counter);
      const r1 = guard('I7', k, () => Fe.process(req, opts));
      if (!r1) break;
      const T = tReqOf(req, c.cfg.budget.defaultMaxTokens);
      const corr = corrPctOf(opts.learned?.correction);
      if (r1.reason === 'engine:fault') {
        checks.faults++;
        cov.guardFault = true;
        const ci = oCount(k, req, corr);
        const fitsOrig = ci === null || serverFits(r1.stats.budget, ci, T);
        if (fitsOrig && !(r1.action === 'guard_fallback' && r1.request === req)) v('I7', k, `faulted attempt 1 did not forward the fitting original (${r1.action}); count ${ci}`);
        if (!fitsOrig && !(r1.action === 'guard_reject' && r1.request === null && r1.error?.status === 400)) v('I7', k, `faulted attempt 1 forwarded an original that does not fit (${r1.action}); count ${ci}`);
      } else if (essence(r1) !== live[k]) v('I7-I5', k, 'unfaulted result under faults != live: ' + diffEssence(essence(r1), live[k]!));
      const r2 = guard('I7', k, () => Fe.process(req, { ...opts, attempt: 2 }));
      if (r2) {
        // a retry never falls back to the original (); whether an unchanged plan may be resent is the
        // recovery ladder's strictly-smaller rule (§8, ), not the engine's
        if (r2.action === 'guard_fallback') v('I7', k, `attempt 2 fell back to the original (${r2.reason})`);
        if (r2.reason === 'engine:fault' && r2.request !== null) v('I7', k, 'faulted attempt 2 forwarded something');
      }
      // a retry as the recovery ladder sends it (§8): extra tighten and/or no clamp; I1–I4 hold against its budget
      const ex = rng.chance(0.5) ? Math.floor(c.cfg.budget.window / rng.pick([50, 20, 8])) : 0;
      const nc = rng.chance(0.4);
      if (ex > 0 || nc) {
        const r3 = guard('retry', k, () => Fe.process(req, { ...opts, attempt: 2, extraTighten: ex, noClamp: nc }));
        if (r3) {
          checks.retries++;
          if (r3.action === 'guard_fallback') v('I7', k, `retry fell back to the original (${r3.reason})`);
          else if (r3.reason !== 'engine:fault') guard('retry', k, () => checkOne(c, k, req, r3, oracle, corr, oCount, (inv, kk, d) => v('retry-' + inv, kk, `tighten ${ex} noClamp ${nc}: ${d}`), cov));
        }
      }
    }
  }

  //  on every compaction plan the live chain made
  if (o.ledgerFit) guard('ledger-fit', last, () => checkLedgerFit(c, counter, results, oracle, v, checks));
  return finish();

  function finish(): ChainOutcome {
    return {
      seed: c.seed, requests: c.requests.length, violations, cov, checks, ms: Math.round(performance.now() - t0),
      window: c.cfg.budget.window, template: c.template, mode: c.mode, preset: c.preset,
    };
  }
}

/** I1–I4 (and I2's impossible/guard_reject justification) on one live result; returns the forwarded messages. */
function checkOne(
  c: FuzzChain, k: number, req: ChatRequest, res: EngineResult, oracle: Oracle, corr: number,
  oCount: (k: number, req: ChatRequest, corr: number) => number | null,
  v: (inv: string, k: number, d: string) => void, _cov: Partial<Record<CoverageKey, true>>,
): ChatMessage[] | null {
  const b = res.stats.budget;
  const T = tReqOf(req, c.cfg.budget.defaultMaxTokens);
  const tag = `${res.action}: ${res.reason}`;
  if (res.action === 'impossible' || res.action === 'guard_reject') {
    if (res.request !== null || res.error?.status !== 400) v('I2', k, `${tag}: no 400`);
    if (res.reason?.startsWith('guard:')) v('guard', k, `guard failed (${tag})`);
    const ci = oCount(k, req, corr);
    // never worse than no proxy: a 400 on attempt 1 only when the original itself would not fit
    if (ci !== null && serverFits(b, ci, T)) v('I2-impossible', k, `${tag} although the original fits: ${ci} + ${T} vs ${limOf(b)} (${b.mode})`);
    return null;
  }
  if (res.action === 'guard_fallback') {
    if (res.request !== req) v('I7', k, `${tag}: fallback did not forward the original`);
    const ci = oCount(k, req, corr);
    if (res.reason === 'counting_failed') {
      if (ci !== null && oracle.kind !== 'fresh-counter') v('count', k, `engine counting failed but the oracle counts ${ci}`);
    } else {
      v('guard', k, `guard failed (${tag})`); // the engine produced an output its own guard rejected: a bug to report
      if (ci !== null && !serverFits(b, ci, T)) v('I7', k, `${tag}: fallback original does not fit`);
    }
    return req.messages;
  }
  const out = res.request!.messages;
  const inp = req.messages;
  // I1
  if (pairingIntact(inp) && !pairingIntact(out)) v('I1', k, `${tag}: intact input, broken output`);
  if (!defectSubset(oracleDefects(out), oracleDefects(inp))) v('I1', k, `${tag}: new pairing defects ${JSON.stringify([...oracleDefects(out)].filter(([d, n]) => (oracleDefects(inp).get(d) ?? 0) < n))}`);
  // I2
  const M = res.maxTokens?.value ?? T;
  let cOut: number | null = null;
  try {
    cOut = corrected(oracle.raw({ ...req, messages: out }), corr);
  } catch (e) {
    v('I2', k, `${tag}: the oracle cannot render the output: ${String(e instanceof Error ? e.message : e)}`);
  }
  if (cOut !== null) {
    if (cOut !== res.stats.tokensOut) v('count', k, `${tag}: engine count ${res.stats.tokensOut} != oracle ${cOut} (${oracle.kind})`);
    if (!serverFits(b, cOut, M)) v('I2', k, `${tag}: serverFits fails: ${cOut} + ${M} vs ${limOf(b)} (${b.mode})`);
    if (res.action !== 'clamp' && res.action !== 'truncate' && cOut > b.budget) v('I2', k, `${tag}: ${cOut} > budget ${b.budget}`);
    // I3 tokens
    const ci = oCount(k, req, corr);
    if (ci !== null && cOut > ci) v('I3', k, `${tag}: tokens out ${cOut} > in ${ci}`);
  }
  // I3 bytes, messages
  if (bytesOf(out) > bytesOf(inp)) v('I3', k, `${tag}: bytes out ${bytesOf(out)} > in ${bytesOf(inp)}`);
  if (out.length > inp.length) v('I3', k, `${tag}: messages out ${out.length} > in ${inp.length}`);
  // forwarded max_tokens fields: every field the client sent, never a new one unless neither was sent
  if (res.maxTokens) {
    const sent = (['max_tokens', 'max_completion_tokens'] as const).filter((f) => req[f] !== undefined);
    const want = sent.length ? sent : ['max_tokens'];
    for (const f of want) if (res.request![f] !== res.maxTokens.value) v('I2-maxtokens', k, `${tag}: field ${f} not set to ${res.maxTokens.value}`);
    for (const f of ['max_tokens', 'max_completion_tokens'] as const) if (!want.includes(f) && res.request![f] !== undefined) v('I2-maxtokens', k, `${tag}: field ${f} added`);
  }
  // I4
  const h = oracleHeadEnd(inp, c.cfg.client);
  const exempt = new Set(Object.keys(res.plan?.headRewrites ?? {}).map(Number));
  if (c.cfg.compaction.summaryRole === 'merge-into-first-user') exempt.add(inp.findIndex((m) => m.role === 'user'));
  for (let i = 0; i < h; i++) {
    if (exempt.has(i)) continue;
    if (i >= out.length || digest(out[i]) !== digest(inp[i])) {
      v('I4', k, `${tag}: head index ${i} of ${h} changed`);
      break;
    }
  }
  return out;
}

/**
 * : for each compaction plan whose fit loop reached R6 (floor eviction), re-render its summary with the room
 * F − count(out) added; if that keeps more floor items, an item was evicted although it fit.
 */
function checkLedgerFit(
  c: FuzzChain, counter: TokenCounter, results: EngineResult[], oracle: Oracle, v: (inv: string, k: number, d: string) => void,
  checks: { ledgerFit: number },
): void {
  const S = createSummarizerExt(c.cfg, counter);
  for (let k = 0; k < results.length; k++) {
    const res = results[k]!;
    const p = res.plan;
    if (!p || p.summary === null || res.action !== 'compact' || p.n !== c.requests[k]!.messages.length) continue;
    const rungs = String(p.meta?.['rungs'] ?? '');
    if (!rungs.includes('R6')) continue;
    const b = res.stats.budget;
    const F = b.hard;
    const room = F - res.stats.tokensOut;
    const cap = ffloor(b.budget, c.cfg.compaction.summaryMaxFraction);
    const sTok = Number(p.meta?.['summaryTokens'] ?? 0);
    if (room <= 1 || sTok >= cap) continue;
    const msgs = c.requests[k]!.messages;
    const input = { messages: msgs, digests: msgs.map(digest), hEnd: p.hEnd, cut: p.cut, compaction: p.compactions };
    for (const step of [0, 1, 2] as const) {
      const at = S.renderDetailed(input, { budgetTokens: sTok, allowFloorEviction: true, userShortenStep: step });
      if (at.render.text !== p.summary) continue;
      checks.ledgerFit++;
      const corr = corrPctOf(c.learned[k]?.correction);
      const extra = Math.floor((room * 100) / corr) - 1;
      const more = S.renderDetailed(input, { budgetTokens: Math.min(cap, sTok + extra), allowFloorEviction: true, userShortenStep: step });
      const floorKept = (d: typeof at): number => d.items.filter((i) => i.floor && i.kept).length;
      if (floorKept(more) > floorKept(at)) {
        // confirm with the oracle: the larger summary must really fit F
        const out = res.request?.messages;
        const j = out ? out.findIndex((m) => m.content === p.summary) : -1;
        if (out && j >= 0 && more.render.text) {
          const alt = out.map((m, i) => (i === j ? { ...m, content: more.render.text } : m));
          const cAlt = corrected(oracle.raw({ ...c.requests[k]!, messages: alt }), corr);
          if (cAlt <= F) v('ledger-fit', k, `floor items kept ${floorKept(at)} at ${sTok} tokens, ${floorKept(more)} fit (count ${cAlt} ≤ F ${F}, room ${room})`);
        }
      }
      break;
    }
  }
}

/** A short description of where two essences differ. */
export function diffEssence(a: string, b: string): string {
  const A = JSON.parse(a) as Record<string, unknown>;
  const B = JSON.parse(b) as Record<string, unknown>;
  const keys: string[] = [];
  for (const k of Object.keys(A)) if (canonicalJSON(A[k]) !== canonicalJSON(B[k])) keys.push(k);
  const pa = A['plan'] as Plan | null;
  const pb = B['plan'] as Plan | null;
  let more = '';
  if (pa && pb) {
    const pk: string[] = [];
    for (const k of Object.keys(pa) as Array<keyof Plan>) if (canonicalJSON(pa[k]) !== canonicalJSON(pb[k])) pk.push(k);
    more = ` plan fields ${pk.join(',')} (n ${pa.n}/${pb.n} cut ${pa.cut}/${pb.cut} comp ${pa.compactions}/${pb.compactions} meta ${canonicalJSON(pa.meta ?? null).slice(0, 160)} vs ${canonicalJSON(pb.meta ?? null).slice(0, 160)})`;
  }
  return `differs in ${keys.join(',')}; actions ${String(A['action'])}/${String(B['action'])}${more}`;
}
