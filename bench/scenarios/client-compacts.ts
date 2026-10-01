// F10 client compactions (bench/README.md): the client itself compacts at step 25, producing the exact OpenCode
// message shapes of reference implementation:
//   [system, user "What did we do so far?", assistant <template-shaped summary>, ...tail (verbatim), user <Continue>]
// The placeholder summary (1,500 tokens) carries CS-ONLY-P4W7Q at 40% and CS-ONLY-T9J2X at 90% of its characters; both
// must survive every later proxy compaction ().
//   cc60-oc            OpenCode client, manual compaction at step 25, short Continue text
//   cc60-oc-overflow   the same, triggered by an overflow: the long Continue text
//   cc60-kilo          Kilo profile (content null on tool-only assistants, <environment_details> on user messages,
//                      post-compaction prune to "[Old tool result content cleared]"): a client mutation counts as
//                      clientRewrite, not as a proxy compaction.
// The HTTP clients (bench/client/opencode.ts) implement the mechanics; this module owns the scenario, the exact
// strings and a reference implementation of the history rebuild (openCodeCompact) that a sim client can apply.

import type { ChatMessage } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { pyDumps, pyLen } from '../lib/pyjson.js';
import { fact, makeSession, type ScenarioContext, type ScenarioDef } from './common.js';
import { OPENCODE_CAP_BYTES, refFacts } from './browser.js';
import { BrowserGen } from './browser-gen.js';

export const CS_MARKERS = { p40: 'CS-ONLY-P4W7Q', p90: 'CS-ONLY-T9J2X' } as const;
export const CC_STEP = 25;
export const CC_SUMMARY_TOKENS = 1500;

/** reference implementation */
export const OC_MARKER_TEXT = 'What did we do so far?';
export const OC_CONTINUE_SHORT = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
export const OC_CONTINUE_LONG =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was " +
  'compacted and media files were removed from context. If the user was asking about attached images or files, ' +
  'explain that the attachments were too large to process and suggest they try again with smaller or fewer files.' +
  '\n\n' + OC_CONTINUE_SHORT;
export const KILO_PRUNED = '[Old tool result content cleared]';

/** gateway-probes content.py ENGLISH (bullet filler). */
const ENGLISH = (
  'the test runner reports that the checkout flow fails when the promo banner loads late so we wait ' +
  'for the element before clicking and then verify the order total matches the expected value after ' +
  'tax and shipping are applied which keeps the spec stable across releases'
).split(' ');

/**
 * The template-shaped placeholder summary (SUMMARY_TEMPLATE sections, in order), about `bullets` filler bullets, with
 * the two CS-ONLY markers inserted as bullets at the line boundaries nearest 40% and 90% of the characters.
 * With the default 77 bullets it is 1,500 ± 3% Qwen3.6 tokens (test/bench/scenario-families.test.ts).
 */
export function clientSummaryText(seed = 1010, bullets = 77): string {
  const rng = new PyRandom(seed);
  const sentence = (): string => {
    const n = rng.randint(10, 18);
    const w: string[] = [];
    for (let i = 0; i < n; i++) w.push(rng.choice(ENGLISH));
    const s = w.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  };
  const sections: Array<[string, number]> = [
    ['## Objective', 0.08], ['## Important Details', 0.22], ['## Work State\n### Completed', 0.24], ['### Active', 0.14],
    ['### Blocked', 0.06], ['## Next Move', 0.12], ['## Relevant Files', 0.14],
  ];
  const lines: string[] = [];
  let left = bullets;
  sections.forEach(([h, share], i) => {
    if (lines.length) lines.push('');
    lines.push(h);
    const n = i === sections.length - 1 ? left : Math.max(1, Math.round(bullets * share));
    left -= n;
    for (let j = 0; j < n; j++) {
      if (h === '## Next Move') lines.push(`${j + 1}. ${sentence()}`);
      else if (h === '## Relevant Files') lines.push(`- src/pages/${rng.choice(['Cart', 'Payment', 'Shipping', 'Review', 'Promo'])}Page.ts: ${sentence()}`);
      else lines.push(`- ${sentence()}`);
    }
  });
  const insertAt = (frac: number, text: string): void => {
    const total = pyLen(lines.join('\n'));
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      acc += pyLen(lines[i]!) + 1;
      if (acc >= frac * total && lines[i + 1]?.startsWith('- ')) {
        lines.splice(i + 1, 0, text);
        return;
      }
    }
    lines.push(text);
  };
  insertAt(0.9, `- ${CS_MARKERS.p90}: the review page keeps its old selectors until the design system release`);
  insertAt(0.4, `- ${CS_MARKERS.p40}: promo specs must run with the staging-3 feature flags file`);
  return lines.join('\n');
}

