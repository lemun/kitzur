import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentText, PromptCounter } from '../../bench/lib/render.js';
import { pyDumps } from '../../bench/lib/pyjson.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';
import * as ref from '../../bench/scenarios/reference.js';
import { buildScenario, familyOf, SCENARIO_IDS } from '../../bench/scenarios/index.js';
import { dumpText, simulateSession, type ScenarioDef } from '../../bench/scenarios/common.js';
import { O1_MARKERS, O1_TEXT } from '../../bench/scenarios/overlay.js';
import { clientSummaryText, CS_MARKERS, markerPosition, openCodeCompact, OC_CONTINUE_SHORT, OC_MARKER_TEXT } from '../../bench/scenarios/client-compacts.js';
import { ERROR_STYLE_IDS, STYLE_MODE } from '../../bench/scenarios/errors.js';
import { bulkTools, IMP_SYS_CHARS, IMP_TOOL_COUNT, IMP_TOOL_DESC_CHARS, prose } from '../../bench/scenarios/impossible.js';
import { HEBREW_WORDS } from '../../bench/scenarios/hebrew.js';
import { PAR_BIG_CHARS, PAR_BIG_STEP, parallelCalls } from '../../bench/scenarios/parallel.js';

const FAMILIES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14'];

test('registry: every family of benchmark contract is present, ids are unique and build at every window', () => {
  assert.equal(new Set(SCENARIO_IDS).size, SCENARIO_IDS.length);
  const fams = new Set(SCENARIO_IDS.map(familyOf));
  for (const f of FAMILIES) assert.ok(fams.has(f as never), `family ${f}`);
  for (const id of [
    'qa46-ref', 'qa46', 'qa150', 'talk80-ref', 'talk80', 'talk200', 'code60', 'huge150k', 'huge180k', 'huge400k', 'huge400k-cap51200',
    'huge180k-test', 'huge180k-user', 'he46', 'rs46', 'par46', 'il3x46', 'il3x46-conc', 'corr60', 'cc60-oc', 'cc60-oc-overflow',
    'cc60-kilo', 'nu46', 'nu46-server', 'rs46-sigterm', 'rs46-sigkill', 'rs46-freshstate', 'imp-tools', 'imp-sys', 'imp-user',
  ]) assert.ok(SCENARIO_IDS.includes(id), id);
  for (const s of ERROR_STYLE_IDS) assert.ok(SCENARIO_IDS.includes(`err-${s}`), `err-${s}`);
  for (const id of SCENARIO_IDS) for (const w of ['32k', '100k'] as const) assert.equal(buildScenario(id, w).id, id);
});

test('the -ref variants plant nothing and point at the reference options', () => {
  const q = buildScenario('qa46-ref');
  assert.deepEqual(q.reference, { capBytes: 51_200 });
  assert.deepEqual(q.facts.map((f) => f.marker), ref.FACT_KEYS);
  const t = buildScenario('talk80-ref');
  assert.deepEqual(t.reference, { capBytes: 51_200, chatty: true });
  assert.equal(t.sessions[0]!.steps, 80);
});

test('O1 (benchmark contract ): exact texts at the specified steps, todo drop/add, NOTE at step 16', () => {
  const sc = buildScenario('qa46');
  const s = sc.sessions[0]!;
  assert.deepEqual(s.userAfter(4).map((m) => m.content), [O1_TEXT.en.instr]);
  assert.equal(O1_TEXT.en.instr, 'USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).');
  assert.deepEqual(s.userAfter(12).map((m) => m.content), ['Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).']);
  assert.deepEqual(s.userAfter(9).map((m) => m.content), [ref.USER_INJECT.get(9)]);
  assert.ok(contentText(s.assistantAt(16).content).startsWith('NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)'));
  const todo3 = JSON.parse(s.assistantAt(3).tool_calls![0]!.function.arguments) as { todos: Array<{ content: string; status: string }> };
  assert.ok(todo3.todos.some((t) => t.content.includes(O1_MARKERS.todoDrop)));
  const a24 = s.assistantAt(24);
  assert.equal(a24.tool_calls![0]!.function.name, 'todowrite');
  const todo24 = JSON.parse(a24.tool_calls![0]!.function.arguments) as { todos: Array<{ content: string; status: string }> };
  assert.ok(!todo24.todos.some((t) => t.content.includes(O1_MARKERS.todoDrop)), 'step 24 drops TODO-DROP');
  assert.ok(todo24.todos.some((t) => t.content.includes(O1_MARKERS.todoNew) && t.status === 'pending'));
  assert.ok(todo24.todos.some((t) => t.content.includes('TODO-P3-RETRY')), 'the reference todo stays');
  // tool results echo the todo lists
  assert.ok(s.toolResults(24, a24.tool_calls!)[0]!.content!.toString().includes(O1_MARKERS.todoNew));
  // everything else is the reference content except the latest-series codes on navigate URLs and tallies
  for (const k of [0, 1, 5, 6, 7, 8, 9, 12, 13, 14, 17, 18, 19, 22, 23, 26, 27, 28, 29]) {
    assert.equal(pyDumps(s.assistantAt(k)), pyDumps(ref.assistantMessage(k, { capBytes: 51_200 })), `step ${k}`);
  }
  // facts: the O1 set is gated, the reference facts are report-only here
  const byId = new Map(sc.facts.map((f) => [f.id, f]));
  assert.equal(byId.get('o1-vp-old')!.supersededBy, 'o1-vp-new');
  assert.equal(byId.get('o1-todo-drop')!.supersededBy, 'o1-todo-new');
  assert.ok(sc.facts.filter((f) => ref.FACT_KEYS.includes(f.marker)).every((f) => !f.gate));
  const latest = sc.facts.filter((f) => f.expect === 'latest');
  assert.equal(latest.filter((f) => f.gate).length, 2, 'the last URL and the last tally are gated');
  assert.equal(latest.find((f) => f.gate && f.channel === 'url')!.id, 'url-s41');
  assert.equal(latest.find((f) => f.gate && f.channel === 'tally')!.id, 'tally-s40');
});

