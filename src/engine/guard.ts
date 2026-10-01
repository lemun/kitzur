// The guard (DESIGN.md): the last check on a rewritten request before it is forwarded. It is
// independent of how the plan was made; any failure makes the engine fall back (guard_fallback /
// guard_reject, ).
import type { Budget, ChatMessage } from '../types.js';
import { serverFits } from './budget.js';
import { newDefect, pairingDefects } from './pairing.js';

export interface GuardInput {
  input: readonly ChatMessage[];
  output: readonly ChatMessage[];
  inDigests: readonly string[];
  outDigests: readonly string[];
  /** head end of the input request */
  hEnd: number;
  /** head indices allowed to differ (plan.headRewrites, the merged summary) */
  exempt: ReadonlySet<number>;
  countIn: number;
  countOut: number;
  bytesIn: number;
  bytesOut: number;
  budget: Budget;
  /** forwarded max tokens */
  maxTokens: number;
  /** the clamp or §5.7 (a) decided: count(out) may exceed the budget, serverFits still applies */
  overBudgetAllowed: boolean;
}

const validMessage = (m: unknown): boolean => {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
  const r = (m as ChatMessage).role;
  if (typeof r !== 'string' || !r) return false;
  const c = (m as ChatMessage).content;
  return c === undefined || c === null || typeof c === 'string' || Array.isArray(c);
};

/** Null when the output may be forwarded, else the failing check (a reason, never content). */
export function guardCheck(g: GuardInput): string | null {
  if (!Array.isArray(g.output) || g.output.length === 0) return 'invalid:empty';
  for (let i = 0; i < g.output.length; i++) if (!validMessage(g.output[i])) return `invalid:message_${i}`;
  const d = newDefect(pairingDefects(g.output), pairingDefects(g.input));
  if (d !== null) return 'pairing:' + d.split(':')[0];
  if (!g.overBudgetAllowed && g.countOut > g.budget.budget) return 'over_budget';
  if (!serverFits(g.budget, g.countOut, g.maxTokens)) return 'server_fit';
  if (g.countOut > g.countIn) return 'larger_tokens';
  if (g.bytesOut > g.bytesIn) return 'larger_bytes';
  if (g.output.length > g.input.length) return 'more_messages';
  for (let i = 0; i < g.hEnd; i++) {
    if (g.exempt.has(i)) continue;
    if (g.outDigests[i] !== g.inDigests[i]) return 'head';
  }
  return null;
}
