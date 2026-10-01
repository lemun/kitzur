// The results file of one run (bench/README.md): bench/results/<runKey>.json. Everything but `timing` and `versions`
// is deterministic (bench verify diffs it); `perRequest` is the compact per-request record.

import { createHash } from 'node:crypto';
import { basics, retryMetrics, rewrites, stepViews, type StepView } from './generic.js';
import { prefixMetrics } from './prefix.js';
import { factResults, factsGate, supersessionConfusion, type ConfusionRow, type FactResult } from './facts.js';
import { headroom, pairingReport } from './pairing.js';
import type { RunRecords } from './records.js';
import type { RunTiming } from './timing.js';
import type { ScenarioDef } from '../scenarios/common.js';
import { presetQuantities, type WindowSpec } from '../scenarios/windows.js';

export const RESULTS_SCHEMA = 1;

/** Canonical identity of a forwarded body's messages (empty when the run kept no bodies). */
export function msgsDigest(digests: readonly string[]): string {
  return digests.length ? createHash('sha256').update(digests.join(',')).digest('hex').slice(0, 32) : '';
}

export interface Versions {
  commit: string | null;
  node: string;
  gobSha: string | null;
  gobVersion: string | null;
  tokenizerSha: string | null;
  codeVersion: string;
}

export interface RunMetrics {
  steps: number;
  steps_ok: number;
  client_errors: number;
  client_error_kinds: Record<string, number>;
  failed_at: { session: string; step: number } | null;
  upstream_requests: number;
  rejections: number;
  rejected: number;
  processed: number;
  processed_main_accepted: number;
  processed_main_rejected: number;
  processed_aux: number;
  aux_requests: number;
  completion: number;
  peak: number;
  /** kitzur preset quantities at this window, the reference lines for `peak` */
  budget: number;
  hard: number;
  pairing_errors: number;
  pairing_errors_lenient: number;
  client_prompt_total: number | null;
  compactions_generic: number;
  compaction_steps: Array<number | string>;
  compactions_reported: number | null;
  b2b: number;
  client_rewrites: number;
  client_compactions: number;
  summarizer_requests: number;
  title_requests: number;
  hit: number | null;
  lcp: number | null;
  uncached: number | null;
  fresh: number | null;
  fresh_synth: number | null;
  fresh_literal: number | null;
  L: number | null;
  reusable: number | null;
  hit_global: number | null;
  hit_block16: number | null;
  template_breaks: number | null;
  recoveries: number;
  retry_monotone: boolean;
  retry_monotone_violations: string[];
  original_resent: number;
  max_attempts: number;
  headroom: number | null;
  headroom_usable: number;
}

export interface PerRequest {
  session: string;
  step: number;
  attempt: number;
  kind: string;
  status: number;
  prompt: number;
  lcp: number;
  fresh: number;
  rewrite: 0 | 1;
  clientRewrite: 0 | 1;
  ownCount: number | null;
  bytes: number;
  maxTokens: number;
  clientErrorKind: string | null;
  /** sha256 over the canonical per-message digests: canonical equality of forwarded bodies (I5, F8) */
  msgsDigest: string;
}

export interface GateCheck {
  pass: boolean;
  detail: string;
}

export interface ResultsFile {
  schema: number;
  runKey: string;
  status: 'ok' | 'error' | 'not-run';
  /** NOT RUN reason or the error */
  reason: string | null;
  versions: Versions;
  system: string;
  systemLabel: string;
  scenario: string;
  family: string;
  window: string;
  tier: string;
  configHash: string;
  config: Record<string, unknown>;
  /** how the run was driven: reference (byte-exact Python-parity path) | spec | offline */
  driver: string | null;
  metrics: RunMetrics | null;
  facts: FactResult[] | null;
  supersession: { rows: ConfusionRow[]; counts: Record<string, number> } | null;
  /** per-run gate predicates (the cross-run gates are computed by bench/report.ts) */
  gates: Record<string, GateCheck>;
  /** the first client-visible errors (status, kind, body head), e.g. the F14 documented 400 */
  clientErrors?: Array<{ session: string; step: number; status: number | null; kind: string; body: string | null }>;
  notes: string[];
  perRequest: PerRequest[];
  timing: RunTiming | null;
}

/** analyze.py's compaction count: a client request is a compaction row when its ledger record says `compacted` or
 * its step took more than one upstream attempt (ledger records are one per client request, in order). */
export function reportedCompactions(ledger: ReadonlyArray<Record<string, unknown>> | null, rr: RunRecords, views: StepView[]): number | null {
  // kitzur stats records (they carry `action`; one per proxied request of ANY kind, so they cannot be aligned with the
  // client's main requests): benchmark contract counts `action = compact`, plus retry-time compactions (`compacted`)
  if (ledger && ledger.length && ledger.every((L) => typeof L['action'] === 'string')) {
    return ledger.filter((L) => L['action'] === 'compact' || L['compacted'] === true).length;
  }
  const clientOrder = rr.client.filter((c) => c.kind === 'main');
  const attempts = new Map(views.map((v) => [`${v.session}\u0000${v.step}`, v.attempts.length]));
  const rows = new Set<string>();
  clientOrder.forEach((c, i) => {
    const key = `${c.session}\u0000${c.step}`;
    const L = ledger ? ledger[i] : undefined;
    if ((L && L['compacted'] === true) || (attempts.get(key) ?? 0) > 1) rows.add(key);
  });
  return rows.size;
}

export interface BuildOptions {
  scenario: ScenarioDef;
  window: WindowSpec;
  rr: RunRecords;
  ledger: ReadonlyArray<Record<string, unknown>> | null;
  /** compactions as the system reports them; default: analyze.py semantics from the ledger */
  compactionsReported?: number | null;
  notes?: string[];
}