test('qa150 / talk200: the retry chain A → B (step 60) → C (step 110)', () => {
  for (const id of ['qa150', 'talk200']) {
    const s = buildScenario(id).sessions[0]!;
    assert.match(String(s.userAfter(30).at(-1)!.content), /USER-RETRY-R9.*retries=1.*RT-A/);
    assert.match(String(s.userAfter(60).at(-1)!.content), /^Actually.*USER-RETRY-R9.*retries=2.*RT-B/);
    assert.match(String(s.userAfter(110).at(-1)!.content), /^Correction.*USER-RETRY-R9.*retries=0.*RT-C/);
  }
});

test('Hebrew UI: snapshots use the content.py HEBREW vocabulary and a Hebrew title; O1 uses the cue בעצם', () => {
  const s = buildScenario('he46').sessions[0]!;
  const snap = s.toolResults(4, s.assistantAt(4).tool_calls!)[0]!.content as string;
  assert.ok(snap.includes('- Page Title: קופה - חנות'));
  const names = [...snap.matchAll(/- \w+ "([^"$]+)" \[ref=/g)].map((m) => m[1]!.split(' ')[0]!);
  assert.ok(names.length > 50 && names.every((n) => HEBREW_WORDS.includes(n)), 'accessible names are Hebrew words');
  assert.match(String(s.userAfter(12)[0]!.content), /^בעצם, .*USER-VIEW-R4.*VP-NEW-R3T8W/);
});

test('huge: markers at the head, middle and tail of the step-20 output; the cap keeps only the head', () => {
  const sc = buildScenario('huge180k');
  const s = sc.sessions[0]!;
  const out = s.toolResults(20, s.assistantAt(20).tool_calls!)[0]!.content as string;
  const m = new Map(sc.facts.map((f) => [f.id, f.marker]));
  assert.ok(out.length > 180_000 && out.length < 181_000, String(out.length));
  assert.ok(out.indexOf(m.get('huge-head')!) < 200);
  assert.ok(out.length - out.indexOf(m.get('huge-tail')!) <= 200);
  const mid = out.indexOf(m.get('huge-mid')!);
  assert.ok(mid > 80_000 && mid < 100_000, String(mid));
  const capped = buildScenario('huge400k-cap51200');
  const cs = capped.sessions[0]!;
  const cout = cs.toolResults(20, cs.assistantAt(20).tool_calls!)[0]!.content as string;
  assert.ok(Buffer.byteLength(cout) < 52_000);
  assert.deepEqual(capped.facts.filter((f) => f.id.startsWith('huge-')).map((f) => f.id), ['huge-head']);
  const user = buildScenario('huge180k-user').sessions[0]!;
  assert.equal(user.userAfter(20).length, 1, 'a user message right after the huge result');
  const t = buildScenario('huge180k-test').sessions[0]!;
  const tout = t.toolResults(20, t.assistantAt(20).tool_calls!)[0]!.content as string;
  assert.ok(tout.startsWith('Running 14 tests using 4 workers [shard HUGE-HEAD-') && !tout.includes('[ref=e'), 'a test log, not a snapshot');
});

