// F4 huge outputs (bench/README.md): SIM_HUGE_AT=20 as in the Python H_* runs (uncapped; the step-20 test call gets
// one huge snapshot), plus O1, plus markers in the huge output's first 200 chars and last 200 chars (survive) and in its
// middle (report-only).
//   huge150k / huge180k / huge400k      snapshot of 150k / 180k / 400k chars, uncapped
//   huge400k-cap51200                    the same through the 51,200-byte client cap (only the head marker is sent)
//   huge180k-test                        a non-snapshot test log instead (nothing to slim)
//   huge180k-user                        huge180k + a user message right after the huge result ()

import { fact, makeSession, MarkerFactory, userMsg, type ScenarioContext, type ScenarioDef } from './common.js';
import { qaWithO1 } from './browser.js';
import type { FactSpec } from './types.js';

export const HUGE_AT = 20;

interface HugeVariant {
  id: string;
  chars: number;
  capBytes: number | null;
  kind: 'snapshot' | 'test';
  user: boolean;
  gates: ScenarioDef['gates'];
  description: string;
}

const VARIANTS: HugeVariant[] = [
  { id: 'huge150k', chars: 150_000, capBytes: null, kind: 'snapshot', user: false, gates: [], description: '150k-char snapshot at step 20, uncapped, + O1' },
  { id: 'huge180k', chars: 180_000, capBytes: null, kind: 'snapshot', user: false, gates: ['G5'], description: '180k-char snapshot at step 20, uncapped, + O1' },
  { id: 'huge400k', chars: 400_000, capBytes: null, kind: 'snapshot', user: false, gates: [], description: '400k-char snapshot at step 20, uncapped, + O1' },
  { id: 'huge400k-cap51200', chars: 400_000, capBytes: 51_200, kind: 'snapshot', user: false, gates: [], description: '400k-char snapshot through the 51,200-byte client cap, + O1' },
  { id: 'huge180k-test', chars: 180_000, capBytes: null, kind: 'test', user: false, gates: [], description: '180k-char test log (non-snapshot) at step 20, uncapped, + O1' },
  { id: 'huge180k-user', chars: 180_000, capBytes: null, kind: 'snapshot', user: true, gates: ['G1'], description: 'huge180k + a user message right after the huge result ()' },
];

export const HUGE_IDS: readonly string[] = VARIANTS.map((v) => v.id);

function build(v: HugeVariant): ScenarioDef {
  const mf = new MarkerFactory(20_000 + v.chars / 1000 + (v.capBytes ? 1 : 0) + (v.kind === 'test' ? 2 : 0) + (v.user ? 4 : 0));
  const head = mf.make('HUGE-HEAD');
  const mid = mf.make('HUGE-MID');
  const tail = mf.make('HUGE-TAIL');
  const userMarker = mf.make('USR-AFTER');
  const { script, facts } = qaWithO1({
    id: v.id,
    steps: 46,
    capBytes: v.capBytes,
    gen: { hugeAt: HUGE_AT, hugeChars: v.chars, hugeKind: v.kind, hugeMarkers: { head, mid, tail } },
  });
  const hf: FactSpec[] = [fact('huge-head', head, 'output-head', 'survive', true)];
  // Through the client cap only the head of the output is ever sent: the middle and tail markers never exist.
  if (!v.capBytes) {
    hf.push(fact('huge-tail', tail, 'output-tail', 'survive', true));
    hf.push(fact('huge-mid', mid, 'output-mid', 'report-only', false));
  }
  let s = script;
  if (v.user) {
    const text = `Keep going with the checkout specs; the orders export above is only background (${userMarker}).`;
    s = { ...script, users: (step) => (step === HUGE_AT ? [...script.users(step), userMsg(text)] : script.users(step)) };
    hf.push(fact('huge-user', userMarker, 'user', 'survive', true));
  }
  return {
    id: v.id, family: 'F4', sessions: [makeSession(s)], facts: [...facts, ...hf], client: 'sim', capBytes: v.capBytes,
    mock: { render: 'sim' }, gates: v.gates, expect: 'complete', windows: ['100k', '64k', '32k'], description: v.description,
  };
}

export const hugeBuilders: Record<string, (ctx: ScenarioContext) => ScenarioDef> = Object.fromEntries(
  VARIANTS.map((v) => [v.id, (_ctx: ScenarioContext) => build(v)]),
);
