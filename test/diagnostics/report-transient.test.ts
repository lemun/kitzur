import test from 'node:test';
import assert from 'node:assert/strict';
import { report, reportStream, renderReport } from '../../src/diagnostics/report.js';

const rec = (seq: number, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, ts: '2026-01-02T03:04:05Z', action: 'passthrough', tokens_in: 10, tokens_out: 10, client_status: 200, attempts: [{ kind: 'ok', status: 200, raw: 10 }], ...extra });
const LINE = 'Transient upstream retries:';

test('records without transient retry fields give zeros and no extra line', () => {
  const r = report(rec(1) + '\n' + rec(2) + '\n');
  assert.deepEqual(r.transientRetries, { requests: 0, retries: 0, delayMs: 0 });
  assert.ok(!renderReport(r).includes(LINE));
});

test('retried records add up and the extra line follows the Requests line', () => {
  const text = [rec(1, { transient_retries: 2, transient_retry_delay_ms: 750 }), rec(2, { transient_retries: 1, transient_retry_delay_ms: 250 }), rec(3)].join('\n') + '\n';
  const r = report(text);
  assert.deepEqual(r.transientRetries, { requests: 2, retries: 3, delayMs: 1000 });
  const lines = renderReport(r).split('\n');
  const at = lines.findIndex((l) => l.startsWith('Requests:'));
  assert.equal(lines[at + 1], 'Transient upstream retries: 3 across 2 requests, 1000 ms of backoff in total.');
});

test('invalid transient retry counts count nothing and a missing or invalid delay counts as 0', () => {
  const bad = [0, -1, 1.5, '2', null].map((v, i) => rec(i + 1, { transient_retries: v, transient_retry_delay_ms: 100 }));
  const r = report(bad.join('\n') + '\n');
  assert.deepEqual(r.transientRetries, { requests: 0, retries: 0, delayMs: 0 });
  assert.ok(!renderReport(r).includes(LINE));
  const delays = report([rec(1, { transient_retries: 1 }), rec(2, { transient_retries: 1, transient_retry_delay_ms: -5 }), rec(3, { transient_retries: 1, transient_retry_delay_ms: 'x' })].join('\n') + '\n');
  assert.deepEqual(delays.transientRetries, { requests: 3, retries: 3, delayMs: 0 });
});

test('invalid records are not counted', () => {
  const r = report(JSON.stringify({ seq: 1, action: 'nope', client_status: 200, tokens_in: 1, transient_retries: 2, transient_retry_delay_ms: 10 }) + '\n');
  assert.equal(r.coverage.malformed, 1);
  assert.deepEqual(r.transientRetries, { requests: 0, retries: 0, delayMs: 0 });
});

test('the existing retries total is unchanged by transient retry fields', () => {
  const compacted = { attempts: [{ kind: 'overflow_prompt', status: 413, raw: 100 }, { kind: 'ok', status: 200, raw: 60 }] };
  const plain = report(rec(1, compacted) + '\n');
  const withTransient = report(rec(1, { ...compacted, transient_retries: 3, transient_retry_delay_ms: 900 }) + '\n');
  assert.equal(plain.retries, 1);
  assert.equal(withTransient.retries, 1);
  assert.equal(withTransient.transientRetries.retries, 3);
});

test('the stream path gives the same result as report()', async () => {
  const text = [rec(1, { transient_retries: 2, transient_retry_delay_ms: 500 }), rec(2, { transient_retries: 1 })].join('\n') + '\n';
  async function* chunks(bytes: Buffer, size: number) { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
  for (const size of [1, 13, 65536]) assert.deepEqual(await reportStream(chunks(Buffer.from(text), size)), report(text));
  assert.deepEqual(report(text).transientRetries, { requests: 2, retries: 3, delayMs: 500 });
});
