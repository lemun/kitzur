import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../src/types.js';
import { CHAIN_ROOT, chainKeys, digestOf, inputsHash, planKey, sha256Hex } from '../../src/engine/canonical.js';
import { boundaries, headEnd, keptStart, unitsOf } from '../../src/engine/units.js';
import { defectsSubset, pairingDefects } from '../../src/engine/pairing.js';
import { SUMMARY_HEADER } from '../../src/engine/contracts.js';
import { testConfig } from './stubs.js';

const cfg = testConfig();
const sys: ChatMessage = { role: 'system', content: 'S' };
const user = (t: string): ChatMessage => ({ role: 'user', content: t });
const asst = (t: string | null, ...ids: string[]): ChatMessage => ({
  role: 'assistant', content: t,
  ...(ids.length ? { tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } })) } : {}),
});
const tool = (id: string, t = 'r'): ChatMessage => ({ role: 'tool', tool_call_id: id, content: t });

test('chain: K_i = sha256(K_{i-1} ‖ d_i) from sha256("kitzur/chain/1")', () => {
  assert.equal(CHAIN_ROOT, sha256Hex('kitzur/chain/1'));
  const d = [digestOf(sys), digestOf(user('g'))];
  const K = chainKeys(d);
  assert.equal(K[0], sha256Hex(CHAIN_ROOT + d[0]));
  assert.equal(K[1], sha256Hex(K[0] + d[1]!));
  // digests include every field, reasoning too (ADR-8); key order does not matter
  assert.notEqual(digestOf({ role: 'assistant', content: 'x' }), digestOf({ role: 'assistant', content: 'x', reasoning_content: 'r' }));
  assert.equal(digestOf({ role: 'user', content: 'x' }), digestOf({ content: 'x', role: 'user' }));
  // plan keys depend on both the chain and P
  assert.notEqual(planKey(K[1]!, 'a'), planKey(K[1]!, 'b'));
  assert.notEqual(planKey(K[0]!, 'a'), planKey(K[1]!, 'a'));
});

test('inputsHash is canonical over P', () => {
  const P = {
    engineVersion: 'v', configPlanHash: 'c', tokenizerSha256: null, counterMode: 'estimate' as const, templateName: 'sim',
    templateKwargs: '{}', tPlan: 1, window: 2, maxPrompt: null, tighten: 0, correction: 1, maxBodyBytes: null,
    toolsDigest: 't', fixedBytes: 512,
  };
  assert.equal(inputsHash(P), inputsHash({ ...P }));
  assert.notEqual(inputsHash(P), inputsHash({ ...P, tighten: 256 }));
});

test('headEnd: first assistant, trailing prior summaries left out, n without assistant', () => {
  const H = [sys, user('g'), asst('a'), tool('x')];
  assert.equal(headEnd(H, H.length, cfg.client), 2);
  assert.equal(headEnd([sys, user('g')], 2, cfg.client), 2);
  const S = user(SUMMARY_HEADER + '\n\n- #3: x');
  assert.equal(headEnd([sys, user('g'), S, asst('a')], 4, cfg.client), 2);
  // virtual requests see only their prefix
  assert.equal(headEnd(H, 2, cfg.client), 2);
});

test('headEnd: client-summary extension (), OpenCode and Kilo shapes', () => {
  const marker = user('What did we do so far?');
  const cs = asst('## Objective\n- migrate\n\n## Next Move\n1. run');
  const H = [sys, marker, cs, asst(null, 'c1'), tool('c1'), user('Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.')];
  assert.equal(headEnd(H, H.length, cfg.client), 3);
  // Kilo: array content with an extra <environment_details> part; first text part decides
  const kmarker: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'What did we do so far?' }, { type: 'text', text: '<environment_details>x</environment_details>' }] };
  assert.equal(headEnd([sys, kmarker, cs, asst('a')], 4, cfg.client), 3);
  // not extended: summary with tool calls, missing markers, wrong marker text
  assert.equal(headEnd([sys, marker, asst('## Objective', 'c9'), tool('c9')], 4, cfg.client), 2);
  assert.equal(headEnd([sys, marker, asst('plain text'), asst('a')], 4, cfg.client), 2);
  assert.equal(headEnd([sys, user('hello'), cs, asst('a')], 4, cfg.client), 2);
  // pure in H[0..hEnd]: a virtual request that stops before the summary has hEnd = its length
  assert.equal(headEnd(H, 2, cfg.client), 2);
});

