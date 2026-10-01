import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, familyOf, SCENARIO_IDS } from '../../bench/scenarios/index.js';
import { fact, makeSession, userMsg, type ScenarioDef, type SessionScript } from '../../bench/scenarios/common.js';
import {
  contentWords, explicitIds, isAdditive, isCued, lintScenario, overlap, splitSentences, supersede, type UserSentence,
} from '../../bench/scenarios/lint.js';
import { qaWithO1, refFacts, referenceScript } from '../../bench/scenarios/browser.js';
import { BrowserGen } from '../../bench/scenarios/browser-gen.js';

test('every scenario of every family lints clean (benchmark contract )', () => {
  const seen = new Set<string>();
  for (const id of SCENARIO_IDS) {
    const sc = buildScenario(id, '100k');
    const r = lintScenario(sc);
    assert.deepEqual(r.issues, [], `${id}: ${r.issues.map((i) => `${i.rule}: ${i.message}`).join('\n')}`);
    seen.add(familyOf(id));
    // every declared fact is planted in a client request
    for (const f of sc.facts.filter((x) => x.channel !== 'client-summary')) assert.ok(r.planted.has(f.id), `${id}: ${f.id} planted`);
  }
  assert.equal(seen.size, 14);
});

test('the rule agrees with the intent on every supersession of O1, the chain, code60 and corr60', () => {
  const rule = (id: string): string[] => lintScenario(buildScenario(id)).rule.map((x) => `${x.target}<-${x.by}:${x.rule}`).sort();
  assert.deepEqual(rule('qa46'), ['o1-vp-old<-o1-vp-new:id']);
  assert.deepEqual(rule('he46'), ['o1-vp-old<-o1-vp-new:id']);
  assert.deepEqual(rule('qa150'), ['chain-a<-chain-b:id', 'chain-b<-chain-c:id', 'o1-vp-old<-o1-vp-new:id']);
  assert.deepEqual(rule('code60'), ['ce-ff-old<-ce-wk-new:overlap']);
  assert.deepEqual(rule('corr60'), [
    'corr-a1<-corr-a2:id', 'corr-b1<-corr-b2:overlap', 'corr-c1<-corr-c2:overlap', 'corr-d1<-corr-d2:id', 'corr-d2<-corr-d3:id', 'corr-e1<-corr-e2:overlap',
  ]);
});

// ---------------------------------------------------------------- the supersession rule, independently

test('rule parts: sentences, cues, explicit IDs, content words, overlap', () => {
  assert.deepEqual(splitSentences('Use firefox. Actually, use webkit instead!\nThanks; bye'), ['Use firefox.', 'Actually, use webkit instead!', 'Thanks;', 'bye']);
  assert.ok(isCued('Actually, run it'));
  assert.ok(isCued('The mock is not needed anymore for payments'));
  assert.ok(!isCued('the staging server is not overloaded'));
  assert.ok(isCued('בעצם, הרץ'));
  assert.ok(isCued('שמור במקום אחר'));
  assert.ok(isAdditive('run them in headed mode too'));
  assert.ok(!isAdditive('run them in toolbox mode'));
  assert.deepEqual(explicitIds('Correction for USER-VIEW-R4: use 1920x1080 (VP-NEW-R3T8W).', ''), ['USER-VIEW-R4', 'VP-NEW-R3T8W']);
  assert.deepEqual(explicitIds('GOAL-CHK-7F3A and USER-RULE-Q7', 'Task GOAL-CHK-7F3A: ...'), ['USER-RULE-Q7'], 'IDs in the head are not explicit IDs');
  const w = contentWords('Actually, run the payment specs in the webkit project only (PB-WK-R7T3N).', '');
  assert.deepEqual([...w].sort(), ['payment', 'project', 'run', 'specs', 'webkit'], 'cue words, stop words and ID tokens removed');
  assert.deepEqual([...contentWords('הרץ את בדיקות העגלה', '')].sort(), ['בדיקות', 'העגלה', 'הרץ'], 'Unicode letters (not JS \\w)');
  assert.equal(overlap(new Set(['a', 'b', 'c']), new Set(['a', 'b'])), 1);
  assert.equal(overlap(new Set(['a', 'b', 'c']), new Set()), 0);
});

const S = (msg: number, text: string): UserSentence => ({ msg, n: 0, text });

test('rule: shared ID wins; additive cue blocks; overlap threshold 0.34; ties go to the newest', () => {
  // shared explicit ID
  let r = supersede([S(1, 'USER-X-A1: use port 80.'), S(2, 'Correction for USER-X-A1: use port 81.')], '');
  assert.deepEqual(r.map((x) => [x.target.msg, x.by.msg, x.rule]), [[1, 2, 'id']]);
  // additive
  r = supersede([S(1, 'Run the checkout specs with two workers.'), S(2, 'Actually, run the checkout specs headed too.')], '');
  assert.deepEqual(r, []);
  // overlap below the threshold: nothing
  r = supersede([S(1, 'Keep the network mock enabled for payment specs.'), S(2, 'Actually, run the cart suite in webkit.')], '');
  assert.deepEqual(r, []);
  // highest overlap wins, ties to the newest
  r = supersede([S(1, 'Use firefox for cart specs.'), S(2, 'Use firefox for cart specs.'), S(3, 'Actually, use webkit for cart specs.')], '');
  assert.deepEqual(r.map((x) => x.target.msg), [2]);
  // an already superseded sentence is not a candidate again
  r = supersede([S(1, 'Use firefox for cart specs.'), S(2, 'Actually, use webkit for cart specs.'), S(3, 'Actually, use chromium for cart specs.')], '');
  assert.deepEqual(r.map((x) => [x.target.msg, x.by.msg]), [[1, 2], [2, 3]]);
});

