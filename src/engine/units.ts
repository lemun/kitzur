// Head, units and boundaries of a (virtual) request H[0..n) (DESIGN.md).
//
// The head rule (first assistant, trailing prior summaries left out) is derived from gobstopper v0.7.2
// (MIT), crates/gobstopper-adapters/src/request/mod.rs:295-302 and chat.rs:124-127. Units are finer
// than gobstopper's turns (ADR-12, ): every assistant/user/system/developer message starts one.
import type { ChatMessage } from '../types.js';
import type { Config } from '../config/schema.js';
import { SUMMARY_HEADER } from './contracts.js';
import { contentText, firstText, hasToolCalls, isUnitStart, roleOf } from './message.js';

/** A user message that is a prior summary (ours, gobstopper's or CliffCompaction's). */
export const isPriorSummary = (m: ChatMessage): boolean => roleOf(m) === 'user' && contentText(m).startsWith(SUMMARY_HEADER);

/**
 * hEnd of the request msgs[0..n): the first assistant (or n), minus trailing prior summaries, plus
 * one when a client-written summary follows the client's compaction marker (). Pure in msgs[0..hEnd].
 */
export function headEnd(msgs: readonly ChatMessage[], n: number, client: Config['client']): number {
  let h = n;
  for (let i = 0; i < n; i++) {
    if (roleOf(msgs[i]) === 'assistant') {
      h = i;
      break;
    }
  }
  while (h > 0 && isPriorSummary(msgs[h - 1]!)) h--;
  if (h >= 1 && h < n) {
    const s = msgs[h]!;
    const prev = msgs[h - 1]!;
    if (
      roleOf(s) === 'assistant' &&
      !hasToolCalls(s) &&
      client.summaryMarkers.some((mk) => mk.length > 0 && contentText(s).includes(mk)) &&
      roleOf(prev) === 'user' &&
      client.compactionMarkers.includes(firstText(prev).trim())
    ) {
      h++;
    }
  }
  return h;
}

export type UnitKind = 'assistant' | 'user' | 'other';

/** Messages [start, end) of one unit. */
export interface Unit {
  start: number;
  end: number;
  kind: UnitKind;
}

/**
 * Units of msgs[h..n): an assistant/user/system/developer message starts a unit; any other role
 * (tool, function, unknown) attaches to the previous unit, or forms one by itself at h.
 */
export function unitsOf(msgs: readonly ChatMessage[], h: number, n: number): Unit[] {
  const out: Unit[] = [];
  for (let i = h; i < n; i++) {
    const m = msgs[i]!;
    if (i === h || isUnitStart(m)) {
      const r = roleOf(m);
      out.push({ start: i, end: i + 1, kind: r === 'assistant' ? 'assistant' : isUnitStart(m) ? 'user' : 'other' });
    } else {
      out[out.length - 1]!.end = i + 1;
    }
  }
  return out;
}

/**
 * Start of the newest `keep` assistant units and everything after them (the kept-always units for
 * keep = compaction.keepRecent, the mandatory units for keep = 1). With no assistant unit, every unit
 * is kept: the result is h (units[0].start), or n when there are no units.
 */
export function keptStart(units: readonly Unit[], keep: number, h: number): number {
  const k = Math.max(1, Math.floor(keep));
  let seen = 0;
  for (let u = units.length - 1; u >= 0; u--) {
    if (units[u]!.kind !== 'assistant') continue;
    seen++;
    if (seen === k) return units[u]!.start;
  }
  // fewer than k assistant units: keep them all (from the oldest assistant unit), or everything
  for (let u = 0; u < units.length; u++) if (units[u]!.kind === 'assistant') return seen > 0 ? units[u]!.start : h;
  return units.length ? units[0]!.start : h;
}

/**
 * Boundaries of msgs[0..n): every b in [1, n) where msgs[b] is an assistant and msgs[b-1] is not,
 * plus n. Every client request ends at a boundary (§5.1); the fold steps at each one.
 */
export function boundaries(msgs: readonly ChatMessage[]): number[] {
  const n = msgs.length;
  const out: number[] = [];
  for (let b = 1; b < n; b++) if (roleOf(msgs[b]) === 'assistant' && roleOf(msgs[b - 1]) !== 'assistant') out.push(b);
  if (n > 0) out.push(n);
  return out;
}
