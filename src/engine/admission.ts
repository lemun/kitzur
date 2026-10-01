// Admission rewrites (DESIGN.mda, ). At every boundary b, before the fit check, every tool
// result in [prevBoundary(b), b) above admitTokens is slimmed (snapshots, §5.6 step 1) and/or truncated
// head+tail to admitTokens. Those messages have never been forwarded (the request at b is the first to
// contain them), so I6 holds; they go into plan.rewrites with stage 'admission'.
import type { Plan, Rewrite } from '../types.js';
import { ffloor } from './budget.js';
import { isToolResult } from './message.js';
import { contentTokens, slimText, truncateText } from './oversize.js';
import { isSnapshotResult } from './results.js';
import type { FoldEnv } from './plan.js';

/**
 * admitTokens = oversize.admitTokens ?? floor((budget − count(head) − floor(budget·summaryFraction)) / 2),
 * null when admission is off.
 */
export function admitTokensFor(env: FoldEnv, headCount: number): number | null {
  const o = env.cfg.oversize;
  if (!o.enabled || !o.admission) return null;
  const b = env.bud.budget;
  return o.admitTokens ?? Math.floor((b - headCount - ffloor(b, env.cfg.compaction.summaryFraction)) / 2);
}

/** Admission rewrites for results in [from, b), or null when nothing is admitted. */
export function admissionRewrites(env: FoldEnv, plan: Plan, b: number, from: number, headCount: number): Record<number, Rewrite> | null {
  const admit = admitTokensFor(env, headCount);
  if (admit === null || admit <= 0) return null;
  const { msgs, cnt, rules } = env;
  let out: Record<number, Rewrite> | null = null;
  for (let i = from; i < b; i++) {
    const orig = msgs[i]!;
    if (!isToolResult(orig) || plan.rewrites[i] !== undefined) continue;
    const t = contentTokens(orig, cnt);
    if (t <= admit) continue;
    let r: Rewrite | null = null;
    let full = null;
    if (env.cfg.rules.snapshot.slim && isSnapshotResult(env.res, i)) {
      const sl = slimText(orig, admit, rules, cnt);
      if (sl && cnt.smaller(sl, orig)) r = { kind: 'slim', stage: 'admission', message: sl };
      else full = slimText(orig, Number.MAX_SAFE_INTEGER, rules, cnt);
    }
    if (!r) {
      const base = full ?? orig;
      const e = truncateText(base, contentTokens(base, cnt) - admit, cnt);
      if (e && cnt.smaller(e.message, orig)) r = { kind: 'truncate', stage: 'admission', message: e.message };
      else if (full && cnt.smaller(full, orig)) r = { kind: 'slim', stage: 'admission', message: full };
    }
    if (r) (out ??= {})[i] = r;
  }
  return out;
}
