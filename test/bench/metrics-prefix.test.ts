import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixMetrics } from '../../bench/metrics/prefix.js';
import type { ClientRec, RunRecords, UpstreamRec } from '../../bench/metrics/records.js';

let seq = 0;
function up(x: Partial<UpstreamRec> & { step: number; digests: string[]; msgTokens: number[] }): UpstreamRec {
  const overhead = x.overhead ?? 3;
  return {
    seq: ++seq, session: 's', kind: 'main', status: 200, rejected: false, prompt: x.msgTokens.reduce((a, b) => a + b, 0) + overhead,
    completion: 0, maxTokens: 0, bytes: 0, lcp: 0, lcpGlobal: null, overhead, facts: x.digests.map(() => []), pairingError: null, pairingStrict: [], ...x,
  };
}
const cl = (step: number, digests: string[]): ClientRec => ({
  session: 's', step, kind: 'main', attempt: 1, digests, facts: digests.map(() => []), prompt: null, bytes: null, status: 200, clientErrorKind: null,
  usage: null, maxTokens: null, pairingStrict: [],
});

test('hit, uncached, fresh (client messages at first forwarding), fresh_synth, L, reusable, block16, template breaks', () => {
  seq = 0;
  const rr: RunRecords = {
    up: [
      up({ step: 0, digests: ['a', 'b'], msgTokens: [10, 20], lcp: 0 }), //                      prompt 33, fresh 30 + 3 (first overhead)
      up({ step: 1, digests: ['a', 'b', 'c'], msgTokens: [10, 20, 5], lcp: 25 }), //             prompt 38, fresh 5; append-only but LCP 25 < 33 − 3
      up({ step: 2, digests: ['a', 'b', 'c', 'x'], msgTokens: [10, 20, 5, 9], lcp: 30, status: 400, rejected: true }), // rejected: ignored
      up({ step: 2, digests: ['a', 'S', 'd'], msgTokens: [10, 7, 6], lcp: 10 }), //                prompt 26, S synthesized (7), d client (6)
      up({ step: 3, kind: 'summarizer', digests: ['q'], msgTokens: [100], lcp: 0 }), //            excluded
    ],
    client: [cl(0, ['a', 'b']), cl(1, ['a', 'b', 'c']), cl(2, ['a', 'b', 'c', 'd'])],
    steps: { s: 3 },
  };
  const p = prefixMetrics(rr);
  assert.equal(p.accepted_requests, 3);
  assert.equal(p.prompt_accepted, 33 + 38 + 26);
  assert.equal(p.lcp, 0 + 25 + 10);
  assert.equal(p.hit, 35 / 97);
  assert.equal(p.uncached, 97 - 35);
  assert.equal(p.fresh, 33 + 5 + 6);
  assert.equal(p.fresh_synth, 7);
  assert.equal(p.fresh_literal, 51);
  assert.equal(p.L, 62 - 44);
  assert.equal(p.reusable, 35 / (97 - 44));
  assert.equal(p.hit_block16, 16 / 97);
  assert.equal(p.hit_global, null, 'not computed');
  assert.equal(p.template_breaks, 1);
  assert.deepEqual(p.per_step.map((x) => [x.step, x.lcp, x.fresh, x.freshSynth]), [[0, 0, 33, 0], [1, 25, 5, 0], [2, 10, 6, 7]]);
});

test('a message seen in an earlier accepted request is never fresh again (re-prefill goes to L); sessions are separate', () => {
  seq = 0;
  const rr: RunRecords = {
    up: [
      up({ session: 'p', step: 0, digests: ['a', 'b'], msgTokens: [10, 10], overhead: 0 }),
      up({ session: 'p', step: 1, digests: ['b', 'a'], msgTokens: [10, 10], overhead: 0, lcp: 0 }), // reordered: all re-prefill
      up({ session: 'q', step: 0, digests: ['a', 'b'], msgTokens: [10, 10], overhead: 0, lcpGlobal: 20 }),
    ],
    client: [],
    steps: { p: 2, q: 1 },
  };
  const p = prefixMetrics(rr);
  assert.equal(p.fresh, 20 + 0 + 20, 'q sees a and b for the first time in its own session');
  assert.equal(p.L, 60 - 0 - 40);
});

test('hit_global uses the max LCP over all earlier accepted requests when every request has it', () => {
  seq = 0;
  const rr: RunRecords = {
    up: [
      up({ step: 0, digests: ['a'], msgTokens: [10], overhead: 0, lcpGlobal: 0 }),
      up({ step: 1, digests: ['a', 'b'], msgTokens: [10, 10], overhead: 0, lcp: 5, lcpGlobal: 10 }),
    ],
    client: [],
    steps: { s: 2 },
  };
  const p = prefixMetrics(rr);
  assert.equal(p.hit, 5 / 30);
  assert.equal(p.hit_global, 10 / 30);
});

test('no accepted requests: ratios are null, not NaN', () => {
  const p = prefixMetrics({ up: [], client: [], steps: { s: 0 } });
  assert.equal(p.hit, null);
  assert.equal(p.reusable, null);
  assert.equal(p.uncached, 0);
});
