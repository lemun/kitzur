// F6 reasoning (bench/README.md): `rs46`. The mock renders the real Qwen3 template and its completion model draws
// seeded reasoning sizes (lognormal, median 1,500, p95 6,000), counted in completion_tokens; the client sends the
// reasoning back (reasoning_content). One fact lives only in reasoning (report-only), one in visible text (survive).
// The scripted replies carry reasoning_content at the fact step; the completion model supplies the drawn sizes.
// Metric of interest: client_compactions = 0 for the OpenCode client through kitzur (benchmark contract ).

import type { ChatMessage } from '../../src/types.js';
import { fact, makeSession, MarkerFactory, type ScenarioContext, type ScenarioDef } from './common.js';
import { OPENCODE_CAP_BYTES, refFacts } from './browser.js';
import { BrowserGen } from './browser-gen.js';

export const RS_REASONING_STEP = 6;
export const RS_TEXT_STEP = 8;

export function rs46(_ctx: ScenarioContext): ScenarioDef {
  const mf = new MarkerFactory(6006);
  const rsn = mf.make('RSN-ONLY');
  const vis = mf.make('VIS-TXT');
  const gen = new BrowserGen({ id: 'default', steps: 46, capBytes: OPENCODE_CAP_BYTES });
  const base = gen.script();
  const script = {
    ...base,
    assistant: (step: number): ChatMessage => {
      const a = base.assistant(step);
      if (step === RS_REASONING_STEP)
        return { ...a, reasoning_content: `${rsn}: the promo banner test id changed in the last deploy, so the old selector list is stale. I should re-read the page object before editing.` };
      if (step === RS_TEXT_STEP) {
        const t = (a.content as string | null) ?? '';
        return { ...a, content: `NOTE: payment page renders the card form lazily (${vis}).` + (t ? `\n${t}` : '') };
      }
      return a;
    },
  };
  return {
    id: 'rs46', family: 'F6', sessions: [makeSession(script)],
    facts: [
      ...refFacts(false),
      fact('rsn-only', rsn, 'reasoning', 'report-only', false),
      fact('visible-text', vis, 'assistant', 'survive', true),
    ],
    client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: {
      render: 'qwen3',
      completionModel: { reasoning: { kind: 'lognormal', median: 1500, p95: 6000 }, text: { kind: 'fixed', value: 0 }, seed: 46 },
    },
    gates: ['G1'], expect: 'complete', windows: ['100k'],
    description: 'BROWSER skeleton, qwen3 render, 500–6,000 reasoning tokens per step (lognormal, seeded), reasoning echoed back',
  };
}
