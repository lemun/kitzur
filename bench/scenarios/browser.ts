// F1 BROWSER (bench/README.md): qa46-ref (byte-exact scenario.py, cap 51200, the 7 reference facts), qa46 (+ O1),
// qa150 (+ O1 + the retry chain). Also the shared BROWSER builders other families start from.

import {
  assistantMessage, FACTS, GOAL_TEXT, systemPrompt, toolOutput, tools as referenceTools, USER_INJECT, type ScenarioOptions,
} from './reference.js';
import { fact, makeSession, userMsg, type ScenarioContext, type ScenarioDef, type SessionScript } from './common.js';
import { applyChain, applyO1, chainFacts, latestFacts, latestHooks, latestSeries, o1Facts, type Lang } from './overlay.js';
import { BrowserGen, type BrowserGenOptions } from './browser-gen.js';
import type { FactSpec } from './types.js';

export const OPENCODE_CAP_BYTES = 51_200;

/** The 7 reference facts (scenario.py FACTS), ids = analyze.py short names; channels per benchmark contract */
export const REF_FACT_CHANNELS: Readonly<Record<string, FactSpec['channel']>> = {
  'GOAL-CHK-7F3A': 'head',
  'DECISION-D42': 'decision',
  'USER-RULE-Q7': 'user',
  'UNFINISHED-9K': 'assistant',
  'TODO-P3-RETRY': 'todo',
  'src/pages/legacy/PromoBanner.ts': 'arg-path',
  'staging-3.override.yaml': 'output-path',
};
const REF_IDS: Readonly<Record<string, string>> = {
  'GOAL-CHK-7F3A': 'goal',
  'DECISION-D42': 'decision',
  'USER-RULE-Q7': 'user-rule',
  'UNFINISHED-9K': 'unfinished(text)',
  'TODO-P3-RETRY': 'unfinished(todo)',
  'src/pages/legacy/PromoBanner.ts': 'path(call arg)',
  'staging-3.override.yaml': 'path(tool output)',
};

/** The reference facts; `gate` false on variants where O1 is the gated set. */
export function refFacts(gate: boolean): FactSpec[] {
  return FACTS.map(([marker]) => fact(REF_IDS[marker]!, marker, REF_FACT_CHANNELS[marker]!, 'survive', gate));
}

/** scenario.py itself (reference.ts), unchanged: the byte-exact `-ref` session. */
export function referenceScript(id: string, steps: number, o: ScenarioOptions): SessionScript {
  return {
    id,
    seed: 0,
    steps,
    system: () => systemPrompt(),
    tools: () => referenceTools(),
    goal: () => userMsg(GOAL_TEXT),
    assistant: (step) => assistantMessage(step, o),
    results: (step) => [toolOutput(step, o)],
    users: (step) => {
      const t = USER_INJECT.get(step);
      return t === undefined ? [] : [userMsg(t)];
    },
  };
}

/** A byte-exact reference scenario (nothing planted: benchmark contract ). */
export function referenceScenario(
  id: string, family: ScenarioDef['family'], steps: number, o: ScenarioOptions, extra: Partial<ScenarioDef> & Pick<ScenarioDef, 'gates' | 'windows' | 'description'>,
): ScenarioDef {
  return {
    id,
    family,
    sessions: [makeSession(referenceScript('default', steps, o))],
    facts: refFacts(true),
    client: 'sim',
    capBytes: o.capBytes ? o.capBytes : null,
    mock: { render: 'sim' },
    expect: 'complete',
    reference: { ...o },
    ...extra,
  };
}

export interface QaVariantOptions {
  id: string;
  steps: number;
  capBytes?: number | null;
  chatty?: boolean;
  lang?: Lang;
  chain?: boolean;
  gen?: Partial<BrowserGenOptions>;
  /** seed of the latest-series codes */
  latestSeed?: number;
}

/** A BROWSER session with O1 (and optionally the chain): its script and its facts. */
export function qaWithO1(v: QaVariantOptions): { script: SessionScript; facts: FactSpec[] } {
  const skip = v.gen?.hugeAt !== undefined && v.gen.hugeAt !== null ? [v.gen.hugeAt] : [];
  const series = latestSeries(v.steps, v.latestSeed ?? 4242, skip);
  const capBytes = v.capBytes === undefined ? OPENCODE_CAP_BYTES : v.capBytes;
  // every input of the content: the hooks are functions of (steps, latestSeed, skip)
  const cacheKey = JSON.stringify(['qaWithO1', v.steps, capBytes, v.chatty ?? false, v.latestSeed ?? 4242, skip, v.gen ?? {}]);
  const gen = new BrowserGen({
    id: 'default',
    steps: v.steps,
    capBytes,
    chatty: v.chatty ?? false,
    ...latestHooks(series),
    ...(v.gen ?? {}),
    ...(hasFunctions(v.gen) ? {} : { cacheKey }),
  });
  let script = applyO1(gen.script(), v.lang ?? 'en');
  const facts = [...refFacts(false), ...o1Facts(), ...latestFacts(series)];
  if (v.chain) {
    script = applyChain(script);
    facts.push(...chainFacts());
  }
  return { script, facts };
}

const hasFunctions = (o: object | undefined): boolean => !!o && Object.values(o).some((x) => typeof x === 'function');

export const ALL_WINDOWS: ScenarioDef['windows'] = ['100k', '64k', '32k', '128k'];

export function qa46Ref(_ctx: ScenarioContext): ScenarioDef {
  return referenceScenario('qa46-ref', 'F1', 46, { capBytes: OPENCODE_CAP_BYTES }, {
    gates: ['T0', 'G1', 'G2', 'G3', 'G4'],
    windows: ALL_WINDOWS,
    description: 'byte-exact scenario.py, SIM_CAP_BYTES=51200, 46 steps; the 7 reference facts',
  });
}

export function qa46(_ctx: ScenarioContext): ScenarioDef {
  const { script, facts } = qaWithO1({ id: 'qa46', steps: 46 });
  return {
    id: 'qa46', family: 'F1', sessions: [makeSession(script)], facts, client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: ['G1', 'G2', 'G3', 'G4'], expect: 'complete', windows: ALL_WINDOWS,
    description: 'qa46-ref + O1 (superseded viewport, NOTE, dropped todo, latest URL/tally)',
  };
}

export function qa150(_ctx: ScenarioContext): ScenarioDef {
  const { script, facts } = qaWithO1({ id: 'qa150', steps: 150, chain: true });
  return {
    id: 'qa150', family: 'F1', sessions: [makeSession(script)], facts, client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: [], expect: 'complete', windows: ALL_WINDOWS,
    description: '150 BROWSER steps + O1 + retry chain RT-A → RT-B (step 60) → RT-C (step 110)',
  };
}

/** Realism variants (benchmark contract ; ): the mock renders the real Qwen template. Report-only. */
export function qa46RefQwen3(ctx: ScenarioContext): ScenarioDef {
  const s = qa46Ref(ctx);
  return { ...s, id: 'qa46-ref-qwen3', mock: { render: 'qwen3' }, gates: [], windows: ['100k'], realism: true,
    description: 'qa46-ref with the mock rendering the Qwen3 template (realism table)' };
}
