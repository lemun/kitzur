import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MAX_RECORD_BYTES, MAX_TRACKED_SESSIONS, report, reportStream, renderReport } from '../../src/diagnostics/report.js';

const record = (session = '会話😀') => JSON.stringify({ seq: 1, action: 'passthrough', client_status: 200, tokens_in: 3, session });
async function* chunks(bytes: Buffer, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

test('byte streaming agrees with string reports across UTF-8, CRLF and final line boundaries', async () => {
  const text = record() + '\r\n\n{bad}\n' + record('other');
  for (const size of [1, 7, 65536]) {
    assert.deepEqual(await reportStream(chunks(Buffer.from(text), size)), report(text));
  }
  assert.equal((await reportStream(chunks(Buffer.from(record() + '\n'), 1))).coverage.partialFinalLine, false);
  assert.equal((await reportStream(chunks(Buffer.alloc(0), 1))).requests, 0);
});

test('oversized records are discarded once and parsing resumes at the next newline', async () => {
  const exact = record() + ' '.repeat(MAX_RECORD_BYTES - Buffer.byteLength(record()));
  const text = exact + '\n' + exact + ' \n' + record();
  const r = await reportStream(chunks(Buffer.from(text), 17003));
  assert.equal(r.requests, 2);
  assert.equal(r.coverage.oversized, 1);
  assert.equal(r.coverage.malformed, 1);
  assert.equal(r.coverage.partialFinalLine, true);
  const tail = await reportStream(chunks(Buffer.from('x'.repeat(MAX_RECORD_BYTES + 1)), 65536));
  assert.equal(tail.coverage.oversized, 1);
  assert.equal(tail.coverage.partialFinalLine, true);
});

test('record cap measures UTF-8 bytes in both APIs, including CR before LF', async () => {
  const base = record();
  const padding = MAX_RECORD_BYTES - Buffer.byteLength(base);
  const exact = base.slice(0, -1) + ',"padding":"' + 'é'.repeat(Math.floor((padding - 13) / 2)) + '"}';
  const line = exact + ' '.repeat(MAX_RECORD_BYTES - Buffer.byteLength(exact));
  assert.equal(Buffer.byteLength(line), MAX_RECORD_BYTES);
  const text = line + '\n' + line + '\r\n' + record();
  const streamed = await reportStream(chunks(Buffer.from(text), 4093));
  assert.deepEqual(streamed, report(text));
  assert.equal(streamed.requests, 2);
  assert.equal(streamed.coverage.oversized, 1);
  assert.equal(streamed.coverage.malformed, 1);
});

test('sessions are bounded with explicit lower-bound and missing-ID coverage', async () => {
  async function* input() {
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) yield Buffer.from(record(String(i)) + '\n');
    yield Buffer.from(record('0') + '\n' + record('') + '\n');
  }
  const r = await reportStream(input());
  assert.equal(r.uniqueSessions, MAX_TRACKED_SESSIONS);
  assert.equal(r.sessionCoverage.approximate, true);
  assert.equal(r.sessionCoverage.lowerBound, true);
  assert.equal(r.sessionCoverage.missing, 1);
  assert.match(renderReport(r), /at least 10000 sessions/);
  assert.equal(report(record()).sessionCoverage.lowerBound, false);
  assert.equal(report(record()).uniqueSessions, 1);
});

test('stream read errors propagate', async () => {
  async function* broken() { yield Buffer.from(record()); throw new Error('read failed'); }
  await assert.rejects(reportStream(broken()), /read failed/);
});

test('CLI reports a generated 200 MiB log under a 48 MiB heap limit', { timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-report-stream-'));
  const path = join(dir, 'stats.jsonl');
  try {
    const fd = openSync(path, 'w');
    let count = 0;
    try {
      // Every record is 4096 bytes, including LF: exactly 200 MiB on disk.
      for (; count < 200 * 1024 * 1024 / 4096; count++) {
        const line = record(String(count));
        writeSync(fd, line + ' '.repeat(4095 - Buffer.byteLength(line)) + '\n');
      }
    } finally { closeSync(fd); }
    const child = spawnSync(process.execPath, ['--max-old-space-size=48', 'dist/src/cli.js', 'report', path, '--json'], { encoding: 'utf8', timeout: 110000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(child.stdout);
    assert.equal(r.requests, count);
    assert.equal(r.tokenTotals.input, count * 3);
    assert.equal(r.coverage.malformed, 0);
    assert.equal(r.uniqueSessions, MAX_TRACKED_SESSIONS);
    assert.equal(r.sessionCoverage.lowerBound, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
