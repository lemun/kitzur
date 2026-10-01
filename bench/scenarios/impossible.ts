// F14 impossible requests (bench/README.md), at 32k/8k:
//   imp-tools   a ~30k-token tools block: the fixed prompt alone exceeds the budget → kitzur answers a 400
//               kitzur_fixed_prompt_too_large (DESIGN.md) and the mock sees 0 requests for that step
//   imp-sys     the same with a ~30k-token system prompt
//   imp-user    a 200,000-char first user message: the head-truncate policy applies and the session completes
// Sizes are calibrated on the Qwen3.6 tokenizer with the sim render (test/bench/scenario-families.test.ts).

import { PyRandom } from '../lib/pyrandom.js';
import { GOAL_TEXT, systemPrompt, tools as referenceTools, type ToolDef, WORDS } from './reference.js';
import { fact, makeSession, MarkerFactory, userMsg, type ScenarioContext, type ScenarioDef, type SessionScript } from './common.js';
import { OPENCODE_CAP_BYTES, refFacts } from './browser.js';
import { BrowserGen } from './browser-gen.js';

const ENGLISH = (
  'the test runner reports that the checkout flow fails when the promo banner loads late so we wait ' +
  'for the element before clicking and then verify the order total matches the expected value after ' +
  'tax and shipping are applied which keeps the spec stable across releases'
).split(' ');

/** Seeded English prose of about `chars` characters (gateway-probes content.py english()). */
export function prose(seed: number, chars: number): string {
  const rng = new PyRandom(seed);
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    const k = rng.randint(8, 20);
    const w: string[] = [];
    for (let i = 0; i < k; i++) w.push(rng.choice(ENGLISH));
    const s = w.join(' ');
    const sent = s.charAt(0).toUpperCase() + s.slice(1) + '. ';
    out.push(sent);
    n += sent.length;
  }
  return out.join('').slice(0, chars);
}

/** Extra tool definitions: `count` tools with `descChars`-char descriptions. */
export function bulkTools(count: number, descChars: number): ToolDef[] {
  const out: ToolDef[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      type: 'function',
      function: {
        name: `mcp_checkout_${WORDS[i % WORDS.length]}_${i}`,
        description: prose(14_000 + i, descChars),
        parameters: { type: 'object', properties: { input: { type: 'string', description: 'the input' } }, required: ['input'] },
      },
    });
  }
  return out;
}

/** Calibrated: the imp-tools tools block / imp-sys system prompt render to about 30,000 tokens (sim render). */
export const IMP_TOOL_COUNT = 40;
export const IMP_TOOL_DESC_CHARS = 3_060;
export const IMP_SYS_CHARS = 142_500;
export const IMP_USER_CHARS = 200_000;

function base(over: Partial<Pick<SessionScript, 'system' | 'tools' | 'goal'>>): SessionScript {
  return { ...new BrowserGen({ id: 'default', steps: 46, capBytes: OPENCODE_CAP_BYTES }).script(), ...over };
}

export function impTools(_ctx: ScenarioContext): ScenarioDef {
  const script = base({ tools: () => [...referenceTools(), ...bulkTools(IMP_TOOL_COUNT, IMP_TOOL_DESC_CHARS)] });
  return {
    id: 'imp-tools', family: 'F14', sessions: [makeSession(script)], facts: refFacts(false), client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: ['G1'], expect: 'impossible-documented', windows: ['32k'],
    description: 'a ~30k-token tools block at 32k/8k: impossible, documented 400 and no upstream request',
  };
}

export function impSys(_ctx: ScenarioContext): ScenarioDef {
  const script = base({ system: () => systemPrompt() + '\n\n## Project handbook\n' + prose(15_000, IMP_SYS_CHARS) });
  return {
    id: 'imp-sys', family: 'F14', sessions: [makeSession(script)], facts: refFacts(false), client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: ['G1'], expect: 'impossible-documented', windows: ['32k'],
    description: 'a ~30k-token system prompt at 32k/8k: impossible, documented 400 and no upstream request',
  };
}

export function impUser(_ctx: ScenarioContext): ScenarioDef {
  const mf = new MarkerFactory(14_014);
  const head = mf.make('IMPU-HEAD');
  const tail = mf.make('IMPU-TAIL');
  const pasted = prose(16_000, IMP_USER_CHARS - 400);
  const text = `(${head}) ${GOAL_TEXT} The full staging-3 log is pasted below.\n\n${pasted}\n\nEnd of the pasted log (${tail}).`;
  const script = base({ goal: () => userMsg(text) });
  return {
    id: 'imp-user', family: 'F14', sessions: [makeSession(script)],
    facts: [...refFacts(false), fact('impu-head', head, 'head', 'report-only', false), fact('impu-tail', tail, 'head', 'report-only', false)],
    client: 'sim', capBytes: OPENCODE_CAP_BYTES, mock: { render: 'sim' }, gates: ['G1'], expect: 'complete', windows: ['32k', '100k'],
    description: 'a 200,000-char first user message: head-truncate policy, completes',
  };
}
