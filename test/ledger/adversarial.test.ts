// Adversarial checks of the facts ledger extraction and supersession (regressions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractor } from '../../src/engine/ledger/extract.js';
import { createToolRulesExt } from '../../src/engine/rules/index.js';
import { EXPLICIT_ID_SOURCE, explicitIds, supersede, supersedeRules, type UserText } from '../../src/engine/ledger/supersede.js';
import { contentText } from '../../src/engine/ledger/text.js';
import { startsWithPath } from '../../src/engine/ledger/paths.js';
import { corr60 } from '../../bench/scenarios/corrections.js';
import { simulateSession, type ScenarioContext } from '../../bench/scenarios/common.js';
import { call, cfg } from './fixtures.js';

const C = cfg();
const ex = createExtractor(C, createToolRulesExt(C));

test('tier 1: a label deep inside a long one-line paragraph is kept in its item (regression)', () => {
  const para = 'I went through the checkout flow in detail. '.repeat(9) + 'UNFINISHED-9K: checkout_promo.spec.ts is still flaky and needs a retry. ' + 'More narrative follows here. '.repeat(10);
  assert.ok(para.indexOf('UNFINISHED-9K') > 300);
  const f = ex.assistant({ role: 'assistant', content: para });
  assert.equal(f.labels.length, 1);
  const item = f.labels[0]!;
  assert.equal(item.priority, true);
  assert.ok(item.text.startsWith('… UNFINISHED-9K: checkout_promo.spec.ts is still flaky and needs a retry.'), item.text);
  assert.ok(item.text.length <= 301, String(item.text.length));
  // the line left tier 2: the label must not be lost with it
  assert.ok(!f.narrative.includes('UNFINISHED-9K'));
  // a label inside the head-first window keeps the whole-line form ()
  const early = 'Cart page objects are migrated. UNFINISHED-9K: still flaky. ' + 'x '.repeat(300);
  assert.ok(ex.assistant({ role: 'assistant', content: early }).labels[0]!.text.startsWith('Cart page objects are migrated. UNFINISHED-9K:'));
  // a very long sentence before a late label: the item starts at the label
  const run = 'word '.repeat(120) + 'RISK-R2: the iframe may need a frame locator.';
  assert.ok(ex.assistant({ role: 'assistant', content: run }).labels[0]!.text.startsWith('… RISK-R2: the iframe'));
  // with several labels the one that ranks the item (tag / explicit ID) is the one kept visible
  const two = 'URL: https://shop/checkout ' + 'filler '.repeat(60) + 'then BLOCKER-B7X: payments sandbox is down.';
  const t = ex.assistant({ role: 'assistant', content: two }).labels[0]!;
  assert.equal(t.priority, true);
  assert.ok(t.text.includes('BLOCKER-B7X: payments sandbox is down.'), t.text);
});

test('tags: a sentence after ";" starts a sentence (DESIGN §6.1 split), code-free labels unaffected (regression)', () => {
  const f = ex.assistant({ role: 'assistant', content: 'We compared both options; DECISION-D42: use data-testid selectors only.\nPlan (TODO: not a sentence start).' });
  assert.deepEqual(f.tagged, [{ tag: 'decision', text: 'DECISION-D42: use data-testid selectors only.' }]);
  assert.deepEqual(f.labels, [{ text: 'Plan (TODO: not a sentence start).', priority: true }]);
});

test('ledger.labelPattern that can match the empty string does not turn every line into tier 1 (regression)', () => {
  const c = cfg();
  c.ledger.labelPattern = '(?:[A-Z]{3,}:)?';
  const e = createExtractor(c, createToolRulesExt(c));
  const f = e.assistant({ role: 'assistant', content: 'plain line one\nRISK: real label\nplain line two' });
  assert.deepEqual(f.labels, [{ text: 'RISK: real label', priority: false }]);
  assert.equal(f.narrative, 'plain line one plain line two');
});

