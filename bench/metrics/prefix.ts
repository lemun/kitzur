// Prefix-cache metrics (bench/README.md; ), on the mock's render tokens. Over the ACCEPTED main requests A_k:
//
//   LCP_k      token LCP of render(A_k) and render(P_{k−1}); 0 for a session's first request (UpstreamRec.lcp)
//   hit        Σ LCP / Σ prompt                                                     (the gate-4 value)
//   uncached   Σ (prompt − LCP)
//   fresh_k    tokens of the messages of A_k whose canonical digest appears in no earlier accepted request of the
//              session — counted for the messages that are the client's own (canonically equal to a message of C_k),
//              plus the render overhead (generation prompt) of the session's first accepted request. This is the
//              "irreducible, every message at its first send" quantity of §6.2's rationale, and the only reading that
//              reproduces the pre-registered 315,413 on gobstopper tuned / qa46-ref (§14, §17).
//   fresh_synth  the same for SYNTHESIZED messages (not equal to any message of C_k: summaries, stubs, slimmed
//              outputs) at their first forwarding. They are part of L. (§6.2's sentence read literally would count them
//              in fresh: 319,745 = 315,413 + 4,332 on that run; both are reported.)
//   L          uncached − Σ fresh   (re-prefill, including first sends of synthesized content)
//   reusable   Σ LCP / Σ (prompt − fresh)
//   hit_global Σ max-LCP-over-all-earlier-accepted-requests (any session) / Σ prompt
//   hit_block16  Σ floor(LCP/16)·16 / Σ prompt (vLLM caches 16-token blocks)
//   template_breaks  #k with rewrite_k = 0 but LCP_k < prompt(P_{k−1}) − 3 (e.g. Qwen think-stripping)

import { stepViews, type StepView } from './generic.js';
import type { RunRecords, UpstreamRec } from './records.js';

export interface PrefixStep {
  session: string;
  step: number;
  prompt: number;
  lcp: number;
  fresh: number;
  freshSynth: number;
}

export interface PrefixMetrics {
  accepted_requests: number;
  prompt_accepted: number;
  lcp: number;
  hit: number | null;
  uncached: number;
  fresh: number;
  fresh_synth: number;
  /** fresh + fresh_synth (§6.2 read literally) */
  fresh_literal: number;
  L: number;
  reusable: number | null;
  hit_global: number | null;
  hit_block16: number | null;
  template_breaks: number;
  per_step: PrefixStep[];
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function prefixMetrics(rr: RunRecords, views: StepView[] = stepViews(rr)): PrefixMetrics {
  const seen = new Map<string, Set<string>>();
  const firstDone = new Set<string>();
  const per: PrefixStep[] = [];
  let P = 0;
  let lcp = 0;
  let fresh = 0;
  let synth = 0;
  let block16 = 0;
  let global = 0;
  let globalKnown = true;
  let breaks = 0;
  for (const v of views) {
    for (const a of v.attempts) {
      if (a.status !== 200 || a.streamError) continue;
      const s = a.session;
      let seenS = seen.get(s);
      if (!seenS) seen.set(s, (seenS = new Set()));
      const client = v.C ? new Set(v.C.digests) : null;
      let f = firstDone.has(s) ? 0 : a.overhead;
      let fs = 0;
      a.digests.forEach((d, i) => {
        if (seenS!.has(d)) return;
        if (!client || client.has(d)) f += a.msgTokens[i] ?? 0;
        else fs += a.msgTokens[i] ?? 0;
      });
      for (const d of a.digests) seenS.add(d);
      firstDone.add(s);
      const l = a.lcp;
      P += a.prompt;
      lcp += l;
      fresh += f;
      synth += fs;
      block16 += Math.floor(l / 16) * 16;
      if (a.lcpGlobal === null) globalKnown = false;
      else global += a.lcpGlobal;
      if (a === v.A && v.Pprev && v.rewrite === 0 && l < v.Pprev.prompt - 3) breaks++;
      per.push({ session: s, step: a.step, prompt: a.prompt, lcp: l, fresh: f, freshSynth: fs });
    }
  }
  const uncached = P - lcp;
  return {
    accepted_requests: per.length,
    prompt_accepted: P,
    lcp,
    hit: ratio(lcp, P),
    uncached,
    fresh,
    fresh_synth: synth,
    fresh_literal: fresh + synth,
    L: uncached - fresh,
    reusable: ratio(lcp, P - fresh),
    hit_global: globalKnown && per.length ? ratio(global, P) : null,
    hit_block16: ratio(block16, P),
    template_breaks: breaks,
    per_step: per,
  };
}

/** The accepted main requests in arrival order (helper for callers that need P_k sequences). */
export function acceptedMain(up: readonly UpstreamRec[]): UpstreamRec[] {
  return up.filter((r) => r.kind === 'main' && r.status === 200 && !r.streamError).sort((a, b) => a.seq - b.seq);
}
