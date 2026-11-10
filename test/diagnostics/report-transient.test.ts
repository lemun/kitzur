import test from 'node:test';
import assert from 'node:assert/strict';
import { report, reportStream, renderReport } from '../../src/diagnostics/report.js';

const rec = (seq: number, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, ts: '2026-01-02T03:04:05Z', action: 'passthrough', tokens_in: 10, tokens_out: 10, client_status: 200, attempts: [{ kind: 'ok', status: 200, raw: 10 }], ...extra });
const jsonl = (...lines: string[]) => lines.join('\n') + '\n';
const LINE = /Transient upstream retries/;

test('records without the transient fields give zeros and no extra line', () => {
  const r = report(jsonl(rec(1), rec(2)));
  assert.deepEqual(r.transientRetries, { requests: 0, retries: 0, delayMs: 0 });
  assert.doesNotMatch(renderReport(r), LINE);
});

test('two retried records add up and the line follows the Requests line', () => {
  const r = report(jsonl(rec(1, { transient_retries: 2, transient_retry_delay_ms: 30 }), rec(2), rec(3, { transient_retries: 1, transient_retry_delay_ms: 100 })));
  assert.deepEqual(r.transientRetries, { requests: 2, retries: 3, delayMs: 130 });
  const lines = renderReport(r).split('\n');
  const i = lines.findIndex((l) => l.startsWith('Requests:'));
  assert.equal(lines[i + 1], 'Transient upstream retries: 3 across 2 requests, 130 ms of backoff in total.');
});

test('a non-positive, fractional or string count counts nothing', () => {
  for (const v of [0, -1, 1.5, '2']) {
    const r = report(jsonl(rec(1, { transient_retries: v, transient_retry_delay_ms: 50 })));
    assert.deepEqual(r.transientRetries, { requests: 0, retries: 0, delayMs: 0 }, String(v));
    assert.doesNotMatch(renderReport(r), LINE);
  }
});

test('a missing or invalid delay counts as 0', () => {
  const r = report(jsonl(rec(1, { transient_retries: 1 }), rec(2, { transient_retries: 2, transient_retry_delay_ms: -5 }), rec(3, { transient_retries: 1, transient_retry_delay_ms: 'x' })));
  assert.deepEqual(r.transientRetries, { requests: 3, retries: 4, delayMs: 0 });
});

test('invalid records are not counted', () => {
  const r = report(jsonl(JSON.stringify({ seq: 1, action: 'nope', client_status: 200, tokens_in: 1, transient_retries: 3, transient_retry_delay_ms: 9 })));
  assert.equal(r.coverage.malformed, 1);
  assert.deepEqual(r.transientRetries, { requests: 0, retries: 0, delayMs: 0 });
});

test('reportStream gives the same result as report and retries are unchanged', async () => {
  const text = jsonl(rec(1, { transient_retries: 2, transient_retry_delay_ms: 30, attempts: [{ kind: 'overflow_prompt', status: 413, raw: 10 }, { kind: 'ok', status: 200, raw: 8 }] }), rec(2));
  async function* chunks() { const b = Buffer.from(text); for (let i = 0; i < b.length; i += 7) yield b.subarray(i, i + 7); }
  assert.deepEqual(await reportStream(chunks()), report(text));
  const plain = jsonl(rec(1, { attempts: [{ kind: 'overflow_prompt', status: 413, raw: 10 }, { kind: 'ok', status: 200, raw: 8 }] }), rec(2));
  assert.equal(report(text).retries, 1);
  assert.equal(report(text).retries, report(plain).retries);
});