test('supersession on the bench corr60 scenario (F9): exactly the intended pairs, no false supersession', () => {
  const def = corr60({} as ScenarioContext);
  const hist = simulateSession(def.sessions[0]!);
  const rules = supersedeRules(C.ledger);
  const head = hist.filter((m) => m.index < 2 && m.message.role === 'user').map((m) => ({ index: m.index, text: contentText(m.message.content), head: true }) as UserText);
  const users = hist.filter((m) => m.index >= 2 && m.message.role === 'user').map((m) => ({ index: m.index, text: ex.user(m.message).text, head: false }) as UserText);
  const headIds = new Set(hist.filter((m) => m.index < 2).flatMap((m) => explicitIds(contentText(m.message.content))));
  const r = supersede([...head, ...users], rules, headIds);
  const markerAt = (marker: string): number => users.find((u) => u.text.includes(marker))?.index ?? -1;
  const factById = new Map(def.facts.map((f) => [f.id, f]));
  const expected = new Set(
    def.facts.filter((f) => f.expect === 'absent-after-supersede').map((f) => `${markerAt(f.marker)}<-${markerAt(factById.get(f.supersededBy!)!.marker)}`),
  );
  assert.ok(expected.size >= 6, [...expected].join(' '));
  const got = new Set(r.events.filter((e) => e.rule !== 'amends').map((e) => `${e.target}<-${e.by}`));
  assert.deepEqual([...got].sort(), [...expected].sort());
  // every probe sentence not meant to be superseded stays whole
  for (const u of users) {
    const st = r.sentences.get(u.index)!;
    const planted = def.facts.find((f) => u.text.includes(f.marker));
    if (!planted || planted.expect === 'absent-after-supersede') continue;
    assert.ok(st.every((s) => s.supersededBy === null), `${planted.id} falsely superseded`);
  }
});

test('supersession: status reports that open with a discourse cue never delete a user rule (regression)', () => {
  const rules = supersedeRules(C.ledger);
  const superseded = (earlier: string, later: string): string[] => {
    const r = supersede([{ index: 5, text: earlier, head: false }, { index: 9, text: later, head: false }], rules, new Set());
    return r.sentences.get(5)!.filter((s) => s.supersededBy !== null).map((s) => s.sentence.text);
  };
  // each used to supersede the earlier rule on one or two shared content words
  const reports: Array<[string, string]> = [
    ['Run the tests after each change.', 'Actually, the tests passed now.'],
    ['Make sure the login flow worked before you push.', 'Actually that worked!'],
    ['Use staging-3 for all runs.', 'Actually staging-3 is fast today, nice.'],
    ['Do not touch tests/legacy/.', 'I no longer see the error in tests/legacy/ output.'],
    ['Keep the timeout at 30s for checkout specs.', 'The checkout specs no longer time out, great.'],
    ['Retry the flaky cart test three times.', 'The flaky cart test does not fail anymore.'],
    ['Actually, USER-RULE-Q7: never edit tests/legacy/.', 'Actually USER-RULE-Q7 worked out fine.'],
  ];
  for (const [a, b] of reports) assert.deepEqual(superseded(a, b), [], `${b} must not supersede ${a}`);
  // the same discourse cues in an instruction still correct (DESIGN §6.1 probes, corr60)
  const corrections: Array<[string, string, string]> = [
    ['Use the chromium project for all checkout runs.', 'Actually use the webkit project for all checkout runs.', 'Use the chromium project for all checkout runs.'],
    ['Run the payment specs in the firefox project only.', 'Actually, run the payment specs in the webkit project only.', 'Run the payment specs in the firefox project only.'],
    ['Keep the network mock enabled for the payment specs.', 'The network mock is not needed anymore for the payment specs.', 'Keep the network mock enabled for the payment specs.'],
    ['Keep 2 workers for the checkout run.', 'We no longer need 2 workers for the checkout run.', 'Keep 2 workers for the checkout run.'],
    ['Run on staging-3. Use 4 workers.', 'Actually use 2 workers.', 'Use 4 workers.'],
    ['USER-RULE-Q7: never edit tests/legacy/.', 'Correction: USER-RULE-Q7 is lifted, tests/legacy/ worked out fine.', 'USER-RULE-Q7: never edit tests/legacy/.'],
  ];
  for (const [a, b, gone] of corrections) assert.deepEqual(superseded(a, b), [gone], `${b} must supersede ${gone}`);
});

