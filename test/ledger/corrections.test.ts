import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supersede, supersedeRules, explicitIds, type UserText } from '../../src/engine/ledger/supersede.js';
import { cfg } from './fixtures.js';
// Expected retained/superseded facts are specified independently of algorithm
// scoring. These cases do not relax an aggregate success threshold.
import { CORRECTION_CASES as scenarios } from '../../bench/coding/correction-cases.js';
for (const fixture of scenarios)
    test(fixture.name, () => {
        const result = supersede([{ index: 1, text: fixture.older, head: false }, { index: 2, text: fixture.later, head: false }], supersedeRules(cfg().ledger), new Set());
        assert.deepEqual(result.sentences.get(1)!.flatMap((s, i) => s.supersededBy === 2 ? [i] : []), fixture.superseded);
        assert.ok(result.sentences.get(2)!.every(s => s.supersededBy === null));
    });
test('correction chain and reinstatement retain only latest explicit rule', () => {
    const texts = ['USER-RETRY-R1: use retries=1.', 'Correction USER-RETRY-R1: use retries=2.', 'Correction USER-RETRY-R1: use retries=0.', 'Correction USER-RETRY-R1: use retries=1 again.'];
    const result = supersede(texts.map((text, index) => ({ text, index, head: false })), supersedeRules(cfg().ledger), new Set());
    assert.deepEqual(texts.map((_, i) => result.sentences.get(i)![0]!.supersededBy), [1, 2, 3, null]);
});
test('head cancellation amends immutable task without removing it', () => {
    const msgs: UserText[] = [{ index: 0, text: 'Run the payment tests.', head: true }, { index: 1, text: 'Cancel the payment tests.', head: false }];
    const result = supersede(msgs, supersedeRules(cfg().ledger), new Set(explicitIds(msgs[0]!.text)));
    assert.equal(result.sentences.has(0), false);
    assert.ok(result.amends.has(1));
});