test('parallel: 2–4 calls on navigate/snapshot steps, answered positionally; the 60k third result', () => {
  const sc = buildScenario('par46');
  const s = sc.sessions[0]!;
  let multi = 0;
  for (let k = 0; k < 46; k++) {
    const a = s.assistantAt(k);
    const n = a.tool_calls!.length;
    assert.equal(n, parallelCalls(k));
    assert.ok(n >= 1 && n <= 4);
    if (n > 1) multi++;
    const r = s.toolResults(k, a.tool_calls!);
    assert.deepEqual(r.map((x) => x.tool_call_id), a.tool_calls!.map((c) => c.id));
  }
  assert.ok(multi >= 10, String(multi));
  const a = s.assistantAt(PAR_BIG_STEP);
  assert.equal((s.toolResults(PAR_BIG_STEP, a.tool_calls!)[2]!.content as string).length, PAR_BIG_CHARS);
  assert.equal(sc.capBytes, null);
});

test('interleave: three sessions with distinct seeds, goals and facts; solo controls', () => {
  const sc = buildScenario('il3x46');
  assert.equal(sc.interleave, 'round-robin');
  assert.deepEqual(sc.sessions.map((s) => s.id), ['s1', 's2', 's3']);
  const goals = sc.sessions.map((s) => String(s.goal().content));
  assert.equal(new Set(goals).size, 3);
  const outs = sc.sessions.map((s) => s.toolResults(4, s.assistantAt(4).tool_calls!)[0]!.content);
  assert.equal(new Set(outs).size, 3, 'seeded content differs');
  assert.deepEqual(buildScenario('il3x46-conc').interleave, { seed: 83, concurrent: 3 });
  const solo = buildScenario('il3x46-solo-s2');
  assert.equal(pyDumps(simulateSession(solo.sessions[0]!, 10).map((m) => m.message)), pyDumps(simulateSession(sc.sessions[1]!, 10).map((m) => m.message)));
});

test('corrections: a probe every 4 steps, qwen3 render, confusion-matrix intent', () => {
  const sc = buildScenario('corr60');
  assert.equal(sc.mock.render, 'qwen3');
  const s = sc.sessions[0]!;
  const probes = [];
  for (let k = 0; k < 60; k++) if (s.userAfter(k).length && k !== 9) probes.push(k);
  assert.deepEqual(probes, [3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51, 55]);
  assert.equal(s.userAfter(35)[0]!.content, 'Run the checkout specs with --workers=2 so the staging server is not overloaded (WK-W2-P5Q)');
  assert.equal(s.userAfter(47)[0]!.content, 'Actually, run the checkout specs in headed mode too, so I can watch them (HD-H1-M3Z)');
  assert.ok(String(s.userAfter(31)[0]!.content).startsWith('בעצם'));
  assert.ok(String(s.userAfter(51)[0]!.content).includes('במקום'));
  assert.equal(sc.supersession!.length, 8);
  // misses are reported, not gated; false supersessions are gated
  for (const f of sc.facts.filter((x) => x.id.startsWith('corr-'))) assert.equal(f.gate, f.expect === 'survive', f.id);
});

test('client compactions: OpenCode shapes, the template-shaped summary with CS-ONLY markers at 40% and 90%', () => {
  const sc = buildScenario('cc60-oc');
  assert.equal(sc.client, 'opencode');
  assert.deepEqual(sc.events, [{ atStep: 25, kind: 'client-compact' }]);
  const text = sc.clientCompact!.summaryText;
  for (const h of ['## Objective', '## Important Details', '## Work State', '### Completed', '### Active', '### Blocked', '## Next Move', '## Relevant Files']) assert.ok(text.includes(h), h);
  const p40 = markerPosition(text, CS_MARKERS.p40);
  const p90 = markerPosition(text, CS_MARKERS.p90);
  assert.ok(p40 > 0.35 && p40 < 0.45, String(p40));
  assert.ok(p90 > 0.85 && p90 < 0.95, String(p90));
  assert.equal(buildScenario('cc60-oc-overflow').clientCompact!.trigger, 'overflow');
  assert.equal(buildScenario('cc60-kilo').client, 'kilo');
  // the history rebuild (reference implementation)
  const h = simulateSession(sc.sessions[0]!, 25).map((m) => m.message);
  const c = openCodeCompact(h, text, OC_CONTINUE_SHORT, 15_000);
  assert.equal(c[0], h[0]);
  assert.deepEqual(c[1], { role: 'user', content: OC_MARKER_TEXT });
  assert.deepEqual(c[2], { role: 'assistant', content: text });
  assert.deepEqual(c.at(-1), { role: 'user', content: OC_CONTINUE_SHORT });
  const tail = c.slice(3, -1);
  assert.ok(tail.length >= 1 && tail[0]!.role !== 'tool', 'the tail starts at a unit boundary');
  assert.deepEqual(tail, h.slice(h.length - tail.length), 'the tail is verbatim');
  // a second compaction drops the previous marker/summary pair
  const c2 = openCodeCompact([...c, ...h.slice(-2)], 'second', OC_CONTINUE_SHORT, 15_000);
  assert.equal(c2.filter((m) => m.content === OC_MARKER_TEXT).length, 1);
});

