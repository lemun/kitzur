// F8 interleave (bench/README.md): `il3x46` and `il3x46-conc`: three BROWSER sessions with seeds 1, 2, 3, distinct
// goals and facts, interleaved round-robin (or seeded with 3 requests in flight for -conc), each keyed by its own
// session id (X-Session-Id on the wire). Each session's upstream bodies must be canonically equal to its solo run:
// the solo scenarios il3x46-solo-s1..s3 are the controls.

import { fact, makeSession, MarkerFactory, type ScenarioContext, type ScenarioDef, type SessionScript } from './common.js';
import { OPENCODE_CAP_BYTES } from './browser.js';
import { BrowserGen } from './browser-gen.js';
import type { FactSpec } from './types.js';

export const IL_SEEDS = [1, 2, 3] as const;
const AREAS = ['cart', 'payment', 'shipping'] as const;

function ilSession(seed: number): { script: SessionScript; facts: FactSpec[] } {
  const mf = new MarkerFactory(8000 + seed);
  const goal = mf.make(`GOAL-S${seed}`);
  const dec = mf.make(`DECISION-S${seed}`);
  const unf = mf.make(`UNFINISHED-S${seed}`);
  const rule = mf.make(`RULE-S${seed}`);
  const area = AREAS[seed - 1]!;
  const gen = new BrowserGen({
    id: `s${seed}`,
    steps: 46,
    seedOffset: seed * 1_000_000,
    capBytes: OPENCODE_CAP_BYTES,
    goalText:
      `Task ${goal}: migrate the ${area} E2E specs (tests/e2e/${area}/*.spec.ts) to the page-object pattern under src/pages/, ` +
      `then make every ${area} spec pass against staging-3 using the Playwright MCP browser. Do not change application code.`,
    fixedTexts: new Map([
      [2, `${dec}: the ${area} page objects expose one locator getter per control; no raw selectors in specs. Opening the ${area} page now.`],
      [14, `The ${area} page objects are migrated. ${unf}: one ${area} spec is still flaky; I will return to it after the review page.`],
    ]),
    userInject: new Map([[9, `Important, ${rule}: keep the ${area} fixtures read-only - they are compatibility fixtures.`]]),
  });
  return {
    script: gen.script(),
    facts: [
      fact(`s${seed}-goal`, goal, 'head', 'survive', true),
      fact(`s${seed}-decision`, dec, 'decision', 'survive', true),
      fact(`s${seed}-unfinished`, unf, 'assistant', 'survive', true),
      fact(`s${seed}-rule`, rule, 'user', 'survive', true),
    ],
  };
}

function build(id: string, seeds: readonly number[], interleave: ScenarioDef['interleave'], description: string, gates: ScenarioDef['gates']): ScenarioDef {
  const parts = seeds.map((s) => ilSession(s));
  const def: ScenarioDef = {
    id, family: 'F8', sessions: parts.map((p) => makeSession(p.script)), facts: parts.flatMap((p) => p.facts),
    client: 'sim', capBytes: OPENCODE_CAP_BYTES, mock: { render: 'sim' }, gates, expect: 'complete', windows: ['100k'], description,
  };
  if (interleave !== undefined) def.interleave = interleave;
  if (seeds.length > 1) def.soloOf = Object.fromEntries(seeds.map((s) => [`s${s}`, `il3x46-solo-s${s}`]));
  return def;
}

export function il3x46(_ctx: ScenarioContext): ScenarioDef {
  return build('il3x46', IL_SEEDS, 'round-robin', 'three BROWSER sessions (seeds 1-3), round-robin, one request in flight', ['G1']);
}

export function il3x46Conc(_ctx: ScenarioContext): ScenarioDef {
  return build('il3x46-conc', IL_SEEDS, { seed: 83, concurrent: 3 }, 'three BROWSER sessions (seeds 1-3), seeded order, 3 requests in flight', ['G1']);
}

export const ilSoloBuilders: Record<string, (ctx: ScenarioContext) => ScenarioDef> = Object.fromEntries(
  IL_SEEDS.map((s) => [`il3x46-solo-s${s}`, (_ctx: ScenarioContext) => build(`il3x46-solo-s${s}`, [s], undefined, `session s${s} of il3x46 alone (control)`, [])]),
);
