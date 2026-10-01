// F12 no usage (bench/README.md): `nu46` (the client asks for no include_usage) and `nu46-server` (the mock never
// returns usage), both on qa46 (+ O1). Gate G1. The gobstopper side is cross-checked against Python
// F_proposed_nousage in the T0 cross-check (case h), not here.

import { makeSession, type ScenarioContext, type ScenarioDef } from './common.js';
import { OPENCODE_CAP_BYTES, qaWithO1 } from './browser.js';

function build(id: string, server: boolean): ScenarioDef {
  const { script, facts } = qaWithO1({ id, steps: 46 });
  const def: ScenarioDef = {
    id, family: 'F12', sessions: [makeSession(script)], facts: facts.map((f) => ({ ...f, gate: false })), client: 'sim',
    capBytes: OPENCODE_CAP_BYTES, mock: server ? { render: 'sim', usage: 'never' } : { render: 'sim', usage: 'client' },
    gates: ['G1'], expect: 'complete', windows: ['100k'],
    description: server ? 'qa46 with a mock that never returns usage' : 'qa46 with a client that sends no stream_options.include_usage',
  };
  if (!server) def.clientOptions = { includeUsage: false };
  return def;
}

export const nu46 = (_ctx: ScenarioContext): ScenarioDef => build('nu46', false);
export const nu46Server = (_ctx: ScenarioContext): ScenarioDef => build('nu46-server', true);
