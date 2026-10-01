// F2 talkative (bench/README.md): talk80-ref (SIM_CHATTY=1, cap 51200, 80 steps; byte-exact, the 7 reference facts),
// talk80 (+ O1), talk200 (+ O1 + the retry chain), and the qwen3-render realism variant of talk80.

import { makeSession, type ScenarioContext, type ScenarioDef } from './common.js';
import { ALL_WINDOWS, OPENCODE_CAP_BYTES, qaWithO1, referenceScenario } from './browser.js';

export function talk80Ref(_ctx: ScenarioContext): ScenarioDef {
  return referenceScenario('talk80-ref', 'F2', 80, { capBytes: OPENCODE_CAP_BYTES, chatty: true }, {
    gates: ['T0', 'G2'],
    windows: ALL_WINDOWS,
    description: 'SIM_CHATTY=1, cap 51200, 80 steps (Python 14 / 3,347,391 / 61,697 with gobstopper tuned)',
  });
}

export function talk80(_ctx: ScenarioContext): ScenarioDef {
  const { script, facts } = qaWithO1({ id: 'talk80', steps: 80, chatty: true });
  return {
    id: 'talk80', family: 'F2', sessions: [makeSession(script)], facts, client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: ['G2'], expect: 'complete', windows: ALL_WINDOWS,
    description: 'talk80-ref + O1',
  };
}

export function talk200(_ctx: ScenarioContext): ScenarioDef {
  const { script, facts } = qaWithO1({ id: 'talk200', steps: 200, chatty: true, chain: true });
  return {
    id: 'talk200', family: 'F2', sessions: [makeSession(script)], facts, client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: [], expect: 'complete', windows: ALL_WINDOWS,
    description: '200 chatty steps + O1 + retry chain',
  };
}


/** Realism variant (benchmark contract ; ): the mock renders the real Qwen template. Report-only. */
export function talk80Qwen3(ctx: ScenarioContext): ScenarioDef {
  const s = talk80(ctx);
  return { ...s, id: 'talk80-qwen3', mock: { render: 'qwen3' }, gates: [], windows: ['100k'], realism: true,
    description: 'talk80 with the mock rendering the Qwen3 template (realism table)' };
}
