// Fact semantics (bench/README.md; ). text(r) = the ensure_ascii=False dump of r.messages; a fact is present in a
// request when its marker occurs in any message's dump (UpstreamRec.facts / ClientRec.facts).
//
//   planted(f)   the first client step k whose C_k (any client main request of the step) contains the marker
//   survive      for every k >= planted(f) that has an upstream attempt: the marker is in text(A_k)
//   latest       the same, until the successor value (supersededBy) is planted
//   absent-after-supersede (fact g, superseding fact j):
//     revived     for some k >= planted(j), the marker is in a SYNTHESIZED message of A_k (not canonically equal to any
//                 message of C_k) whose digest appears in no accepted request of the session before planted(j), i.e.
//                 synthesized content first forwarded at or after the correction
//     resurfaced  absent from text(A_k1) and present in text(A_k2) for planted(g) <= k1 < k2
//     PASS iff neither. Verbatim client messages may keep the marker (I6); a summary synthesized before the correction
//     may keep it until the next compaction replaces it.
//     exercised   (reported) some A_k, k >= planted(j), no longer carries the client message that planted g
//   report-only  presence counted, never gated

import { groupBy, type RunRecords, type UpstreamRec } from './records.js';
import { stepViews, type StepView } from './generic.js';
import type { FactSpec } from '../scenarios/types.js';

export type FactStatus = 'pass' | 'fail' | 'not-planted' | 'no-successor' | 'report';

export interface FactResult {
  id: string;
  marker: string;
  channel: FactSpec['channel'];
  expect: FactSpec['expect'];
  gate: boolean;
  session: string | null;
  planted: number | null;
  status: FactStatus;
  /** steps (>= planted, within range) with an upstream attempt, and how many carried the marker */
  checked: number;
  present: number;
  /** survive / latest / report-only: steps where it was missing */
  missing: number[];
  revivedAt: number | null;
  resurfacedAt: number | null;
  exercised: boolean | null;
}

interface Session {
  views: StepView[];
}

function plantedOf(f: FactSpec, sessions: Map<string, Session>): { session: string; step: number } | null {
  let best: { session: string; step: number } | null = null;
  for (const [s, se] of sessions) {
    for (const v of se.views) {
      if (!v.clientAttempts.some((c) => c.facts.some((m) => m.includes(f.id)))) continue;
      if (!best || v.step < best.step) best = { session: s, step: v.step };
      break;
    }
  }
  return best;
}

const has = (r: UpstreamRec, id: string): boolean => r.facts.some((m) => m.includes(id));