// ---------------------------------------------------------------- negative cases: each rule fires

function scenarioWith(over: Partial<ScenarioDef>, script?: (s: SessionScript) => SessionScript): ScenarioDef {
  const gen = new BrowserGen({ id: 'default', steps: 20, capBytes: 51_200 });
  const base = gen.script();
  return {
    id: 'lint-probe', family: 'F1', sessions: [makeSession(script ? script(base) : base)], facts: refFacts(false), client: 'sim', capBytes: 51_200,
    mock: { render: 'sim' }, gates: [], expect: 'complete', windows: ['100k'], description: 'probe', ...over,
  };
}
const withUsers = (at: Record<number, string>) => (s: SessionScript): SessionScript => ({
  ...s, users: (k) => (at[k] !== undefined ? [...s.users(k), userMsg(at[k]!)] : s.users(k)),
});
const rules = (def: ScenarioDef): string[] => lintScenario(def).issues.map((i) => i.rule);

test('lint: duplicate markers / ids, plain-word markers, dangling supersededBy', () => {
  assert.ok(rules(scenarioWith({ facts: [...refFacts(false), fact('x', 'GOAL-CHK-7F3A', 'head', 'survive', true)] })).includes('facts'));
  assert.ok(rules(scenarioWith({ facts: [fact('a', 'banana', 'head', 'survive', true)] })).includes('facts'));
  assert.ok(rules(scenarioWith({ facts: [fact('a', 'X-ONE-K2M4P', 'user', 'absent-after-supersede', true, 'nope')] })).includes('facts'));
  assert.ok(rules(scenarioWith({ facts: [fact('a', 'X-ONE-K2M4P', 'user', 'absent-after-supersede', true)] })).includes('facts'));
});

test('lint: a fact that is never planted, or planted in another channel', () => {
  assert.ok(rules(scenarioWith({ facts: [fact('ghost', 'GHOST-K2M4P', 'user', 'survive', true)] })).includes('planting'));
  // a user marker that also shows up in a tool output
  const def = scenarioWith(
    { facts: [fact('u', 'LEAK-K2M4P', 'user', 'survive', true)] },
    (s) => ({ ...withUsers({ 4: 'Keep the logs (LEAK-K2M4P).' })(s), results: (k) => (k === 6 ? ['echo LEAK-K2M4P'] : s.results(k)) }),
  );
  assert.ok(rules(def).includes('channel'));
});

test('lint: placement in the first 200 characters (tally: the last 200)', () => {
  const late = 'x'.repeat(250) + ' (LATE-K2M4P)';
  assert.ok(rules(scenarioWith({ facts: [fact('u', 'LATE-K2M4P', 'user', 'survive', true)] }, withUsers({ 4: late }))).includes('placement'));
  // report-only facts are exempt
  assert.ok(!rules(scenarioWith({ facts: [fact('u', 'LATE-K2M4P', 'user', 'report-only', false)] }, withUsers({ 4: late }))).includes('placement'));
});

test('lint: supersession ordering, head, unintended and missed supersessions, USER- ids', () => {
  // successor planted before the superseded fact
  const rev = scenarioWith(
    { facts: [fact('old', 'OLD-K2M4P', 'user', 'absent-after-supersede', true, 'new'), fact('new', 'NEW-K2M4P', 'user', 'survive', true)] },
    withUsers({ 4: 'Correction for USER-P-A1: use port 81 (NEW-K2M4P).', 8: 'USER-P-A1: use port 80 (OLD-K2M4P).' }),
  );
  const rr = rules(rev);
  assert.ok(rr.includes('ordering'), rr.join());
  // intended but the rule does not supersede (no cue, no overlap)
  const missed = scenarioWith(
    { facts: [fact('old', 'OLD-K2M4P', 'user', 'absent-after-supersede', true, 'new'), fact('new', 'NEW-K2M4P', 'user', 'survive', true)] },
    withUsers({ 4: 'Use port 80 for the preview server (OLD-K2M4P).', 8: 'Skip firefox (NEW-K2M4P).' }),
  );
  assert.ok(rules(missed).includes('supersession'));
  // the rule supersedes something that was meant to survive (a false supersession by the scenario's own design)
  const fp = scenarioWith(
    { facts: [fact('a', 'A-K2M4P', 'user', 'survive', true), fact('b', 'B-K2M4P', 'user', 'survive', true)] },
    withUsers({ 4: 'Run the payment specs in firefox (A-K2M4P).', 8: 'Actually, run the payment specs in webkit (B-K2M4P).' }),
  );
  assert.ok(rules(fp).includes('supersession'));
  // an unshared USER- id
  const lone = scenarioWith({ facts: refFacts(false) }, withUsers({ 4: 'USER-LONE-Z9: keep going.' }));
  assert.ok(rules(lone).includes('user-prefix'));
});

test('lint: -ref variants carry exactly the reference facts; pairing of the scripted history', () => {
  const s = makeSession(referenceScript('default', 12, { capBytes: 51_200 }));
  const ref: ScenarioDef = { ...scenarioWith({}), id: 'x-ref', sessions: [s], facts: [...refFacts(true), fact('extra', 'EXTRA-K2M4P', 'head', 'survive', true)], reference: { capBytes: 51_200 } };
  assert.ok(rules(ref).includes('ref'));
  const broken = scenarioWith({}, (b) => ({ ...b, results: (k) => (k === 5 ? [] : b.results(k)) }));
  assert.ok(rules(broken).includes('pairing'));
});

test('lint: a clean O1 variant stays clean when rebuilt from the same parts', () => {
  const { script, facts } = qaWithO1({ id: 'probe', steps: 30 });
  const def = scenarioWith({ facts }, () => script);
  assert.deepEqual(lintScenario(def).issues, []);
});
