// Tool-call pairing defects (DESIGN.md I1, §5.8). The walk follows gobstopper v0.7.2 (MIT)
// pairing_intact for Chat, crates/gobstopper-adapters/src/request/replay.rs:612-654: keep the pending
// call ids of the latest assistant; a tool message must answer one of them; any other message while
// calls are pending is a defect; calls still pending at the end are allowed (the live edge).
//
// Instead of a boolean, the defects are returned as a multiset of strings keyed by call id, so that
// "the output's defect set is a subset of the input's" can be checked across index shifts.
import type { ChatMessage } from '../types.js';
import { roleOf, toolCallsOf } from './message.js';

const idOf = (x: unknown): string => (typeof x === 'string' ? x : x === undefined || x === null ? '<none>' : JSON.stringify(x));

/** Multiset of defects: `orphan:<id>` (a result nobody asked for), `unanswered:<id>` (a call whose
 *  result does not follow it), `dup:<id>` (a call id repeated within one assistant message). */
export function pairingDefects(msgs: readonly ChatMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (d: string): void => {
    out.set(d, (out.get(d) ?? 0) + 1);
  };
  let pending = new Map<string, number>();
  for (const m of msgs) {
    const role = roleOf(m);
    if (role === 'tool') {
      const id = idOf(m.tool_call_id);
      const c = pending.get(id);
      if (c === undefined) add('orphan:' + id);
      else if (c > 1) pending.set(id, c - 1);
      else pending.delete(id);
      continue;
    }
    if (pending.size) {
      for (const [id, c] of pending) for (let k = 0; k < c; k++) add('unanswered:' + id);
      pending = new Map();
    }
    if (role === 'assistant') {
      for (const call of toolCallsOf(m)) {
        const id = idOf(call.id);
        const c = pending.get(id) ?? 0;
        if (c > 0) add('dup:' + id);
        pending.set(id, c + 1);
      }
    }
  }
  return out;
}

/** True when every defect of `out` occurs in `inp` at least as often. */
export function defectsSubset(out: Map<string, number>, inp: Map<string, number>): boolean {
  for (const [d, c] of out) if ((inp.get(d) ?? 0) < c) return false;
  return true;
}

/** First defect of `out` that `inp` does not have (for guard reasons), or null. */
export function newDefect(out: Map<string, number>, inp: Map<string, number>): string | null {
  for (const [d, c] of out) if ((inp.get(d) ?? 0) < c) return d;
  return null;
}