export function factResults(facts: readonly FactSpec[], rr: RunRecords, views: StepView[] = stepViews(rr)): FactResult[] {
  const sessions = new Map<string, Session>();
  for (const [s, vs] of groupBy(views, (v) => v.session)) sessions.set(s, { views: [...vs].sort((a, b) => a.step - b.step) });
  const byId = new Map(facts.map((f) => [f.id, f]));
  const planted = new Map<string, { session: string; step: number } | null>();
  for (const f of facts) planted.set(f.id, plantedOf(f, sessions));

  return facts.map((f): FactResult => {
    const p = planted.get(f.id) ?? null;
    const base: FactResult = {
      id: f.id, marker: f.marker, channel: f.channel, expect: f.expect, gate: f.gate, session: p?.session ?? null,
      planted: p?.step ?? null, status: 'not-planted', checked: 0, present: 0, missing: [], revivedAt: null, resurfacedAt: null,
      exercised: null,
    };
    if (!p) return base;
    const vs = sessions.get(p.session)!.views.filter((v) => v.step >= p.step && v.A !== null);
    const succ = f.supersededBy !== undefined ? (planted.get(f.supersededBy) ?? null) : null;
    if (f.expect === 'survive' || f.expect === 'report-only' || f.expect === 'latest') {
      const end = f.expect === 'latest' && succ ? succ.step : Infinity;
      const range = vs.filter((v) => v.step < end);
      for (const v of range) {
        base.checked++;
        if (has(v.A!, f.id)) base.present++;
        else base.missing.push(v.step);
      }
      base.status = f.expect === 'report-only' ? 'report' : base.missing.length ? 'fail' : 'pass';
      return base;
    }
    // absent-after-supersede
    const j = f.supersededBy !== undefined ? byId.get(f.supersededBy) : undefined;
    if (!j || !succ || succ.session !== p.session) {
      base.status = 'no-successor';
      return base;
    }
    const pj = succ.step;
    const before = new Set<string>();
    for (const v of sessions.get(p.session)!.views)
      if (v.step < pj) for (const a of v.attempts) if (a.status === 200 && !a.streamError) for (const d of a.digests) before.add(d);
    // the client message(s) that planted g (from the planting C)
    const plantV = sessions.get(p.session)!.views.find((v) => v.step === p.step)!;
    const plantC = plantV.clientAttempts.find((c) => c.facts.some((m) => m.includes(f.id)))!;
    const plantDigests = plantC.digests.filter((_, i) => plantC.facts[i]!.includes(f.id));
    let absentSeen = false;
    base.exercised = false;
    for (const v of vs) {
      const A = v.A!;
      const present = has(A, f.id);
      base.checked++;
      if (present) base.present++;
      if (absentSeen && present && base.resurfacedAt === null) base.resurfacedAt = v.step;
      if (!present) absentSeen = true;
      if (v.step >= pj) {
        if (!plantDigests.some((d) => A.digests.includes(d))) base.exercised = true;
        const client = new Set(v.C ? v.C.digests : []);
        A.digests.forEach((d, i) => {
          if (base.revivedAt !== null) return;
          if (!A.facts[i]!.includes(f.id)) return;
          if (client.has(d) || before.has(d)) return;
          base.revivedAt = v.step;
        });
      }
    }
    base.status = base.revivedAt === null && base.resurfacedAt === null ? 'pass' : 'fail';
    return base;
  });
}

/** G2 for one run: every gated fact passes (a gated fact that was never planted fails). */
export function factsGate(results: readonly FactResult[]): { pass: boolean; failed: string[] } {
  const failed = results.filter((r) => r.gate && r.status !== 'pass').map((r) => `${r.id}:${r.status}`);
  return { pass: failed.length === 0, failed };
}

export interface ConfusionRow {
  label: string;
  fact: string;
  intended: 'supersede' | 'keep';
  /** true: superseded and gone; missed: revived/resurfaced; false: a kept instruction lost; not-exercised: the
   * instruction never left the verbatim tail after the correction; kept: correctly kept */
  outcome: 'true' | 'missed' | 'false' | 'not-exercised' | 'kept' | 'not-planted';
}

export function supersessionConfusion(
  cases: ReadonlyArray<{ label: string; fact: string; supersede: boolean }>,
  results: readonly FactResult[],
): { rows: ConfusionRow[]; counts: Record<ConfusionRow['outcome'], number> } {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows = cases.map((c): ConfusionRow => {
    const r = byId.get(c.fact);
    const intended = c.supersede ? 'supersede' : 'keep';
    if (!r || r.status === 'not-planted') return { label: c.label, fact: c.fact, intended, outcome: 'not-planted' };
    if (c.supersede) {
      if (r.status === 'fail') return { label: c.label, fact: c.fact, intended, outcome: 'missed' };
      return { label: c.label, fact: c.fact, intended, outcome: r.exercised ? 'true' : 'not-exercised' };
    }
    return { label: c.label, fact: c.fact, intended, outcome: r.status === 'fail' ? 'false' : 'kept' };
  });
  const counts = { true: 0, missed: 0, false: 0, 'not-exercised': 0, kept: 0, 'not-planted': 0 };
  for (const r of rows) counts[r.outcome]++;
  return { rows, counts };
}
