// Calibration (DESIGN.md "Calibration", , ADR-10, ADR-14): the ratio of the provider's
// prompt_tokens (or the gateway tokenize endpoint's count) to our raw count of the same forwarded
// request, kept per (origin, model) in the learned entry.
//
//  - sample filter: complete stream, finish_reason ∈ {stop, tool_calls, length}, usage of the attempt
//    that was counted, counted ≥ max(minCountedTokens, 0.1·budget), ratio in [0.85, 1.15] (exact) or
//    [0.5, 2.5] (estimate). Out-of-band samples are usage_mismatch and never learned from.
//  - correction = ceil_1% of the p90 of the last 64 accepted ratios, capped at maxCorrection[mode],
//    applied from minSamples on, never below 1, never decreasing with upwardOnly, and changed only
//    by ≥ 2 quanta (hysteresis: every change is a change of P, one refold of every session).
//  - the tokenize endpoint is a calibration source only (never inside the engine): the proxy counts
//    the forwarded request's rendered prompt there asynchronously, after forwarding or in shadow mode.
import type { Config } from '../config/schema.js';
import type { ChatRequest, LearnedEntry } from '../types.js';
import type { RemoteTokenizer } from '../tokenize/remote.js';
import { renderPrompt, type TemplateProfile } from '../tokenize/template.js';

/** ceil to the next 1% (with an epsilon so 1.02 stays 1.02). */
export const ceil1pct = (x: number): number => Math.ceil(x * 100 - 1e-9) / 100;

/** Nearest-rank p90 of a non-empty list. */
export function p90(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]!;
}

/** Last accepted ratios kept for the running p90. */
export const RATIO_WINDOW = 64;
/** One quantum of the correction (1%); a change needs two. */
const QUANTUM = 0.01;

export type CounterKind = 'exact' | 'estimate';

export interface SampleInput {
  cfg: Config;
  mode: CounterKind;
  /** the §3 budget the request was planned with */
  budget: number;
  /** our raw count of the forwarded request */
  counted: number;
  /** the provider's prompt_tokens, or the endpoint's count */
  reported: number;
  source: 'usage' | 'endpoint';
  /** usage source only: the stream completed ([DONE] or a finish_reason) */
  complete?: boolean;
  finishReason?: string | null;
  /** usage source only: the usage belongs to the attempt that was counted */
  sameAttempt?: boolean;
  /** server.budgetMode is silent_truncate (Ollama): a low ratio means the server truncated */
  silentTruncate?: boolean;
}

export interface SampleVerdict {
  verdict: 'accepted' | 'filtered' | 'mismatch';
  ratio: number;
  reason?: string;
  /** e.g. "server truncates: window smaller than configured" */
  warning?: string;
}

const FINISH_OK = new Set(['stop', 'tool_calls', 'length']);

export function judgeSample(s: SampleInput): SampleVerdict {
  const ratio = s.counted > 0 ? s.reported / s.counted : NaN;
  const out = (verdict: SampleVerdict['verdict'], reason?: string): SampleVerdict => {
    const v: SampleVerdict = { verdict, ratio };
    if (reason) v.reason = reason;
    if (s.silentTruncate && Number.isFinite(ratio) && ratio < 0.9) v.warning = 'server truncates: window smaller than configured';
    return v;
  };
  if (!s.cfg.calibration.enabled) return out('filtered', 'calibration disabled');
  if (!Number.isFinite(ratio) || s.reported <= 0) return out('filtered', 'no usable count');
  if (s.source === 'usage') {
    if (!s.complete) return out('filtered', 'stream incomplete');
    if (!s.finishReason || !FINISH_OK.has(s.finishReason)) return out('filtered', `finish_reason ${s.finishReason ?? 'none'}`);
    if (s.sameAttempt === false) return out('filtered', 'usage of another attempt');
  }
  const minCounted = Math.max(s.cfg.calibration.minCountedTokens, 0.1 * s.budget);
  if (s.counted < minCounted) return out('filtered', 'request too small');
  const [lo, hi] = s.mode === 'exact' ? [0.85, 1.15] : [0.5, 2.5];
  if (ratio < lo || ratio > hi) return out('mismatch', `ratio ${ratio.toFixed(3)} outside [${lo}, ${hi}]`);
  return out('accepted');
}

export interface Applied {
  entry: LearnedEntry;
  /** the correction (a planning input) changed */
  correctionChanged: boolean;
}

/** The correction the accepted ratios call for (before hysteresis). */
export function correctionFor(ratios: readonly number[], cfg: Config, mode: CounterKind): number {
  const cap = cfg.calibration.maxCorrection[mode];
  return Math.min(cap, Math.max(1, ceil1pct(p90(ratios))));
}

/** Adds one accepted ratio and recomputes the correction with the  rules. */
export function applyAcceptedRatio(e: LearnedEntry, ratio: number, cfg: Config, mode: CounterKind, now: Date): Applied {
  const ratios = [...e.ratios, ratio].slice(-RATIO_WINDOW);
  const samples = e.samples + 1;
  const meanRatio = e.samples > 0 ? e.meanRatio + (ratio - e.meanRatio) / samples : ratio;
  const next: LearnedEntry = { ...e, ratios, samples, meanRatio, updatedAt: now.toISOString() };
  let correctionChanged = false;
  if (samples >= cfg.calibration.minSamples) {
    let cand = correctionFor(ratios, cfg, mode);
    if (cfg.calibration.upwardOnly) cand = Math.max(cand, e.correction);
    if (Math.abs(cand - e.correction) >= 2 * QUANTUM - 1e-9) {
      next.correction = cand;
      correctionChanged = true;
    }
  }
  return { entry: next, correctionChanged };
}

/**
 * Counts forwarded requests at the gateway tokenize endpoint (a calibration source, ADR-14). One
 * count is in flight at a time; while one runs, or while the endpoint is in failure backoff, further
 * requests are skipped, so a slow gateway never queues work behind the proxy.
 */
export class EndpointCalibrator {
  private busy = false;
  skipped = 0;
  constructor(private readonly remote: RemoteTokenizer, private readonly profile: TemplateProfile) {}

  /** The endpoint's count of the request's rendered prompt, or null (busy, down, render or HTTP failure). */
  async count(req: ChatRequest): Promise<number | null> {
    if (this.busy || this.remote.down()) {
      this.skipped++;
      return null;
    }
    let text: string;
    try {
      text = renderPrompt(this.profile, req);
    } catch {
      return null; // the template rejects the request; nothing to calibrate
    }
    this.busy = true;
    try {
      return await this.remote.count(text, typeof req.model === 'string' ? req.model : null);
    } finally {
      this.busy = false;
    }
  }
}
