// F13 restart (bench/README.md): restart variants of qa46 (not of the F6 scenario rs46): the system under test is
// restarted before the requests of step 10 (gobstopper tuned's and kitzur's first compaction step on qa46 at 100k) and
// of step 23 (mid-epoch). Control = qa46. Divergence = requests whose canonical upstream body differs from the control;
// it must be 0 for sigterm and sigkill (I5); freshstate (the state dir wiped) is reported.

import { makeSession, type ScenarioContext, type ScenarioDef } from './common.js';
import { OPENCODE_CAP_BYTES, qaWithO1 } from './browser.js';

export const RESTART_STEPS = [10, 23] as const;

function build(id: string, kind: 'sigterm' | 'sigkill' | 'fresh-state'): ScenarioDef {
  const { script, facts } = qaWithO1({ id, steps: 46 });
  return {
    id, family: 'F13', sessions: [makeSession(script)], facts: facts.map((f) => ({ ...f, gate: false })), client: 'sim',
    capBytes: OPENCODE_CAP_BYTES, mock: { render: 'sim' },
    events: RESTART_STEPS.map((atStep) => ({ atStep, kind })),
    gates: kind === 'fresh-state' ? [] : ['I5'], expect: 'complete', windows: ['100k', '64k', '32k'], controlOf: 'qa46',
    description: `qa46 with a ${kind} restart before steps ${RESTART_STEPS.join(' and ')}`,
  };
}

export const rs46Sigterm = (_ctx: ScenarioContext): ScenarioDef => build('rs46-sigterm', 'sigterm');
export const rs46Sigkill = (_ctx: ScenarioContext): ScenarioDef => build('rs46-sigkill', 'sigkill');
export const rs46Freshstate = (_ctx: ScenarioContext): ScenarioDef => build('rs46-freshstate', 'fresh-state');