test('units (): assistant/user/system/developer start units; tool, function, unknown attach', () => {
  const H: ChatMessage[] = [
    sys, user('g'), asst('a1', 'c1'), tool('c1'), user('u'), { role: 'function', name: 'f', content: 'x' },
    asst('a2'), asst('a3', 'c2'), tool('c2'), { role: 'weird', content: 'w' }, { role: 'developer', content: 'd' },
  ];
  const u = unitsOf(H, 2, H.length);
  assert.deepEqual(u.map((x) => [x.start, x.end, x.kind]), [
    [2, 4, 'assistant'], [4, 6, 'user'], [6, 7, 'assistant'], [7, 10, 'assistant'], [10, 11, 'user'],
  ]);
  // a non-starting message at hEnd forms a unit by itself
  const H2 = [sys, user('g'), tool('zz'), tool('yy'), asst('a')];
  assert.deepEqual(unitsOf(H2, 2, 5).map((x) => [x.start, x.end, x.kind]), [[2, 4, 'other'], [4, 5, 'assistant']]);
});

test('keptStart: newest k assistant units plus the user units after them', () => {
  const H = [sys, user('g'), asst('a1', 'c1'), tool('c1'), user('u1'), asst('a2', 'c2'), tool('c2'), user('u2')];
  const u = unitsOf(H, 2, H.length);
  assert.equal(keptStart(u, 1, 2), 5);
  assert.equal(keptStart(u, 2, 2), 2);
  assert.equal(keptStart(u, 9, 2), 2); // fewer assistant units than k: keep them all
  assert.equal(keptStart(u, 0, 2), 5); // keepRecent >= 1 enforced
  // no assistant unit: everything is mandatory
  assert.equal(keptStart(unitsOf([sys, user('g'), user('x')], 1, 3), 1, 1), 1);
});

test('boundaries: assistant after a non-assistant, plus n', () => {
  const H = [sys, user('g'), asst('a1', 'c1'), tool('c1'), asst('a2'), asst('a3', 'c2'), tool('c2'), user('u')];
  assert.deepEqual(boundaries(H), [2, 4, 8]);
  assert.deepEqual(boundaries([asst('x'), user('y')]), [2]);
  assert.deepEqual(boundaries([]), []);
});

test('pairing defects: orphans, unanswered calls, duplicates; subset across index shifts', () => {
  assert.equal(pairingDefects([sys, user('g'), asst('a', 'c1', 'c2'), tool('c2'), tool('c1'), user('u')]).size, 0);
  const bad = [sys, asst('a', 'c1'), user('interrupt'), tool('c1'), tool('zz')];
  const d = pairingDefects(bad);
  assert.deepEqual([...d.entries()].sort(), [['orphan:c1', 1], ['orphan:zz', 1], ['unanswered:c1', 1]]);
  // pending calls at the end are the live edge, not a defect
  assert.equal(pairingDefects([sys, user('g'), asst('a', 'c1')]).size, 0);
  assert.equal(pairingDefects([asst('a', 'c1', 'c1'), tool('c1'), tool('c1')]).get('dup:c1'), 1);
  // subset
  const cut = [sys, user('S'), tool('c1'), tool('zz')];
  assert.ok(defectsSubset(pairingDefects(cut), d));
  assert.ok(!defectsSubset(pairingDefects([sys, asst('a', 'q'), user('x')]), d));
});

test('streamDigest == sha256(canonicalJSON(x)) on awkward values', async () => {
  const { streamDigest } = await import('../../src/engine/canonical.js');
  const big = 'x'.repeat(10_000) + '😀' + 'é'.repeat(5000) + '\ud800' + 'y'.repeat(70_000);
  const values: unknown[] = [
    null, undefined, 0, -0, 1.5, NaN, Infinity, 'plain', '\ud800lone', true, 12n, [1, undefined, null, 'x'],
    { b: 1, a: [2, { d: big, c: undefined }], '😀': 1, '￿': 2, '': null },
    new Map<string, unknown>([['z', 1], ['a', big]]), { role: 'tool', tool_call_id: 'c', content: big }, [big, big, { k: big }], () => 1,
  ];
  for (const v of values) assert.equal(streamDigest(v), digestOf(v), JSON.stringify(typeof v));
});
