// Fact survival on the reference scenario (bench/scenarios/reference.ts, the byte-exact scenario.py port):
// summaries rendered at the cut a compaction makes at gobstopper's compaction steps (BROWSER-46) and at every step
// 10..79 of the chatty 80-step variant (Talk-80), at the §6.4 summary budget of each window, must carry every
// reference fact whose planting message was summarized. An O1-style overlay on a copy of the history plants a
// superseded instruction and a dropped todo that must stay absent once their correction exists.
//
// Set KITZUR_SUMMARY_REPORT=<file> to write the per-window, per-step summary sizes as a markdown table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { ChatMessage } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { createSummarizerExt, type SummarizerExt } from '../../src/engine/summary.js';
import { FACT_KEYS, GOAL_TEXT, type ScenarioOptions } from '../../bench/scenarios/reference.js';
import { digests, exactCounter, lastAssistant, referenceHistory, referenceSession } from './helpers.js';

const WINDOWS = [
  { name: '100k/32k', budget: 67_000 },
  { name: '64k/16k', budget: 47_360 },
  { name: '32k/8k', budget: 23_488 },
] as const;
const GOB_STEPS = [10, 17, 22, 27, 32, 37, 43];
const TALK_STEPS = Array.from({ length: 70 }, (_, i) => 10 + i);
const BROWSER: ScenarioOptions = { capBytes: 51200 };
const TALK: ScenarioOptions = { capBytes: 51200, chatty: true };
const HEND = 2; // [system, goal]
const floorFrac = (x: number, f: number): number => Math.floor(x * f + 1e-9);

/** First message index whose content or tool-call arguments contain the marker (-1 if none). */
function plantedAt(msgs: ChatMessage[], marker: string): number {
  return msgs.findIndex((m) => JSON.stringify([m.content ?? null, m.tool_calls ?? null]).includes(marker));
}

interface Row {
  window: string;
  variant: string;
  step: number;
  cut: number;
  floor: number;
  summaryBudget: number;
  tokens: number;
  kept: number;
  dropped: number;
}

/** §6.4: summaryBudget = min(max(floorTokens, floor(budget·summaryFraction)), floor(budget·summaryMaxFraction)). */
function renderAtSummaryBudget(S: SummarizerExt, msgs: ChatMessage[], d: string[], cut: number, budget: number) {
  const x = { messages: msgs, digests: d, hEnd: HEND, cut, compaction: 1 };
  const c = DEFAULT_CONFIG.compaction;
  const base = floorFrac(budget, c.summaryFraction);
  const probe = S.render(x, { budgetTokens: base, allowFloorEviction: false, userShortenStep: 0 });
  const summaryBudget = Math.min(Math.max(probe.floorTokens, base), floorFrac(budget, c.summaryMaxFraction));
  const r = S.render(x, { budgetTokens: summaryBudget, allowFloorEviction: false, userShortenStep: 0 });
  return { r, summaryBudget };
}

/** Every step's request, sliced out of one build of the session. */
function steps(o: ScenarioOptions, last: number, which: number[], extra?: ReadonlyMap<number, string[]>, patch?: (m: ChatMessage[]) => void) {
  const { msgs, lenAt } = referenceSession(last, o, extra);
  patch?.(msgs);
  const d = digests(msgs);
  return which.map((step) => ({ step, msgs: msgs.slice(0, lenAt[step]), d: d.slice(0, lenAt[step]) }));
}

const rows: Row[] = [];

for (const template of ['sim', 'qwen3'] as const) {
  const counter = exactCounter(template);
  test(`reference facts survive every summary: BROWSER-46 at gobstopper's steps, Talk-80 at every step 10..79 (${template})`, { skip: counter ? false : 'no dev tokenizer.json' }, () => {
    const S = createSummarizerExt(structuredClone(DEFAULT_CONFIG), counter!);
    const facts = FACT_KEYS.filter((f) => f !== 'GOAL-CHK-7F3A');
    let checks = 0;
    const variants: Array<[string, ScenarioOptions, number[]]> = [['qa46-ref', BROWSER, GOB_STEPS], ['talk80-ref', TALK, template === 'sim' ? TALK_STEPS : GOB_STEPS]];
    for (const [variant, o, which] of variants) {
      const all = steps(o, which[which.length - 1]!, which);
      // slicing one build equals what the bench client sends at that step
      assert.deepEqual(all[0]!.msgs, referenceHistory(which[0]!, o));
      for (const { step, msgs, d } of all) {
        const cut = lastAssistant(msgs);
        assert.equal(msgs[1]!.content, GOAL_TEXT); // GOAL-CHK-7F3A lives in the head, forwarded verbatim
        for (const w of WINDOWS) {
          const { r, summaryBudget } = renderAtSummaryBudget(S, msgs, d, cut, w.budget);
          const text = r.text!;
          assert.ok(r.floorTokens <= floorFrac(w.budget, 0.25), `${variant} ${w.name} step ${step}: floor ${r.floorTokens} above the cap`);
          assert.ok(r.tokens <= summaryBudget, `${variant} ${w.name} step ${step}: ${r.tokens} > ${summaryBudget}`);
          for (const f of facts) {
            const p = plantedAt(msgs, f);
            if (p >= HEND && p < cut) {
              assert.ok(text.includes(f), `${variant} ${w.name} step ${step}: ${f} (planted at #${p}) lost\n${text}`);
              checks++;
            }
          }
          if (template === 'sim' || variant === 'qa46-ref') {
            rows.push({ window: w.name, variant: `${variant}/${template}`, step, cut, floor: r.floorTokens, summaryBudget, tokens: r.tokens, kept: r.kept, dropped: r.dropped });
          }
        }
      }
    }
    // (7 + 70 steps) x 3 windows x up to 6 facts, minus steps where a fact is not yet summarized
    assert.ok(checks > (template === 'sim' ? 1300 : 200), `only ${checks} fact checks`);
  });
}

