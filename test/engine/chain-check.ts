// The invariant checks of DESIGN §1 over one chain of client requests, shared by the random-chain
// properties, the reference-scenario test and the real-summarizer integration test:
//   I1 pairing (independent oracle), I2 with an independent counter, I3, I4 canonical head,
//   I5 live == fresh engine (per request, and on H[0..b) at boundaries b: ), I6 epoch-aware prefix
//   stability, store caps 1–4, restart equivalence with and without the JSONL file store.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Budget, ChatMessage, ChatRequest, EngineResult, LearnedEntry, PlanStore, TokenCounter } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import type { Summarizer, ToolRules } from '../../src/engine/contracts.js';
import { createEngine, type LeanEngine } from '../../src/engine/engine.js';
import { MemoryPlanStore } from '../../src/engine/store.js';
import { createFilePersistence } from '../../src/engine/store-file.js';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import type { TemplateName } from '../../src/tokenize/template.js';
import { bytesOf, digest, oracleCounter, oracleDefects, oracleHeadEnd, pairingIntact, subset } from './oracle.js';
import { estimateCounter, exactCounter, StubRules, StubSummarizer } from './stubs.js';

/** What a chain check needs (gen.ts Chain satisfies it). */
export interface ChainSpec {
  seed: number;
  cfg: Config;
  template: TemplateName;
  mode: 'exact' | 'estimate';
  requests: ChatRequest[];
  learned: Array<LearnedEntry | null>;
  mutated: boolean[];
}

export interface Parts {
  summarizer: (cfg: Config, counter: TokenCounter) => Summarizer;
  rules: (cfg: Config) => ToolRules;
}

export const STUB_PARTS: Parts = { summarizer: (cfg, c) => new StubSummarizer(cfg, c), rules: (cfg) => new StubRules(cfg) };

export interface CheckOptions {
  parts?: Parts;
  /** fresh-engine comparison per request: every request, every k-th, or none */
  freshEvery?: number;
  /**  boundaries checked: all, or at most this many (evenly spread) */
  boundaryReplay?: 'all' | number;
  caps?: boolean;
  restart?: boolean;
  /** shared counter (default: a new one for the chain) */
  counter?: TokenCounter;
}

export interface Coverage {
  chains: number;
  compact: number;
  admission: number;
  oversize: number;
  slim: number;
  stub: number;
  impossible: number;
  truncate: number;
  clamp: number;
  requests: number;
  i6pairs: number;
  boundaryReplay: number;
}
export const newCoverage = (): Coverage => ({
  chains: 0, compact: 0, admission: 0, oversize: 0, slim: 0, stub: 0, impossible: 0, truncate: 0, clamp: 0, requests: 0, i6pairs: 0, boundaryReplay: 0,
});

export const counterFor = (c: { template: TemplateName; mode: 'exact' | 'estimate' }): TokenCounter =>
  c.mode === 'exact' ? exactCounter(c.template)! : estimateCounter(c.template);

export const engineFor = (
  c: { cfg: Config }, counter: TokenCounter, parts: Parts = STUB_PARTS, extra: { store?: PlanStore; faults?: string | null } = {},
): LeanEngine => createEngine(c.cfg, { counter, summarizer: parts.summarizer(c.cfg, counter), rules: parts.rules(c.cfg), faults: null, ...extra });

export const optsFor = (c: ChainSpec, k: number, counter: TokenCounter) => {
  const l = c.learned[k];
  return l ? { attempt: 1, learned: { ...l, counterId: counter.id } } : { attempt: 1 };
};

/** What must be identical between a live chain and a fresh engine (timing and memo diagnostics excluded). */
export const essence = (r: EngineResult): string =>
  canonicalJSON({
    action: r.action, request: r.request, maxTokens: r.maxTokens, plan: r.plan, error: r.error ?? null, impossibleKind: r.impossibleKind ?? null,
  });

const lim = (b: Budget): number => b.window - b.margin - b.tighten;
export function serverFits(b: Budget, c: number, M: number): boolean {
  if (b.mode === 'strict_total') return c + M <= lim(b);
  if (b.mode === 'tgi') return c + Math.min(M, 1024) <= lim(b);
  return c <= lim(b);
}
export const tReq = (req: ChatRequest, def: number): number => {
  const v = [req.max_tokens, req.max_completion_tokens].filter((x): x is number => typeof x === 'number' && x > 0);
  return v.length ? Math.max(...v) : def;
};

