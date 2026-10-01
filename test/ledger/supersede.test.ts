import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentWords, explicitIds, overlapCoefficient, supersede, supersedeRules, type UserText } from '../../src/engine/ledger/supersede.js';
import { splitSentences } from '../../src/engine/ledger/text.js';
import { cfg } from './fixtures.js';

const rules = supersedeRules(cfg().ledger);
const RULE =
  'Important, USER-RULE-Q7: do NOT modify anything under tests/legacy/ - the compatibility suite covers those files. Also keep using the staging-3 environment only.';

/** Superseded (message, sentence ordinal) pairs when `later` follows `earlier`. */
function run(earlier: string, later: string, head = ''): Array<[number, number]> {
  const msgs: UserText[] = [];
  if (head) msgs.push({ index: 1, text: head, head: true });
  msgs.push({ index: 5, text: earlier, head: false }, { index: 9, text: later, head: false });
  const headIds = new Set(explicitIds(head));
  const r = supersede(msgs, rules, headIds);
  const out: Array<[number, number]> = [];
  for (const [i, st] of r.sentences) st.forEach((s, k) => s.supersededBy !== null && out.push([i, k]));
  return out;
}

// The 11 probe cases of the review (tmp/review-consolidate/supersede2.py; DESIGN §6.1): [name, earlier, later, want, sentence]
const PROBES: Array<[string, string, string, boolean, number?]> = [
  ['TP firefox (terse)', 'Please also run every spec on the firefox project.', 'Actually, skip firefox - chromium only is enough.', true, 0],
  ['TP env switch', 'Run the payment specs against staging-3.', 'Change of plan: use staging-4 for payment, staging-3 is down.', true, 0],
  ['TP RULE partial (legacy)', RULE, 'Correction: the compatibility freeze for tests/legacy/ has ended, so you may now modify tests/legacy/ files.', true, 0],
  ['TP RULE env only', RULE, 'Actually use staging-4 instead, staging-3 was decommissioned.', true, 1],
  ['FP? follow-up w/ cue vs RULE', RULE, 'The payment spec still fails on staging-3; use a retry instead of a hard wait.', false],
  ['FP? additive "also"', 'Use getByTestId for the promo banner assertions.', 'Also add a data-testid to the cart badge rather than relying on its text.', false],
  ['FP? bench W2/H1 "too"', 'Run the checkout specs with --workers=2 so the staging server is not overloaded (USER-WORK-W2).', 'Actually, run the checkout specs in headed mode too, so I can watch them (USER-HEAD-H1).', false],
  ['FP? discourse "actually"', 'Run the checkout specs with --workers=2 so the staging server is not overloaded.', 'Actually, the checkout page has a new banner now.', false],
  ['TP shared ID', 'USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).', 'Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).', true, 0],
  ['TP hebrew', 'תריץ את הבדיקות על staging-3', 'בעצם תריץ על staging-4', true, 0],
  ['FP? E2E token', 'Run the E2E suite nightly.', 'Actually the E2E dashboard is broken, ignore its colours.', false],
];

test('the 11 review probes: at least 10/11 correct and 0 false supersessions; only the terse firefox case may miss', () => {
  let correct = 0;
  let falsePos = 0;
  const misses: string[] = [];
  for (const [name, a, b, want, sentence] of PROBES) {
    const got = run(a, b);
    assert.ok(got.every(([i]) => i === 5), `${name}: only the earlier message can be superseded`);
    if (want) {
      if (got.length === 1 && got[0]![1] === sentence) correct++;
      else {
        assert.equal(got.length, 0, `${name}: a wrong sentence was superseded: ${JSON.stringify(got)}`);
        misses.push(name);
      }
    } else if (got.length === 0) correct++;
    else falsePos++;
  }
  assert.equal(falsePos, 0);
  assert.ok(correct >= 10, `correct ${correct}/11`);
  assert.ok(misses.every((m) => m === 'TP firefox (terse)'), `unexpected misses: ${misses}`);
});

test('the terse firefox correction is the documented safe miss (overlap 0.25-0.34 < 0.34)', () => {
  const a = contentWords('Please also run every spec on the firefox project.', rules.ignore);
  const b = contentWords('Actually, skip firefox - chromium only is enough.', rules.ignore);
  const o = overlapCoefficient(a, b);
  assert.ok(o > 0 && o < 0.34, String(o));
});