test('supersession: a rule pasted twice and then corrected leaves no stale copy; distinct earlier rules stay (regression)', () => {
  const rules = supersedeRules(C.ledger);
  const status = (texts: string[]): string[] => {
    const r = supersede(texts.map((text, i) => ({ index: 3 + 2 * i, text, head: false })), rules, new Set());
    return [...r.sentences.values()].flatMap((st) => st.map((s) => (s.supersededBy === null ? s.sentence.text : `(${s.sentence.text} -> #${s.supersededBy})`)));
  };
  assert.deepEqual(status(['Use staging-3 for the checkout runs.', 'use  staging-3 for the checkout runs', 'Actually use staging-4 for the checkout runs instead.']), [
    '(Use staging-3 for the checkout runs. -> #7)',
    '(use  staging-3 for the checkout runs -> #7)',
    'Actually use staging-4 for the checkout runs instead.',
  ]);
  // DESIGN §6.1 ties go to the newest: a different (non-verbatim) earlier instruction is not touched
  assert.deepEqual(status(['Run the payment specs against staging-3.', 'Run the payment specs against staging-3 again later.', 'Change of plan: use staging-4 for payment, staging-3 is down.']), [
    'Run the payment specs against staging-3.',
    '(Run the payment specs against staging-3 again later. -> #7)',
    'Change of plan: use staging-4 for payment, staging-3 is down.',
  ]);
});

test('hostile shapes stay linear: dash runs in tool output, punctuation runs in user text, padded patch headers (regression)', () => {
  const timed = (f: () => void): number => {
    const t0 = process.hrtime.bigint();
    f();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  // the old PATH_LINE regex took ~5 s on 40,000 dashes (quadratic); 400,000 must be instant
  const dashes = '-'.repeat(400_000) + '\nsee src/app/main.ts\n';
  assert.ok(timed(() => ex.result({ role: 'tool', tool_call_id: 'x', content: dashes }, null)) < 1500);
  assert.deepEqual(ex.result({ role: 'tool', tool_call_id: 'x', content: dashes }, null).paths, ['src/app/main.ts']);
  // startsWithPath keeps the regex's lines: list/tree glyphs, a dash that starts the first segment
  for (const [l, want] of [['├── src/a.ts', true], ['|-- lib/x.js', true], ['- ./b/c.ts', true], ['-x/y.ts', true], ['--/z', true], ['   ~/q/r', true], ['--- a', false], ['note: a/b.ts', false]] as const) {
    assert.equal(startsWithPath(l), want, l);
  }
  // verbatim-repeat normalisation of a sentence with a long punctuation run (a /[…]+$/ regex was quadratic)
  const rules = supersedeRules(C.ledger);
  const msgs: UserText[] = [
    { index: 3, text: 'Use staging-3 now.', head: false },
    { index: 5, text: 'Keep it' + '.,'.repeat(100_000) + 'x', head: false },
    { index: 7, text: 'Actually use staging-4 instead.', head: false },
  ];
  assert.ok(timed(() => supersede(msgs, rules, new Set())) < 1500);
  // an apply_patch header padded with 100k blanks
  const patch = '*** Begin Patch\n*** Add File: a.ts' + ' '.repeat(100_000) + '\n*** Update File: src/x.ts   \n*** End Patch';
  let files: Array<{ path: string; action: string }> = [];
  const ms = timed(() => {
    files = ex.assistant({ role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patchText: patch }) } }] }).calls[0]!.files;
  });
  assert.ok(ms < 1500, String(ms));
  assert.deepEqual(files, [{ path: 'a.ts', action: 'write' }, { path: 'src/x.ts', action: 'edit' }]);
});