/** I1–I4 (and I7 for fallbacks) on one result; returns the forwarded messages (null: nothing forwarded). */
export function checkOne(
  c: ChainSpec, k: number, req: ChatRequest, res: EngineResult, oc: (r: ChatRequest) => number, corrPct: number,
): ChatMessage[] | null {
  const where = `seed ${c.seed} request ${k} (${res.action}: ${res.reason})`;
  const count = (msgs: ChatMessage[]): number => Math.ceil((oc({ ...req, messages: msgs }) * corrPct) / 100 - 1e-9);
  const b = res.stats.budget;
  const T = tReq(req, c.cfg.budget.defaultMaxTokens);
  if (res.action === 'impossible' || res.action === 'guard_reject') {
    assert.equal(res.request, null, where);
    assert.equal(res.error?.status, 400, where);
    return null;
  }
  if (res.action === 'guard_fallback') {
    assert.equal(res.request, req, where);
    if (res.reason !== 'counting_failed') assert.ok(serverFits(b, count(req.messages), T), `I7 ${where}`);
    return req.messages;
  }
  const out = res.request!.messages;
  const inp = req.messages;
  // I1
  if (pairingIntact(inp)) assert.ok(pairingIntact(out), `I1 intact ${where}`);
  assert.ok(subset(oracleDefects(out), oracleDefects(inp)), `I1 defects ${where}`);
  // I2 (the oracle is a separate counter; they must agree exactly)
  const M = res.maxTokens?.value ?? T;
  const cOut = count(out);
  assert.equal(cOut, res.stats.tokensOut, `engine count == oracle count ${where}`);
  assert.ok(serverFits(b, cOut, M), `I2 serverFits ${where}: ${cOut} + ${M} vs ${lim(b)}`);
  if (res.action !== 'clamp' && res.action !== 'truncate') assert.ok(cOut <= b.budget, `I2 ${where}: ${cOut} > ${b.budget}`);
  // I3
  assert.ok(cOut <= count(inp), `I3 tokens ${where}`);
  assert.ok(bytesOf(out) <= bytesOf(inp), `I3 bytes ${where}`);
  assert.ok(out.length <= inp.length, `I3 messages ${where}`);
  // I4
  const h = oracleHeadEnd(inp, c.cfg.client);
  const exempt = new Set(Object.keys(res.plan?.headRewrites ?? {}).map(Number));
  if (c.cfg.compaction.summaryRole === 'merge-into-first-user') exempt.add(inp.findIndex((m) => m.role === 'user'));
  for (let i = 0; i < h; i++) if (!exempt.has(i)) assert.equal(digest(out[i]), digest(inp[i]), `I4 index ${i} ${where}`);
  return out;
}