test('bench corr60-style pairs (DESIGN A.5 F9)', () => {
  // (b) cue + overlap, no ID
  assert.deepEqual(run('Use the chromium project for all checkout runs.', 'Actually use the webkit project for all checkout runs instead.'), [[5, 0]]);
  // (e) "not X anymore"
  assert.deepEqual(run('Keep the workers at 2 for the checkout run.', 'The checkout run does not need 2 workers anymore; use 4 workers.'), [[5, 0]]);
  // (f) false-positive probe with ASCII markers: both survive
  assert.deepEqual(
    run('Run the checkout specs with --workers=2 so the staging server is not overloaded (WK-W2-P5Q)', 'Actually, run the checkout specs in headed mode too, so I can watch them (HD-H1-M3Z)'),
    [],
  );
  // (g) Hebrew false positive: במקום used as "in the place of", no overlap
  assert.deepEqual(run('תריץ את בדיקות העגלה עם שני עובדים', 'הבאנר מופיע במקום הלא נכון בדף התשלום'), []);
  // (c) Hebrew cue, O1 in Hebrew with ASCII markers
  assert.deepEqual(run('USER-VIEW-R4: תריץ כל בדיקת checkout ברזולוציה 1280x720 (VP-OLD-K7Q2M).', 'תיקון ל-USER-VIEW-R4: בעצם תשתמש ב-1920x1080 (VP-NEW-R3T8W).'), [[5, 0]]);
});

test('(d) chain A -> B -> C: A and B superseded, C survives', () => {
  const msgs: UserText[] = [
    { index: 3, text: 'USER-RETRY-R9: set retries=1 for the checkout specs (RT-A).', head: false },
    { index: 40, text: 'Actually, for USER-RETRY-R9 use retries=2 (RT-B).', head: false },
    { index: 90, text: 'Correction for USER-RETRY-R9: retries=0 (RT-C).', head: false },
  ];
  const r = supersede(msgs, rules, new Set());
  assert.equal(r.sentences.get(3)![0]!.supersededBy, 40);
  assert.equal(r.sentences.get(40)![0]!.supersededBy, 90);
  assert.equal(r.sentences.get(90)![0]!.supersededBy, null);
});

test('overlap chain without IDs: the correction targets the newest non-superseded match (ties to the newest)', () => {
  const msgs: UserText[] = [
    { index: 3, text: 'Run the payment specs against staging-3.', head: false },
    { index: 7, text: 'Run the payment specs against staging-3 again later.', head: false },
    { index: 11, text: 'Change of plan: use staging-4 for payment, staging-3 is down.', head: false },
  ];
  const r = supersede(msgs, rules, new Set());
  // both earlier sentences score 2/3; the tie goes to the newest
  assert.equal(r.sentences.get(3)![0]!.supersededBy, null);
  assert.equal(r.sentences.get(7)![0]!.supersededBy, 11);
});

test('explicit IDs: the pattern, and IDs that occur in the head are ignored', () => {
  assert.deepEqual(explicitIds('USER-RULE-Q7 VP-OLD-K7Q2M DECISION-D42 E2E S3 HTTP2 staging-3 USER-VIEW-R4:'), ['USER-RULE-Q7', 'VP-OLD-K7Q2M', 'DECISION-D42', 'USER-VIEW-R4']);
  // the shared ID lives in the head: no ID match; the cued sentence then falls back to overlap
  const head = 'Task GOAL-CHK-7F3A: migrate the checkout suite.';
  assert.deepEqual(run('Use GOAL-CHK-7F3A reports for the cart.', 'Correction for GOAL-CHK-7F3A: nothing else.', head), []);
});

test('a correction whose best match is the head goal amends the task and removes nothing', () => {
  const msgs: UserText[] = [
    { index: 1, text: 'Migrate the checkout E2E suite and make every checkout spec pass against the staging-3 environment.', head: true },
    { index: 9, text: 'Keep a log of every flaky spec.', head: false },
    { index: 20, text: 'Actually, target the staging-4 environment for the checkout specs.', head: false },
  ];
  const r = supersede(msgs, rules, new Set());
  assert.ok(r.amends.has(20));
  assert.equal(r.sentences.get(9)![0]!.supersededBy, null);
  assert.equal(r.sentences.has(1), false);
});

test('content words: Unicode letters (Hebrew included), stop and cue words removed', () => {
  assert.deepEqual([...contentWords('בעצם תריץ על staging-4', rules.ignore)].sort(), ['staging', 'תריץ']);
  assert.deepEqual([...contentWords('Actually use staging-4 instead, staging-3 was decommissioned.', rules.ignore)].sort(), ['decommissioned', 'staging']);
  const extra = cfg();
  extra.ledger.stopWords = ['Staging'];
  assert.deepEqual([...contentWords('use staging-4', supersedeRules(extra.ledger).ignore)], []);
});

test('sentence split: at (?<=[.!?;])\\s+ and at newlines, spans point into the text', () => {
  const t = 'First one. Second; third\nfourth!  fifth';
  const s = splitSentences(t);
  assert.deepEqual(s.map((x) => x.text), ['First one.', 'Second;', 'third', 'fourth!', 'fifth']);
  for (const x of s) assert.equal(t.slice(x.start, x.end), x.text);
});