test('a tool output of 200,000 blank lines and a todo checklist of blank lines are extracted in linear time (regression)', () => {
  const timed = (f: () => void): number => {
    const t0 = process.hrtime.bigint();
    f();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  // `^\s*` with /m (page URL/title, the jest `Tests:` tally) rescanned every run of blank lines: 15-37 s at 80,000
  const blank = 'start\n' + ' \n'.repeat(200_000) + 'end';
  const bash = call('bash', { command: 'printf' });
  assert.ok(timed(() => ex.result({ role: 'tool', tool_call_id: bash.id, content: blank }, bash)) < 1500);
  assert.ok(timed(() => ex.result({ role: 'tool', tool_call_id: 'x', content: '\n'.repeat(200_000) + '- Page URL: https://shop/\n' }, null)) < 1500);
  assert.equal(ex.result({ role: 'tool', tool_call_id: 'x', content: '\n'.repeat(1000) + '  - Page URL: https://shop/\n- Page Title: Shop' }, null).pageUrl, 'https://shop/');
  const list = '\n'.repeat(200_000) + '- [x] done item\n- [ ]   open item   \n* [~] working';
  const todo = call('update_todo_list', { todos: list });
  let todos: Array<{ content: string; status: string }> | null = null;
  assert.ok(timed(() => (todos = ex.assistant({ role: 'assistant', content: '', tool_calls: [todo] }).calls[0]!.todos)) < 1500);
  assert.deepEqual(todos, [
    { content: 'done item', status: 'completed' },
    { content: 'open item', status: 'pending' },
    { content: 'working', status: 'in_progress' },
  ]);
  // a tagged line ending in a long emphasis run
  const f = ex.assistant({ role: 'assistant', content: '**DECISION:** use data-testid' + '**'.repeat(50_000) });
  assert.deepEqual(f.tagged, [{ tag: 'decision', text: 'DECISION: use data-testid' }]);
});

test('explicit IDs and tier-1 labels: linear on long dashed upper-case runs, the same matches as the §6.1/ regexes (regression)', () => {
  const timed = (f: () => void): number => {
    const t0 = process.hrtime.bigint();
    f();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  // both regexes restart at every segment of `ABC-ABC-…` (11 s / 42 s at 80 KB / 200 KB)
  const run = 'ABC-'.repeat(50_000);
  assert.ok(timed(() => explicitIds(run + ' USER-RULE-Q7')) < 1500);
  assert.deepEqual(explicitIds(run + ' USER-RULE-Q7'), ['USER-RULE-Q7']);
  assert.ok(timed(() => ex.assistant({ role: 'assistant', content: run + ' :\nRISK-R2: the iframe' })) < 1500);
  assert.deepEqual(ex.assistant({ role: 'assistant', content: run + ' :\nRISK-R2: the iframe' }).labels, [{ text: 'RISK-R2: the iframe', priority: true }]);
  // differential: the scanner and the windowed label search agree with the plain regexes on random short texts
  const RE = new RegExp(EXPLICIT_ID_SOURCE, 'gu');
  const alt = cfg();
  alt.ledger.labelPattern = `(?:${alt.ledger.labelPattern})`; // the same pattern, not the default string: unwindowed
  const plain = createExtractor(alt, createToolRulesExt(alt));
  const al = ['A', 'B', 'Z', '1', '7', '-', '-', '_', ':', ' ', 'a', '.', 'ש', '\u{1D400}', 'DECISION', 'NOTE', 'USER-RULE-Q7', '\n'];
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 20_000; i++) {
    let t = '';
    for (let k = rnd(16); k > 0; k--) t += al[rnd(al.length)];
    assert.deepEqual(explicitIds(t), [...t.matchAll(RE)].map((m) => m[0]), JSON.stringify(t));
    assert.deepEqual(ex.assistant({ role: 'assistant', content: t }), plain.assistant({ role: 'assistant', content: t }), JSON.stringify(t));
  }
});