/** Runs every check on one chain; returns the live results. */
export function checkChain(c: ChainSpec, cov: Coverage, o: CheckOptions = {}): EngineResult[] {
  const parts = o.parts ?? STUB_PARTS;
  cov.chains++;
  const counter = o.counter ?? counterFor(c);
  const L = engineFor(c, counter, parts);
  const oc = oracleCounter(c.template, c.mode);
  let prev: { out: string[]; pHash: string; compactions: number } | null = null;
  const live: string[] = [];
  const results: EngineResult[] = [];
  const seen = { compact: false, admission: false, oversize: false, slim: false, stub: false, impossible: false, truncate: false, clamp: false };
  const freshEvery = o.freshEvery ?? 1;
  for (let k = 0; k < c.requests.length; k++) {
    cov.requests++;
    const req = c.requests[k]!;
    const opts = optsFor(c, k, counter);
    const res = L.process(req, opts);
    results.push(res);
    live.push(essence(res));
    const corr = Math.max(100, Math.ceil((opts.learned?.correction ?? 1) * 100 - 1e-9));
    const out = checkOne(c, k, req, res, oc, corr);
    const p = res.plan;
    if (p && p.compactions > 0) seen.compact = true;
    for (const r of Object.values(p?.rewrites ?? {})) {
      if (r.stage === 'admission') seen.admission = true;
      if (r.kind === 'slim') seen.slim = true;
      if (r.kind === 'stub') seen.stub = true;
      if (r.stage === 'compaction' && (r.kind === 'truncate' || r.kind === 'slim')) seen.oversize = true;
    }
    if (p && Object.keys(p.headRewrites).length) seen.oversize = true;
    if (res.action === 'impossible') seen.impossible = true;
    if (res.action === 'truncate') seen.truncate = true;
    if (res.action === 'clamp') seen.clamp = true;
    // I6 (epoch-aware): same P, same compactions, append-only client, something forwarded both times
    const tr = L.lastTrace;
    if (out && p && tr && res.action !== 'guard_fallback') {
      const ds = out.map(digest);
      if (prev && prev.pHash === tr.pHash && prev.compactions === p.compactions && !c.mutated[k] && c.cfg.rules.snapshot.stub !== 'eager') {
        cov.i6pairs++;
        assert.deepEqual(ds.slice(0, prev.out.length), prev.out, `I6 seed ${c.seed} request ${k}`);
      }
      prev = { out: ds, pHash: tr.pHash, compactions: p.compactions };
    } else prev = null;
    // I5: a fresh engine on the same request (shared counter: its caches do not change results)
    if (freshEvery > 0 && (k % freshEvery === 0 || k === c.requests.length - 1)) {
      assert.equal(essence(engineFor(c, counter, parts).process(req, opts)), live[k], `I5 fresh seed ${c.seed} request ${k}`);
    }
  }
  for (const [kk, v] of Object.entries(seen)) if (v) cov[kk as keyof typeof seen]++;

  // : for boundaries b of the final history, a fresh engine on H[0..b) == the live fold's plan at b
  const last = c.requests.length - 1;
  const H = c.requests[last]!.messages;
  const lastOpts = optsFor(c, last, counter);
  const bs: number[] = [];
  for (let b = 1; b <= H.length; b++) if (b === H.length || (H[b]!.role === 'assistant' && H[b - 1]!.role !== 'assistant')) bs.push(b);
  const pick = o.boundaryReplay === undefined || o.boundaryReplay === 'all' ? bs : bs.filter((_, i) => i % Math.max(1, Math.ceil(bs.length / (o.boundaryReplay as number))) === 0 || i === bs.length - 1);
  for (const b of pick) {
    const vr = { ...c.requests[last]!, messages: H.slice(0, b) };
    const a = L.process(vr, { ...lastOpts, dryRun: true });
    const f = engineFor(c, counter, parts).process(vr, lastOpts);
    assert.equal(canonicalJSON(f.plan), canonicalJSON(a.plan), ` seed ${c.seed} b=${b}`);
    cov.boundaryReplay++;
  }

  // store caps 1–4
  if (o.caps !== false) {
    const cap = 1 + (c.seed % 4);
    const S = engineFor(c, counter, parts, { store: new MemoryPlanStore({ maxPlans: cap, maxBytes: 1e9 }) });
    c.requests.forEach((r, k) => assert.equal(essence(S.process(r, optsFor(c, k, counter))), live[k], `I5 store cap ${cap} seed ${c.seed} request ${k}`));
  }
  // restart equivalence: memory only (cold counter too), and through the JSONL store
  if (o.restart !== false) {
    const mid = Math.floor(c.requests.length / 2);
    const dir = mkdtempSync(join(tmpdir(), 'kitzur-restart-'));
    try {
      const fileStore = () => new MemoryPlanStore({ maxPlans: 4096, maxBytes: 1e9, persistence: createFilePersistence({ dir }) });
      const A = engineFor(c, counter, parts, { store: fileStore() });
      for (let k = 0; k < mid; k++) A.process(c.requests[k]!, optsFor(c, k, counter));
      const B = engineFor(c, counter, parts, { store: fileStore() }); // restarted process, plans on disk
      const cold = counterFor(c);
      const R = engineFor(c, cold, parts); // restarted process: no persistence, cold counter
      for (let k = mid; k < c.requests.length; k++) {
        assert.equal(essence(B.process(c.requests[k]!, optsFor(c, k, counter))), live[k], `restart+file seed ${c.seed} request ${k}`);
        assert.equal(essence(R.process(c.requests[k]!, optsFor(c, k, cold))), live[k], `restart seed ${c.seed} request ${k}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}
