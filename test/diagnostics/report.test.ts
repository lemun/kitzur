import test from 'node:test';
import assert from 'node:assert/strict';
import { report, renderReport } from '../../src/diagnostics/report.js';

test('report counts eligible forwarded tokens, all retries, and final-only actual usage', () => {
  const text = [
    JSON.stringify({ seq: 1, ts: '2026-01-02T03:04:05Z', session: 'SECRET_SESSION', action: 'compact', compacted: true, tokens_in: 100, tokens_out: 60, client_status: 200, attempts: [{ kind: 'overflow_prompt', status: 413, raw: 100 }, { kind: 'ok', status: 200, raw: 61 }], usage: { prompt_tokens: 60, completion_tokens: 8 }, total_ms: 12, engine_ms: 2, upstream_ms: 7 }),
    JSON.stringify({ seq: 2, ts: '2026-01-02T03:05:05Z', action: 'shadow', shadow: true, shadow_tokens_out: 45, tokens_in: 50, tokens_out: 50, client_status: 200, attempts: [{ kind: 'ok', status: 200, raw: 50 }] }),
    JSON.stringify({ seq: 3, ts: '2026-01-02T03:06:05Z', action: 'impossible', tokens_in: 30, tokens_out: 0, client_status: 400, attempts: [] }),
  ].join('\n') + '\n';
  const r = report(text);
  assert.equal(r.requests, 3);
  assert.equal(r.compactions, 1);
  assert.equal(r.retries, 1);
  assert.equal(r.failures, 1);
  assert.equal(r.uniqueSessions, 1);
  assert.equal(r.localRejects, 1);
  assert.equal(r.shadowRequests, 1);
  assert.equal(r.tokenTotals.input, 180);
  assert.equal(r.tokenTotals.forwarded, 110);
  assert.equal(r.tokenTotals.reductionEligibleInput, 100);
  assert.equal(r.tokenTotals.reductionEligibleForwarded, 60);
  assert.equal(r.tokenTotals.reductionPercent, 40);
  assert.equal(r.tokenTotals.attemptedRaw, 211);
  assert.equal(r.tokenTotals.shadowEstimatedForwarded, 45);
  assert.deepEqual(r.upstreamStatusCounts, { '200': 2, '413': 1 });
  assert.deepEqual([r.tokenTotals.actualUpstreamPrompt, r.tokenTotals.actualUpstreamCompletion, r.tokenTotals.actualUsageRecords], [60, 8, 1]);
  assert.equal(r.timingMs.total, 12);
  assert.deepEqual(r.fieldCoverage, { tokensIn: 3, tokensOut: 3, attempts: 3, attemptedRaw: 3, shadowEstimatedForwarded: 1, actualPromptUsage: 1, actualCompletionUsage: 1, totalMs: 1, engineMs: 1, upstreamMs: 1, requestPathMs: 0, responsePathMs: 0 });
  const rendered = renderReport(r);
  assert.match(rendered, /final response only/);
  assert.doesNotMatch(rendered, /SECRET_SESSION/);
});

test('report handles empty, malformed, and partial JSONL without throwing', () => {
  assert.equal(report('').requests, 0);
  const malformed = report('{bad}\n{}\n"unrelated"\n');
  assert.equal(malformed.coverage.malformed, 3);
  assert.equal(malformed.requests, 0);
  const partial = report('{"seq":1,"action":"passthrough","client_status":200,"ts":"2026-01-01T00:00:00Z","tokens_in":3,"tokens_out":2,"attempts":[{}]}');
  assert.equal(partial.requests, 1);
  assert.equal(partial.coverage.partialFinalLine, true);
  assert.equal(partial.tokenTotals.reductionPercent, 100 / 3);
});

test('missing or malformed attempts are unknown, not evidence of a local rejection', () => {
  const base = {seq:1,action:'passthrough',client_status:500,tokens_in:100};
  const r=report([base,{...base,seq:2,attempts:[null]},{...base,seq:3,attempts:[]}].map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.equal(r.requests,3);assert.equal(r.localRejects,1);assert.equal(r.retries,0);
  assert.equal(r.fieldCoverage.attempts,1);
});