/** O1-style overlay on a copy of the history (DESIGN A.5): superseded instruction, dropped todo, NOTE. */
const OVERLAY_USERS = new Map<number, string[]>([
  [4, ['USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).']],
  [12, ['Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).']],
]);
function overlay(msgs: ChatMessage[]): void {
  for (const m of msgs) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const c = m.tool_calls[0]!;
    if (c.id === 'call_0003_0') {
      const args = JSON.parse(c.function.arguments) as { todos: Array<{ content: string; status: string }> };
      args.todos.push({ content: 'TODO-DROP-Z1H5K: remove the legacy banner helper', status: 'pending' });
      c.function.arguments = JSON.stringify(args);
    }
    if (c.id === 'call_0016_0') m.content = 'NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)';
    if (c.id === 'call_0024_0') {
      c.function.name = 'todowrite';
      c.function.arguments = JSON.stringify({ todos: [
        { content: 'Migrate cart page objects', status: 'completed' },
        { content: 'TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', status: 'in_progress' },
        { content: 'TODO-NEW-B8M2N: migrate the payment page', status: 'pending' },
      ] });
    }
  }
  const i24 = msgs.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_0024_0');
  if (i24 >= 0) msgs[i24] = { role: 'tool', tool_call_id: 'call_0024_0', content: '[]' };
}

test('superseded facts never return: overlay on the reference history, every window, every step', { skip: exactCounter('sim') ? false : 'no dev tokenizer.json' }, () => {
  const S = createSummarizerExt(structuredClone(DEFAULT_CONFIG), exactCounter('sim')!);
  let absent = 0;
  let present = 0;
  for (const [variant, o, last] of [['qa46', BROWSER, 46], ['talk80', TALK, 80]] as const) {
    const which = Array.from({ length: last - 5 }, (_, i) => 5 + i);
    for (const { step, msgs, d } of steps(o, last, which, OVERLAY_USERS, overlay)) {
      const cut = lastAssistant(msgs);
      const at = (marker: string): number => plantedAt(msgs, marker);
      const corr = at('VP-NEW-R3T8W');
      const old = at('VP-OLD-K7Q2M');
      const drop = at('TODO-NEW-B8M2N');
      const note = at('NOTE-ANIM-C4D9P');
      const floorOnly = S.render({ messages: msgs, digests: d, hEnd: HEND, cut, compaction: 1 }, { budgetTokens: 0, allowFloorEviction: false, userShortenStep: 0 }).text!;
      const texts = [floorOnly, ...WINDOWS.map((w) => renderAtSummaryBudget(S, msgs, d, cut, w.budget).r.text!)];
      for (const t of texts) {
        if (corr >= 0) {
          assert.ok(!t.includes('VP-OLD-K7Q2M'), `${variant} step ${step}: superseded instruction revived`);
          absent++;
        } else if (old >= HEND && old < cut) {
          assert.ok(t.includes('VP-OLD-K7Q2M'), `${variant} step ${step}: live instruction lost`);
          present++;
        }
        if (corr >= HEND && corr < cut) assert.ok(t.includes(`#${corr}: Correction for USER-VIEW-R4`), `${variant} step ${step}: correction lost`);
        if (old >= HEND && old < cut && corr >= 0) assert.ok(t.includes(`#${old}: (superseded by #${corr})`));
        if (drop >= 0) {
          assert.ok(!t.includes('TODO-DROP-Z1H5K'), `${variant} step ${step}: dropped todo revived`);
          absent++;
          if (drop < cut) assert.ok(t.includes('TODO-NEW-B8M2N'));
        } else if (at('TODO-DROP-Z1H5K') < cut) assert.ok(t.includes('TODO-DROP-Z1H5K'));
        if (note >= HEND && note < cut) assert.ok(t.includes('NOTE-ANIM-C4D9P'));
      }
    }
  }
  assert.ok(absent > 400 && present > 20, `absent ${absent}, present ${present}`);
});

test('summary size report', () => {
  const path = process.env['KITZUR_SUMMARY_REPORT'];
  if (!path || rows.length === 0) return;
  const lines = ['| window | variant | step | cut | floor | summaryBudget | tokens | kept | dropped |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.window} | ${r.variant} | ${r.step} | ${r.cut} | ${r.floor} | ${r.summaryBudget} | ${r.tokens} | ${r.kept} | ${r.dropped} |`);
  writeFileSync(path, lines.join('\n') + '\n');
});
