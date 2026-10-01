// Assembly of a plan onto a history H[0..m) with m ≥ plan.n and the same chain prefix (DESIGN.md):
//
//   h   = hEnd(H[0..m));  c = max(plan.cut, h)
//   out = [ headRewrites[i]?.message ?? H[i]  for i in 0..h )
//      ++ (summary ? [{role: "user", content: summary}] : [])
//      ++ [ rewrites[i]?.message ?? H[i]  for i in c..m )
//
// With compaction.summaryRole = 'merge-into-first-user' the summary is appended to the first user
// message of the head after a blank line instead (an I4 relaxation).
import type { ChatMessage, Plan, Rewrite } from '../types.js';
import type { Config } from '../config/schema.js';
import { Lru } from './lru.js';
import { isTextPart, roleOf, withContent } from './message.js';

// Summary messages are cached by text so that their object (and so their digest) is reused.
const summaryMessages = new Lru<string, ChatMessage>(256);

/** The summary message `{"role":"user","content": text}` (one object per text). */
export function summaryMessage(text: string): ChatMessage {
  let m = summaryMessages.get(text);
  if (!m) {
    m = { role: 'user', content: text };
    summaryMessages.set(text, m);
  }
  return m;
}

/** The first user message of the head with the summary appended after a blank line. */
export function mergeSummary(m: ChatMessage, summary: string): ChatMessage {
  const c = m.content;
  if (typeof c === 'string') return withContent(m, c + '\n\n' + summary);
  if (Array.isArray(c)) {
    for (let i = c.length - 1; i >= 0; i--) {
      const p = c[i];
      if (isTextPart(p)) {
        const next = c.slice();
        next[i] = { ...p, text: p.text + '\n\n' + summary };
        return withContent(m, next);
      }
    }
    return withContent(m, [...c, { type: 'text', text: summary }]);
  }
  return withContent(m, summary);
}

/** What assembly needs from a plan (a working draft of the fit loop is assembled the same way). */
export interface PlanShape {
  cut: number;
  summary: string | null;
  headRewrites: Record<number, Rewrite>;
  rewrites: Record<number, Rewrite> | Map<number, Rewrite>;
}

export interface Assembled {
  messages: ChatMessage[];
  /** original index of each output message; -1 for the summary message */
  origin: number[];
  /** index of the summary in the output (-1: none or merged) */
  summaryAt: number;
}

const rewriteAt = (r: PlanShape['rewrites'], i: number): Rewrite | undefined =>
  r instanceof Map ? r.get(i) : (r as Record<number, Rewrite>)[i];

/** Assembles `plan` onto msgs[0..m) whose head ends at h. */
export function assemble(plan: PlanShape, msgs: readonly ChatMessage[], m: number, h: number, cfg: Config): Assembled {
  const c = Math.max(plan.cut, h);
  const out: ChatMessage[] = [];
  const origin: number[] = [];
  for (let i = 0; i < h; i++) {
    out.push(plan.headRewrites[i]?.message ?? msgs[i]!);
    origin.push(i);
  }
  let summaryAt = -1;
  if (plan.summary !== null) {
    const merge = cfg.compaction.summaryRole === 'merge-into-first-user';
    const j = merge ? out.findIndex((x) => roleOf(x) === 'user') : -1;
    if (j >= 0) out[j] = mergeSummary(out[j]!, plan.summary);
    else {
      summaryAt = out.length;
      out.push(summaryMessage(plan.summary));
      origin.push(-1);
    }
  }
  for (let i = c; i < m; i++) {
    out.push(rewriteAt(plan.rewrites, i)?.message ?? msgs[i]!);
    origin.push(i);
  }
  return { messages: out, origin, summaryAt };
}
