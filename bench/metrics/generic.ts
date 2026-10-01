// Generic, system-agnostic run metrics (bench/README.mdbasics, §6.1, §7.3), from compact per-request records.
//
// For session s and client step k:  C_k = the (last) client main request of step k; A_k = the last upstream main
// attempt of step k; P_k = the last ACCEPTED main attempt at or before step k. Summarizer and title requests are
// excluded from the main-class metrics and reported separately.
//
//   rewrite_k        digests(P_{k−1}) is not a prefix of digests(A_k)            (0 for a session's first request)
//   clientRewrite_k  digests(C_{k−1}) is not a prefix of digests(C_k)
//   proxyRewrite_k   rewrite_k ∧ ¬clientRewrite_k;   compactions_generic = Σ proxyRewrite
//   b2b              #k with proxyRewrite_k ∧ proxyRewrite_{k−1}
//   client_compactions  #k with clientRewrite_k, plus summarizer bursts (consecutive summarizer/title-free requests
//                    of kind summarizer between two main requests) whose next main request is not a client rewrite
//                    (e.g. a compaction right before the session ended) — each client compaction counted once.

import { groupBy, isPrefix, type ClientRec, type RunRecords, type UpstreamRec } from './records.js';

export interface StepView {
  session: string;
  step: number;
  /** C_k (last client main request of the step) */
  C: ClientRec | null;
  /** C_k's earlier attempts included (OpenCode overflow path re-sends the step) */
  clientAttempts: ClientRec[];
  /** upstream main attempts of the step, in arrival order */
  attempts: UpstreamRec[];
  /** A_k */
  A: UpstreamRec | null;
  /** P_{k−1}: last accepted main attempt before this step (same session) */
  Pprev: UpstreamRec | null;
  rewrite: 0 | 1;
  clientRewrite: 0 | 1;
  proxyRewrite: 0 | 1;
}

const byStep = (a: { step: number }, b: { step: number }): number => a.step - b.step;
const accepted = (r: UpstreamRec): boolean => r.status === 200 && !r.streamError;

/** One view per (session, client step), sessions in first-appearance order, steps ascending. */
export function stepViews(rr: RunRecords): StepView[] {
  const out: StepView[] = [];
  const upMain = rr.up.filter((r) => r.kind === 'main');
  const clMain = rr.client.filter((c) => c.kind === 'main');
  const sessions: string[] = [];
  for (const s of [...Object.keys(rr.steps), ...upMain.map((r) => r.session), ...clMain.map((c) => c.session)]) if (!sessions.includes(s)) sessions.push(s);
  for (const s of sessions) {
    const ups = groupBy(upMain.filter((r) => r.session === s).sort((a, b) => a.seq - b.seq), (r) => r.step);
    const cls = groupBy(clMain.filter((c) => c.session === s), (c) => c.step);
    const steps = [...new Set([...ups.keys(), ...cls.keys()])].sort((a, b) => a - b);
    let P: UpstreamRec | null = null;
    let prevC: ClientRec | null = null;
    for (const k of steps) {
      const attempts = ups.get(k) ?? [];
      const clientAttempts = cls.get(k) ?? [];
      const C = clientAttempts.length ? clientAttempts[clientAttempts.length - 1]! : null;
      const A = attempts.length ? attempts[attempts.length - 1]! : null;
      const rewrite: 0 | 1 = A && P && !isPrefix(P.digests, A.digests) ? 1 : 0;
      const clientRewrite: 0 | 1 = C && prevC && !isPrefix(prevC.digests, C.digests) ? 1 : 0;
      out.push({ session: s, step: k, C, clientAttempts, attempts, A, Pprev: P, rewrite, clientRewrite, proxyRewrite: rewrite && !clientRewrite ? 1 : 0 });
      for (const a of attempts) if (accepted(a)) P = a;
      if (C) prevC = C;
    }
  }
  return out;
}

