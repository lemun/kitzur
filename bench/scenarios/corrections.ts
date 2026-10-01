// F9 corrections (bench/README.md): `corr60`, a 60-step BROWSER session rendered by the real Qwen3 template, with a
// user message every 4 steps probing the supersession rule (DESIGN.md, ):
//   (a) shared-ID correction          (b) cue + overlap, no ID        (c) Hebrew cue בעצם
//   (d) A → B → C chain               (e) "not X anymore"             (f) false-positive probe ("... too")
//   (g) a Hebrew false positive: במקום in a non-correcting sense ("in the place where")
// The supersession confusion matrix (true / false / missed) is reported; misses are not gated (G2), false
// supersessions are (the survive facts are gate: true). bench/scenarios/lint.ts recomputes the rule independently
// and asserts it matches `supersession` below.

import { fact, makeSession, userMsg, type ScenarioContext, type ScenarioDef, type SupersessionCase } from './common.js';
import { OPENCODE_CAP_BYTES, refFacts } from './browser.js';
import { BrowserGen } from './browser-gen.js';
import type { FactSpec } from './types.js';

interface Probe {
  id: string;
  step: number;
  text: string;
  marker: string;
}

/** step -> message; one every 4 steps from step 3 (the slot after step 59 is never sent and stays empty). */
export const CORR_PROBES: readonly Probe[] = [
  { id: 'a1', step: 3, marker: 'SA-OLD-M3K7P', text: 'USER-SHOT-A1: attach a full-page screenshot to every failing spec report (SA-OLD-M3K7P).' },
  { id: 'b1', step: 7, marker: 'PB-FF-K2M9Q', text: 'Run the payment specs in the firefox project only (PB-FF-K2M9Q).' },
  { id: 'c1', step: 11, marker: 'HC-OLD-W4P8K', text: 'הרץ את בדיקות העגלה בדפדפן כרום בלבד (HC-OLD-W4P8K).' },
  { id: 'e1', step: 15, marker: 'NM-ON-H7K3P', text: 'Keep the network mock enabled for the payment specs (NM-ON-H7K3P).' },
  { id: 'a2', step: 19, marker: 'SA-NEW-T8W2Q', text: 'Correction for USER-SHOT-A1: attach only the viewport screenshot, not the full page (SA-NEW-T8W2Q).' },
  { id: 'b2', step: 23, marker: 'PB-WK-R7T3N', text: 'Actually, run the payment specs in the webkit project only (PB-WK-R7T3N).' },
  { id: 'd1', step: 27, marker: 'TD-A-P3K8M', text: 'USER-TIMEOUT-D4: set the expect timeout to 5000 ms (TD-A-P3K8M).' },
  { id: 'c2', step: 31, marker: 'HC-NEW-J6N2X', text: 'בעצם, הרץ את בדיקות העגלה בדפדפן פיירפוקס בלבד (HC-NEW-J6N2X).' },
  { id: 'f1', step: 35, marker: 'WK-W2-P5Q', text: 'Run the checkout specs with --workers=2 so the staging server is not overloaded (WK-W2-P5Q)' },
  { id: 'e2', step: 39, marker: 'NM-OFF-B2Q8W', text: 'The network mock is not needed anymore for the payment specs (NM-OFF-B2Q8W).' },
  { id: 'd2', step: 43, marker: 'TD-B-X5N2R', text: 'Actually, for USER-TIMEOUT-D4 use 8000 ms instead (TD-B-X5N2R).' },
  { id: 'f2', step: 47, marker: 'HD-H1-M3Z', text: 'Actually, run the checkout specs in headed mode too, so I can watch them (HD-H1-M3Z)' },
  { id: 'g1', step: 51, marker: 'HG-FP-N4R7K', text: 'שמור את קובצי הלוג במקום שבו נשמרים דוחות הבדיקה (HG-FP-N4R7K).' },
  { id: 'd3', step: 55, marker: 'TD-C-Q9W4T', text: 'Correction for USER-TIMEOUT-D4: use 10000 ms (TD-C-Q9W4T).' },
];

export const CORR_CASES: readonly SupersessionCase[] = [
  { label: '(a) shared ID', fact: 'corr-a1', by: 'corr-a2', supersede: true },
  { label: '(b) cue + overlap, no ID', fact: 'corr-b1', by: 'corr-b2', supersede: true },
  { label: '(c) Hebrew cue בעצם', fact: 'corr-c1', by: 'corr-c2', supersede: true },
  { label: '(d) chain A→B', fact: 'corr-d1', by: 'corr-d2', supersede: true },
  { label: '(d) chain B→C', fact: 'corr-d2', by: 'corr-d3', supersede: true },
  { label: '(e) "not X anymore"', fact: 'corr-e1', by: 'corr-e2', supersede: true },
  { label: '(f) false-positive probe ("too")', fact: 'corr-f1', by: 'corr-f2', supersede: false },
  { label: '(g) Hebrew במקום, non-correcting', fact: 'corr-g1', by: null, supersede: false },
];

export function corr60(_ctx: ScenarioContext): ScenarioDef {
  const gen = new BrowserGen({ id: 'default', steps: 60, capBytes: OPENCODE_CAP_BYTES });
  const base = gen.script();
  const byStep = new Map(CORR_PROBES.map((p) => [p.step, p]));
  const script = { ...base, users: (s: number) => (byStep.has(s) ? [...base.users(s), userMsg(byStep.get(s)!.text)] : base.users(s)) };
  const supersededBy = new Map<string, string>();
  for (const c of CORR_CASES) if (c.supersede && c.by) supersededBy.set(c.fact, c.by);
  const facts: FactSpec[] = CORR_PROBES.map((p) => {
    const id = `corr-${p.id}`;
    const by = supersededBy.get(id);
    // misses are reported, not gated; a false supersession of a surviving instruction is gated
    return by ? fact(id, p.marker, 'user', 'absent-after-supersede', false, by) : fact(id, p.marker, 'user', 'survive', true);
  });
  return {
    id: 'corr60', family: 'F9', sessions: [makeSession(script)], facts: [...refFacts(false), ...facts], client: 'sim',
    capBytes: OPENCODE_CAP_BYTES, mock: { render: 'qwen3' }, gates: ['G2'], expect: 'complete', windows: ['100k', '64k', '32k'],
    supersession: [...CORR_CASES],
    description: '60 BROWSER steps (qwen3 render) with a supersession probe every 4 steps: shared ID, cue+overlap, Hebrew cue, chain, "not anymore", two false-positive probes',
  };
}