test('errors: one scenario per style with the §7.1 skew per window, -hidden variants, http413', () => {
  for (const style of ERROR_STYLE_IDS) {
    for (const w of ['100k', '64k', '32k'] as const) {
      const sc = buildScenario(`err-${style}`, w);
      assert.equal(sc.mock.errorStyle, style);
      assert.equal(sc.mock.limitMode, STYLE_MODE[style]);
      assert.ok((sc.mock.limitSkewTokens ?? 0) > 0);
    }
    if (style !== 'unknown400') assert.equal(buildScenario(`err-${style}-hidden`).mock.hiddenOverheadTokens, '3%');
  }
  assert.equal(buildScenario('err-vllm-018', '100k').mock.limitSkewTokens, 11_000);
  assert.equal(buildScenario('err-llamacpp', '100k').mock.limitSkewTokens, 43_000);
  assert.equal(buildScenario('err-vllm-018', '32k').mock.limitSkewTokens, 5_280);
  assert.equal(buildScenario('err-late400').mock.headerDelayMs, 20_000);
  assert.equal(buildScenario('err-sse-inline').mock.inStreamErrors, true);
  assert.deepEqual(buildScenario('err-http413').maxBodyBytesFrom, { scenario: 'qa46', factor: 0.9 });
  const img = buildScenario('err-http413-image');
  assert.equal(img.mock.maxBodyBytes, 768 * 1024);
  const s = img.sessions[0]!;
  const u8 = s.userAfter(8).at(-1)!;
  assert.ok(Buffer.byteLength(dumpText(u8)) > 600 * 1024 && Buffer.byteLength(dumpText(u8)) < 610 * 1024);
  assert.equal(buildScenario('err-unknown400').expect, 'error-unchanged');
});

test('no-usage, restart, impossible', () => {
  assert.deepEqual(buildScenario('nu46').clientOptions, { includeUsage: false });
  assert.equal(buildScenario('nu46-server').mock.usage, 'never');
  const r = buildScenario('rs46-sigkill');
  assert.deepEqual(r.events, [{ atStep: 10, kind: 'sigkill' }, { atStep: 23, kind: 'sigkill' }]);
  assert.equal(r.controlOf, 'qa46');
  assert.deepEqual(buildScenario('rs46-freshstate').gates, []);
  assert.equal(buildScenario('imp-tools').expect, 'impossible-documented');
  assert.deepEqual(buildScenario('imp-tools').windows, ['32k']);
  assert.equal(buildScenario('imp-user').expect, 'complete');
  const g = String(buildScenario('imp-user').sessions[0]!.goal().content);
  assert.ok(g.length >= 199_000 && g.length <= 201_000, String(g.length));
});

test('scenario content is deterministic (same bytes on every build)', () => {
  for (const id of ['qa46', 'code60', 'corr60', 'il3x46', 'par46', 'rs46']) {
    const a = simulateSession(buildScenario(id).sessions[0]!, 30);
    const b = simulateSession(buildScenario(id).sessions[0]!, 30);
    assert.equal(pyDumps(a.map((m) => m.message)), pyDumps(b.map((m) => m.message)), id);
  }
});

const tokPath = testTokenizerPath();
test('calibrated sizes on the Qwen3.6 tokenizer (sim render): 30k tools / system, 1,500-token client summary', { skip: tokPath ? false : 'no dev tokenizer' }, () => {
  const c = new PromptCounter(loadTokenizer(tokPath!));
  const tools = c.countBody({ messages: [{ role: 'system', content: '' }], tools: [...ref.tools(), ...bulkTools(IMP_TOOL_COUNT, IMP_TOOL_DESC_CHARS)] });
  assert.ok(tools > 29_000 && tools < 31_500, `tools block ${tools}`);
  const sys = c.countBody({ messages: [{ role: 'system', content: ref.systemPrompt() + '\n\n## Project handbook\n' + prose(15_000, IMP_SYS_CHARS) }] });
  assert.ok(sys > 29_000 && sys < 31_500, `system ${sys}`);
  const sum = c.countText(clientSummaryText());
  assert.ok(Math.abs(sum - 1500) <= 45, `summary ${sum}`);
  // imp-tools / imp-sys cannot fit a 32k/8k budget; imp-user's head needs truncation at 32k only
  const b32 = 23_488;
  const impUser = buildScenario('imp-user');
  const u = c.countBody({ messages: [{ role: 'system', content: ref.systemPrompt() }, impUser.sessions[0]!.goal()], tools: ref.tools() });
  assert.ok(tools > b32 && sys > b32 && u > b32 && u < 61_000, `imp-user head ${u}`);
});