export interface Basics {
  /** Σ scenario steps over sessions */
  steps: number;
  /** client steps that ended with an accepted main-class response and no client-visible error */
  steps_ok: number;
  /** client requests with a client-visible error (benchmark contract ) */
  client_errors: number;
  client_error_kinds: Record<string, number>;
  /** the first failing (session, step), if any */
  failed_at: { session: string; step: number } | null;
  upstream_requests: number;
  /** upstream attempts rejected for length, and their prompt tokens */
  rejections: number;
  rejected: number;
  /** Σ prompt over every upstream attempt (gate-3 quantity), and its split */
  processed: number;
  processed_main_accepted: number;
  processed_main_rejected: number;
  processed_aux: number;
  aux_requests: number;
  completion: number;
  /** max prompt of an accepted main request */
  peak: number;
  /** requests whose strict pairing defects are not a subset of their client request's (§6.4) */
  pairing_errors: number;
  /** the mock's lenient (Python) pairing errors */
  pairing_errors_lenient: number;
  /** Σ over steps of the client's uncompacted prompt (what the agent would have sent without a proxy) */
  client_prompt_total: number | null;
}

export function basics(rr: RunRecords, views: StepView[] = stepViews(rr)): Basics {
  const up = rr.up;
  const main = up.filter((r) => r.kind === 'main');
  const aux = up.filter((r) => r.kind !== 'main');
  const clMain = rr.client.filter((c) => c.kind === 'main');
  const kinds: Record<string, number> = {};
  let firstFail: Basics['failed_at'] = null;
  for (const c of rr.client) {
    if (c.clientErrorKind === null) continue;
    kinds[c.clientErrorKind] = (kinds[c.clientErrorKind] ?? 0) + 1;
    if (!firstFail) firstFail = { session: c.session, step: c.step };
  }
  const stepsOk = views.filter((v) => v.C && v.C.clientErrorKind === null && v.C.status === 200 && v.A !== null && accepted(v.A)).length;
  const cByKey = new Map(views.map((v) => [`${v.session}\u0000${v.step}`, v.C]));
  let pairing = 0;
  for (const r of main) {
    const C = cByKey.get(`${r.session}\u0000${r.step}`) ?? null;
    const input = new Set(C ? C.pairingStrict : []);
    if (!r.pairingStrict.every((d) => input.has(d))) pairing++;
  }
  const knownPrompts = clMain.filter((c) => c.prompt !== null);
  return {
    steps: Object.values(rr.steps).reduce((a, b) => a + b, 0),
    steps_ok: stepsOk,
    client_errors: rr.client.filter((c) => c.clientErrorKind !== null).length,
    client_error_kinds: kinds,
    failed_at: firstFail,
    upstream_requests: up.length,
    rejections: up.filter((r) => r.rejected).length,
    rejected: sum(up.filter((r) => r.rejected).map((r) => r.prompt)),
    processed: sum(up.map((r) => r.prompt)),
    processed_main_accepted: sum(main.filter((r) => r.status === 200).map((r) => r.prompt)),
    processed_main_rejected: sum(main.filter((r) => r.status !== 200).map((r) => r.prompt)),
    processed_aux: sum(aux.map((r) => r.prompt)),
    aux_requests: aux.length,
    completion: sum(up.map((r) => r.completion ?? 0)),
    peak: max(main.filter((r) => r.status === 200).map((r) => r.prompt)),
    pairing_errors: pairing,
    pairing_errors_lenient: up.filter((r) => r.pairingError).length,
    client_prompt_total: knownPrompts.length === clMain.length && clMain.length ? sum(knownPrompts.map((c) => c.prompt!)) : null,
  };
}

export interface Rewrites {
  compactions_generic: number;
  /** "session:step" labels (or plain steps for a single session), in order */
  compaction_steps: Array<number | string>;
  b2b: number;
  client_rewrites: number;
  client_compactions: number;
  summarizer_requests: number;
  title_requests: number;
}