/** Relative position (0..1) of a marker in a text, in code points. */
export function markerPosition(text: string, marker: string): number {
  const i = text.indexOf(marker);
  return i < 0 ? -1 : pyLen(text.slice(0, i)) / pyLen(text);
}

/**
 * OpenCode's post-compaction history (reference implementation, §2.5) from a client history: drop an earlier
 * marker/summary pair, keep the newest units whose estimate (spaced-JSON chars / 4) fits `preserveTokens` (a unit is
 * a user message, or an assistant plus its tool results; pairs are never split), then
 * [system, marker, summary, ...tail, continue]. With no tail that fits, the tail is empty.
 */
export function openCodeCompact(history: ChatMessage[], summaryText: string, continueText: string, preserveTokens: number): ChatMessage[] {
  const system = history[0]!;
  let body = history.slice(1);
  if (body[0]?.role === 'user' && body[0].content === OC_MARKER_TEXT && body[1]?.role === 'assistant') body = body.slice(2);
  const units: ChatMessage[][] = [];
  for (const m of body) {
    if (m.role === 'tool' && units.length) units[units.length - 1]!.push(m);
    else units.push([m]);
  }
  const est = (ms: ChatMessage[]): number => Math.floor(pyLen(pyDumps(ms, { ensureAscii: false })) / 4);
  let keep = units.length;
  let total = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const e = est(units[i]!);
    if (total + e > preserveTokens) break;
    total += e;
    keep = i;
  }
  const tail = units.slice(keep).flat();
  return [system, { role: 'user', content: OC_MARKER_TEXT }, { role: 'assistant', content: summaryText }, ...tail, { role: 'user', content: continueText }];
}

function build(id: string, client: 'opencode' | 'kilo', trigger: 'manual' | 'overflow', description: string, gates: ScenarioDef['gates']): ScenarioDef {
  const gen = new BrowserGen({ id: 'default', steps: 60, capBytes: OPENCODE_CAP_BYTES });
  const summaryText = clientSummaryText();
  return {
    id, family: 'F10', sessions: [makeSession(gen.script())],
    facts: [
      ...refFacts(false),
      fact('cs-40', CS_MARKERS.p40, 'client-summary', 'survive', true),
      fact('cs-90', CS_MARKERS.p90, 'client-summary', 'survive', true),
    ],
    client, capBytes: OPENCODE_CAP_BYTES, mock: { render: 'sim' },
    events: [{ atStep: CC_STEP, kind: 'client-compact' }],
    clientCompact: { atStep: CC_STEP, trigger, summaryText, summaryTokens: CC_SUMMARY_TOKENS },
    gates, expect: 'complete', windows: ['100k'], description,
  };
}

export function cc60oc(_ctx: ScenarioContext): ScenarioDef {
  return build('cc60-oc', 'opencode', 'manual', 'OpenCode client compacts manually at step 25 (template-shaped 1,500-token summary with CS-ONLY markers at 40%/90%)', ['G2']);
}
export function cc60ocOverflow(_ctx: ScenarioContext): ScenarioDef {
  return build('cc60-oc-overflow', 'opencode', 'overflow', 'as cc60-oc, triggered by an overflow (long Continue text)', []);
}
export function cc60kilo(_ctx: ScenarioContext): ScenarioDef {
  return build('cc60-kilo', 'kilo', 'manual', 'Kilo profile: null content, <environment_details>, post-compaction prune of old tool results', []);
}
