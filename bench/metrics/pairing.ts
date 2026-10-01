// Pairing, client-visible errors and client-compaction headroom (bench/README.md).
//
//  pairing      strict positional pairing of every forwarded request: its defect set (bench/lib/pairing-strict.ts,
//               keyed by tool_call_id and position) must be a subset of its client request's
//  errors       client-visible errors (), one `client_error_kind` per client request: non-200, in-stream error
//               events, streams with neither [DONE] nor finish_reason, finish_reason "length" with no tool call
//  headroom     max(prompt + completion) over accepted main requests − usable, usable = W − min(O, 32000) (the
//               OpenCode client's own compaction point); negative = the client's compaction stayed idle ()

import { defectsSubset, strictPairingDefects } from '../lib/pairing-strict.js';
import type { ClientRec, RunRecords, UpstreamRec } from './records.js';
import { stepViews, type StepView } from './generic.js';

export { strictPairingDefects, defectsSubset };

export interface PairingReport {
  checked: number;
  /** forwarded requests whose defects are not a subset of their client request's */
  violations: Array<{ session: string; step: number; seq: number; extra: string[] }>;
  /** forwarded requests with any strict defect (a subset of the client's is allowed) */
  withDefects: number;
}

export function pairingReport(rr: RunRecords, views: StepView[] = stepViews(rr)): PairingReport {
  const out: PairingReport = { checked: 0, violations: [], withDefects: 0 };
  for (const v of views) {
    for (const a of v.attempts) {
      out.checked++;
      if (a.pairingStrict.length) out.withDefects++;
      const input = v.C ? v.C.pairingStrict : [];
      if (!defectsSubset(a.pairingStrict, input)) {
        const s = new Set(input);
        out.violations.push({ session: a.session, step: a.step, seq: a.seq, extra: a.pairingStrict.filter((d) => !s.has(d)) });
      }
    }
  }
  return out;
}

/** The classes of benchmark contract (the strict client assigns them; this is the reference classification). */
export type ClientErrorKind = 'http' | 'stream_error' | 'truncated_stream' | 'length_no_tool' | 'transport';

export interface ClientErrorInput {
  status: number | null;
  /** a data:/error: event whose top-level object has `error` */
  sawErrorEvent?: boolean;
  sawDone?: boolean;
  finishReason?: string | null;
  toolCalls?: number;
  stream?: boolean;
}

/** benchmark contract client_error_kind for one response (null = none). */
export function classifyClientError(r: ClientErrorInput): string | null {
  if (r.status === null) return 'transport';
  if (r.status !== 200) return `http_${r.status}`;
  if (r.sawErrorEvent) return 'stream_error';
  if (r.stream !== false && !r.sawDone && !r.finishReason) return 'truncated_stream';
  if (r.finishReason === 'length' && !(r.toolCalls ?? 0)) return 'length_no_tool';
  return null;
}

export interface ErrorsReport {
  total: number;
  byKind: Record<string, number>;
  first: { session: string; step: number; kind: string } | null;
}

export function clientErrors(client: readonly ClientRec[]): ErrorsReport {
  const byKind: Record<string, number> = {};
  let first: ErrorsReport['first'] = null;
  let total = 0;
  for (const c of client) {
    if (c.clientErrorKind === null) continue;
    total++;
    byKind[c.clientErrorKind] = (byKind[c.clientErrorKind] ?? 0) + 1;
    first ??= { session: c.session, step: c.step, kind: c.clientErrorKind };
  }
  return { total, byKind, first };
}

export interface Headroom {
  usable: number;
  maxTotal: number;
  /** maxTotal − usable (negative: the client's own compaction never triggered on reported usage) */
  headroom: number;
  at: { session: string; step: number } | null;
}

/** Headroom against the OpenCode client's compaction point, on the usage the mock reports (prompt + completion). */
export function headroom(up: readonly UpstreamRec[], window: { W: number; O: number }): Headroom {
  const usable = window.W - Math.min(window.O, 32_000);
  let m = 0;
  let at: Headroom['at'] = null;
  for (const r of up) {
    if (r.kind !== 'main' || r.status !== 200) continue;
    const t = r.prompt + (r.completion ?? 0);
    if (t > m) {
      m = t;
      at = { session: r.session, step: r.step };
    }
  }
  return { usable, maxTotal: m, headroom: m - usable, at };
}