export function computeMetrics(o: BuildOptions): {
  metrics: RunMetrics; facts: FactResult[]; supersession: ResultsFile['supersession']; gates: Record<string, GateCheck>; perRequest: PerRequest[];
  clientErrors: NonNullable<ResultsFile['clientErrors']>;
} {
  const { rr, scenario: sc, window: w } = o;
  const views = stepViews(rr);
  const b = basics(rr, views);
  const rw = rewrites(rr, views);
  const px = prefixMetrics(rr, views);
  const rt = retryMetrics(views);
  const pr = pairingReport(rr, views);
  const hr = headroom(rr.up, w);
  const pq = presetQuantities(w);
  const facts = factResults(sc.facts, rr, views);
  const metrics: RunMetrics = {
    ...b,
    pairing_errors: pr.violations.length,
    budget: pq.budget,
    hard: pq.hard,
    compactions_generic: rw.compactions_generic,
    compaction_steps: rw.compaction_steps,
    compactions_reported: o.compactionsReported !== undefined ? o.compactionsReported : reportedCompactions(o.ledger, rr, views),
    b2b: rw.b2b,
    client_rewrites: rw.client_rewrites,
    client_compactions: rw.client_compactions,
    summarizer_requests: rw.summarizer_requests,
    title_requests: rw.title_requests,
    hit: px.hit,
    lcp: px.lcp,
    uncached: px.uncached,
    fresh: px.fresh,
    fresh_synth: px.fresh_synth,
    fresh_literal: px.fresh_literal,
    L: px.L,
    reusable: px.reusable,
    hit_global: px.hit_global,
    hit_block16: px.hit_block16,
    template_breaks: px.template_breaks,
    recoveries: rt.recoveries,
    retry_monotone: rt.retryMonotone,
    retry_monotone_violations: rt.monotoneViolations.slice(0, 20),
    original_resent: rt.originalResent,
    max_attempts: rt.maxAttempts,
    headroom: rr.up.some((r) => r.kind === 'main' && r.status === 200) ? hr.headroom : null,
    headroom_usable: hr.usable,
  };
  const supersession = sc.supersession ? supersessionConfusion(sc.supersession, facts) : null;
  // per-request records: step-level values on every attempt of the step
  const perRequest: PerRequest[] = [];
  const freshByAttempt = new Map(px.per_step.map((p) => [`${p.session}\u0000${p.step}`, p.fresh]));
  for (const v of views) {
    v.attempts.forEach((a, i) => {
      perRequest.push({
        session: a.session, step: a.step, attempt: i + 1, kind: a.kind, status: a.status, prompt: a.prompt, lcp: a.lcp,
        fresh: a === v.A && a.status === 200 ? (freshByAttempt.get(`${a.session}\u0000${a.step}`) ?? 0) : 0,
        rewrite: a === v.A ? v.rewrite : 0, clientRewrite: a === v.A ? v.clientRewrite : 0, ownCount: a.ownCount ?? null,
        bytes: a.bytes, maxTokens: a.maxTokens, clientErrorKind: a === v.A ? (v.C?.clientErrorKind ?? null) : null,
        msgsDigest: msgsDigest(a.digests),
      });
    });
  }
  for (const a of rr.up.filter((r) => r.kind !== 'main')) {
    perRequest.push({
      session: a.session, step: a.step, attempt: 1, kind: a.kind, status: a.status, prompt: a.prompt, lcp: a.lcp, fresh: 0,
      rewrite: 0, clientRewrite: 0, ownCount: a.ownCount ?? null, bytes: a.bytes, maxTokens: a.maxTokens, clientErrorKind: null,
      msgsDigest: msgsDigest(a.digests),
    });
  }
  perRequest.sort((x, y) => (x.session < y.session ? -1 : x.session > y.session ? 1 : x.step - y.step || x.attempt - y.attempt));
  const gates: Record<string, GateCheck> = {};
  const g1 = sc.expect === 'complete'
    ? {
        pass: metrics.steps_ok === metrics.steps && metrics.client_errors === 0 && metrics.rejections === 0 && metrics.pairing_errors === 0,
        detail: `steps ${metrics.steps_ok}/${metrics.steps}, client errors ${metrics.client_errors}, rejections ${metrics.rejections}, pairing errors ${metrics.pairing_errors}`,
      }
    : { pass: false, detail: `expect=${sc.expect}: evaluated by the report for kitzur only` };
  gates['G1'] = g1;
  const fg = factsGate(facts);
  gates['G2'] = { pass: fg.pass, detail: fg.pass ? 'all gated facts pass' : `failed: ${fg.failed.join(', ')}` };
  gates['G5'] = { pass: metrics.client_errors === 0 && metrics.steps_ok === metrics.steps, detail: `client errors ${metrics.client_errors}, steps ${metrics.steps_ok}/${metrics.steps}` };
  gates['G6'] = {
    pass: metrics.steps_ok === metrics.steps && metrics.client_errors === 0 && metrics.recoveries >= 1 && metrics.retry_monotone,
    detail: `steps ${metrics.steps_ok}/${metrics.steps}, client errors ${metrics.client_errors}, recoveries ${metrics.recoveries}, monotone ${metrics.retry_monotone}`,
  };
  const clientErrors = rr.client
    .filter((c) => c.clientErrorKind !== null)
    .slice(0, 20)
    .map((c) => ({ session: c.session, step: c.step, status: c.status, kind: c.clientErrorKind!, body: c.errorBody ? c.errorBody.slice(0, 600) : null }));
  return { metrics, facts, supersession, gates, perRequest, clientErrors };
}
