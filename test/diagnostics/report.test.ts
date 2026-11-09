import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report, renderReport } from '../../src/diagnostics/report.js';
import { main, type CliIO } from '../../src/cli.js';

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
  const hostile=report('{"seq":1,"action":{"toString":"SECRET"},"client_status":200,"tokens_in":1}\n');
  assert.equal(hostile.coverage.malformed,1);
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

const timelineRecords = [
  JSON.stringify({ seq: 1, ts: '2026-01-02T03:04:05Z', action: 'compact', compacted: true, tokens_in: 100, tokens_out: 60, client_status: 200, attempts: [{ kind: 'overflow_prompt', status: 413 }, { kind: 'ok', status: 200 }] }),
  JSON.stringify({ seq: 2, ts: '2026-01-02T05:00:00Z', action: 'passthrough', tokens_in: 100, tokens_out: 100, client_status: 502, attempts: [{ kind: 'http_error', status: 502 }] }),
  JSON.stringify({ seq: 3, ts: '2026-01-03T00:30:00Z', action: 'shadow', shadow: true, tokens_in: 40, tokens_out: 40, client_status: 200, attempts: [{ kind: 'ok', status: 200 }] }),
];

test('report --by day buckets records by UTC day with eligible-only reduction', () => {
  const r = report(timelineRecords.join('\n') + '\n', { by: 'day' });
  assert.equal(r.untimedRequests, 0);
  assert.equal(r.timelineDroppedRequests, undefined);
  assert.deepEqual(r.timeline, [
    { start: '2026-01-02T00:00:00.000Z', requests: 2, compactions: 1, retries: 1, failures: 1, input: 200, forwarded: 160, reductionPercent: 20 },
    { start: '2026-01-03T00:00:00.000Z', requests: 1, compactions: 0, retries: 0, failures: 0, input: 0, forwarded: 0, reductionPercent: null },
  ]);
  const rendered = renderReport(r);
  assert.match(rendered, /start \| requests \| compactions \| input \| forwarded \| reduction/);
  assert.match(rendered, /\n2026-01-02T00:00:00\.000Z \| 2 \| 1 \| 200 \| 160 \| 20\.0%/);
  assert.match(rendered, /\n2026-01-03T00:00:00\.000Z \| 1 \| 0 \| 0 \| 0 \| n\/a/);
});

test('report --by hour splits buckets; untimed records only count in untimedRequests', () => {
  const untimed = JSON.stringify({ seq: 4, action: 'passthrough', tokens_in: 10, tokens_out: 10, client_status: 200, attempts: [{ kind: 'ok', status: 200 }] });
  const r = report([...timelineRecords, untimed].join('\n') + '\n', { by: 'hour' });
  assert.deepEqual(r.timeline!.map((b) => [b.start, b.requests, b.reductionPercent]), [
    ['2026-01-02T03:00:00.000Z', 1, 40], ['2026-01-02T05:00:00.000Z', 1, 0], ['2026-01-03T00:00:00.000Z', 1, null],
  ]);
  assert.equal(r.untimedRequests, 1);
  assert.equal(r.requests, 4);
});

test('report without --by has no timeline keys and is unchanged', () => {
  const text = timelineRecords.join('\n') + '\n';
  const r = report(text);
  assert.ok(!('timeline' in r) && !('untimedRequests' in r) && !('timelineDroppedRequests' in r));
  assert.deepEqual(r, report(text, {}));
  assert.doesNotMatch(renderReport(r), /Timeline/);
});

test('report --by keeps the newest 2,000 buckets and counts the requests in dropped ones', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const lines: string[] = [];
  for (let i = 0; i < 2005; i++) lines.push(JSON.stringify({ seq: i, ts: new Date(base + i * 3_600_000).toISOString(), action: 'passthrough', tokens_in: 1, tokens_out: 1, client_status: 200, attempts: [{ kind: 'ok' }] }));
  for (const order of [lines, [...lines].reverse()]) {
    const r = report(order.join('\n') + '\n', { by: 'hour' });
    assert.equal(r.timeline!.length, 2000);
    assert.equal(r.timelineDroppedRequests, 5);
    assert.equal(r.timeline![0]!.start, new Date(base + 5 * 3_600_000).toISOString());
    assert.equal(r.timeline!.at(-1)!.start, new Date(base + 2004 * 3_600_000).toISOString());
    assert.equal(r.requests, 2005);
  }
});

test('report --by counts dropped requests per record, including repeats of an evicted bucket', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const line = (i: number) => JSON.stringify({ seq: i, ts: new Date(base + i * 3_600_000).toISOString(), action: 'passthrough', tokens_in: 1, tokens_out: 1, client_status: 200, attempts: [{ kind: 'ok' }] });
  const lines = [line(0), line(0)];
  for (let i = 2004; i >= 1; i--) lines.push(line(i));
  for (let k = 0; k < 3; k++) lines.push(line(0));
  const r = report(lines.join('\n') + '\n', { by: 'hour' });
  assert.equal(r.timeline!.length, 2000);
  assert.equal(r.timeline![0]!.start, new Date(base + 5 * 3_600_000).toISOString());
  // Bucket 0 is evicted with its 2 requests, hours 4..1 are evicted on arrival, then 3 more hour-0 records.
  assert.equal(r.timelineDroppedRequests, 2 + 4 + 3);
  assert.equal(r.requests, 2004 + 2 + 3);
});

test('report CLI --by adds the timeline and rejects other values', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-report-by-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'stats.jsonl'), timelineRecords.join('\n') + '\n');
  const output: string[] = []; const errors: string[] = [];
  const io: CliIO = { stdout: (s) => void output.push(s), stderr: (s) => void errors.push(s), env: {}, cwd: dir, onSignal: () => {} };
  assert.equal(await main(['report', 'stats.jsonl', '--by', 'day', '--json'], io), 0);
  assert.equal(JSON.parse(output.join('')).timeline.length, 2);
  output.length = 0;
  assert.equal(await main(['report', 'stats.jsonl', '--json'], io), 0);
  assert.ok(!('timeline' in JSON.parse(output.join(''))));
  assert.equal(await main(['report', 'stats.jsonl', '--by', 'week'], io), 2);
  assert.match(errors.join(''), /--by must be hour or day/);
});