export function rewrites(rr: RunRecords, views: StepView[] = stepViews(rr)): Rewrites {
  const single = new Set(views.map((v) => v.session)).size <= 1;
  const label = (v: StepView): number | string => (single ? v.step : `${v.session}:${v.step}`);
  let b2b = 0;
  const steps: Array<number | string> = [];
  const bySession = groupBy(views, (v) => v.session);
  for (const vs of bySession.values()) {
    vs.sort(byStep);
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i]!;
      if (!v.proxyRewrite) continue;
      steps.push(label(v));
      const p = vs[i - 1];
      if (p && p.step === v.step - 1 && p.proxyRewrite) b2b++;
    }
  }
  // client compactions: client rewrites, plus summarizer bursts not followed by a client rewrite
  const rewriteKeys = new Set(views.filter((v) => v.clientRewrite).map((v) => `${v.session}\u0000${v.step}`));
  let extra = 0;
  for (const [s, ups] of groupBy([...rr.up].sort((a, b) => a.seq - b.seq), (r) => r.session)) {
    let inBurst = false;
    for (let i = 0; i <= ups.length; i++) {
      const r = ups[i];
      if (r && r.kind === 'summarizer') {
        inBurst = true;
        continue;
      }
      if (r && r.kind === 'title') continue;
      if (inBurst) {
        // the burst ends at a main request (or at the end of the session)
        const next = r;
        if (!next || !rewriteKeys.has(`${s}\u0000${next.step}`)) extra++;
        inBurst = false;
      }
    }
  }
  return {
    compactions_generic: steps.length,
    compaction_steps: steps,
    b2b,
    client_rewrites: rewriteKeys.size,
    client_compactions: rewriteKeys.size + extra,
    summarizer_requests: rr.up.filter((r) => r.kind === 'summarizer').length,
    title_requests: rr.up.filter((r) => r.kind === 'title').length,
  };
}

// ---------------------------------------------------------------- §7.3 retry metrics

export interface RetryMetrics {
  /** steps with a rejected attempt followed by an accepted one */
  recoveries: number;
  /** every retry is smaller (raw tokens, or equal tokens with smaller max_tokens), not larger in bytes, and no attempt
   * exceeds the client's original; the original resend () is exempt */
  retryMonotone: boolean;
  monotoneViolations: string[];
  /** attempts >= 2 that are canonically the client's original ( resends) */
  originalResent: number;
  maxAttempts: number;
}

export function retryMetrics(views: StepView[]): RetryMetrics {
  let recoveries = 0;
  let resent = 0;
  let maxAttempts = 0;
  const bad: string[] = [];
  for (const v of views) {
    const at = v.attempts;
    maxAttempts = Math.max(maxAttempts, at.length);
    const firstBad = at.findIndex((a) => !accepted(a));
    if (firstBad >= 0 && at.slice(firstBad + 1).some(accepted)) recoveries++;
    const orig = v.C;
    const isOriginal = (a: UpstreamRec): boolean => !!orig && a.digests.length === orig.digests.length && isPrefix(a.digests, orig.digests);
    for (let i = 0; i < at.length; i++) {
      const a = at[i]!;
      const tag = `${v.session}:${v.step}#${i + 1}`;
      if (i >= 1 && isOriginal(a)) {
        resent++;
        continue; // the  resend is reported separately and exempt
      }
      // the client's count has no hidden server overhead: compare the attempt's own render tokens with it
      const own = a.prompt - (a.hidden ?? 0);
      if (orig && orig.prompt !== null && own > orig.prompt) bad.push(`${tag}: ${own} tokens > the client's ${orig.prompt}`);
      if (i === 0) continue;
      const p = at[i - 1]!;
      const ownP = p.prompt - (p.hidden ?? 0);
      if (!(own < ownP || (own === ownP && a.maxTokens < p.maxTokens))) bad.push(`${tag}: ${own} tokens / max_tokens ${a.maxTokens} not below ${ownP} / ${p.maxTokens}`);
      if (a.bytes > p.bytes) bad.push(`${tag}: ${a.bytes} bytes > ${p.bytes}`);
    }
  }
  return { recoveries, retryMonotone: bad.length === 0, monotoneViolations: bad, originalResent: resent, maxAttempts };
}

// ---------------------------------------------------------------- helpers

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function max(xs: readonly number[]): number {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
}
