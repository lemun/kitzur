import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClientError, clientErrors, headroom, pairingReport, strictPairingDefects } from '../../bench/metrics/pairing.js';
import type { ClientRec, RunRecords, UpstreamRec } from '../../bench/metrics/records.js';
import { dist as timingDist } from '../../bench/metrics/timing.js';

const call = (id: string) => ({ id, type: 'function', function: { name: 'x', arguments: '{}' } });
const tool = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'ok' });

test('strict positional pairing defects (keyed by id and position)', () => {
  assert.deepEqual(strictPairingDefects([{ role: 'assistant', tool_calls: [call('a'), call('b')] }, tool('a'), tool('b')]), []);
  assert.deepEqual(strictPairingDefects([{ role: 'assistant', tool_calls: [call('a'), call('b')] }, tool('b'), tool('a')]), ['mismatch:a#0', 'mismatch:b#1']);
  assert.deepEqual(strictPairingDefects([{ role: 'assistant', tool_calls: [call('a'), call('b')] }, tool('a'), { role: 'user', content: 'u' }]), ['unanswered:b#1']);
  assert.deepEqual(strictPairingDefects([{ role: 'user', content: 'u' }, tool('z')]), ['orphan:z#0']);
});

function up(step: number, defects: string[]): UpstreamRec {
  return {
    seq: step + 1, session: 's', step, kind: 'main', status: 200, rejected: false, prompt: 100 + step, completion: 20, maxTokens: 0, bytes: 0, lcp: 0,
    lcpGlobal: null, digests: [String(step)], msgTokens: [1], overhead: 0, facts: [[]], pairingError: null, pairingStrict: defects,
  };
}
function cl(step: number, defects: string[], kind: string | null = null): ClientRec {
  return {
    session: 's', step, kind: 'main', attempt: 1, digests: [String(step)], facts: [[]], prompt: null, bytes: null, status: kind ? 400 : 200,
    clientErrorKind: kind, usage: null, maxTokens: null, pairingStrict: defects,
  };
}

test('pairing report: an output defect set must be a subset of its client request’s', () => {
  const rr: RunRecords = {
    up: [up(0, []), up(1, ['orphan:q#0']), up(2, ['unanswered:c#0'])],
    client: [cl(0, []), cl(1, ['orphan:q#0']), cl(2, [])],
    steps: { s: 3 },
  };
  const p = pairingReport(rr);
  assert.equal(p.checked, 3);
  assert.equal(p.withDefects, 2);
  assert.deepEqual(p.violations.map((v) => [v.step, v.extra]), [[2, ['unanswered:c#0']]]);
});

test('client-visible errors (benchmark contract )', () => {
  assert.equal(classifyClientError({ status: 200, sawDone: true, finishReason: 'tool_calls', toolCalls: 1 }), null);
  assert.equal(classifyClientError({ status: 400 }), 'http_400');
  assert.equal(classifyClientError({ status: null }), 'transport');
  assert.equal(classifyClientError({ status: 200, sawErrorEvent: true, sawDone: true }), 'stream_error');
  assert.equal(classifyClientError({ status: 200, sawDone: false, finishReason: null }), 'truncated_stream');
  assert.equal(classifyClientError({ status: 200, sawDone: false, finishReason: 'stop', toolCalls: 0 }), null, 'finish_reason without [DONE] is fine');
  assert.equal(classifyClientError({ status: 200, sawDone: true, finishReason: 'length', toolCalls: 0 }), 'length_no_tool');
  assert.equal(classifyClientError({ status: 200, sawDone: true, finishReason: 'length', toolCalls: 1 }), null);
  assert.equal(classifyClientError({ status: 200, stream: false, finishReason: 'stop' }), null);
  const e = clientErrors([cl(0, []), cl(1, [], 'http_status'), cl(2, [], 'length')]);
  assert.deepEqual(e, { total: 2, byKind: { http_status: 1, length: 1 }, first: { session: 's', step: 1, kind: 'http_status' } });
});

test('headroom against the OpenCode client’s compaction point (benchmark contract )', () => {
  const h = headroom([up(0, []), up(1, []), { ...up(2, []), status: 400 }], { W: 100_000, O: 32_000 });
  assert.equal(h.usable, 68_000);
  assert.equal(h.maxTotal, 121, 'rejected requests are not reported to the client');
  assert.equal(h.headroom, 121 - 68_000);
  assert.deepEqual(h.at, { session: 's', step: 1 });
  assert.equal(headroom([], { W: 32_000, O: 8_000 }).usable, 24_000);
});

test('timing distributions (nearest rank; null when empty)', () => {
  const d = timingDist([5, 1, 3, 2, 4]);
  assert.deepEqual([d.n, d.p50, d.p90, d.p99, d.max, d.mean], [5, 3, 5, 5, 5, 3]);
  const e = timingDist([]);
  assert.deepEqual([e.n, e.p50, e.max], [0, null, null]);
});
