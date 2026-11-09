import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report, renderTimelineCsv } from '../../src/diagnostics/report.js';
import { main, type CliIO } from '../../src/cli.js';

const HEADER = 'start,requests,compactions,retries,failures,input,forwarded,reduction_percent\n';
const records = [
  JSON.stringify({ seq: 1, ts: '2026-01-02T03:04:05Z', action: 'compact', compacted: true, tokens_in: 100, tokens_out: 60, client_status: 200, attempts: [{ kind: 'overflow_prompt', status: 413 }, { kind: 'ok', status: 200 }] }),
  JSON.stringify({ seq: 2, ts: '2026-01-02T05:00:00Z', action: 'passthrough', tokens_in: 100, tokens_out: 100, client_status: 502, attempts: [{ kind: 'http_error', status: 502 }] }),
  JSON.stringify({ seq: 3, ts: '2026-01-03T00:30:00Z', action: 'shadow', shadow: true, tokens_in: 40, tokens_out: 40, client_status: 200, attempts: [{ kind: 'ok', status: 200 }] }),
  JSON.stringify({ seq: 4, ts: '2026-01-04T10:00:00Z', action: 'compact', compacted: true, tokens_in: 30, tokens_out: 10, client_status: 200, attempts: [{ kind: 'ok', status: 200 }] }),
];
const text = records.join('\n') + '\n';
const DAY_CSV = HEADER
  + '2026-01-02T00:00:00.000Z,2,1,1,1,200,160,20.00\n'
  + '2026-01-03T00:00:00.000Z,1,0,0,0,0,0,\n'
  + '2026-01-04T00:00:00.000Z,1,1,0,0,30,10,66.67\n';

function cli(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-report-csv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = { stdout: '', stderr: '' };
  const io: CliIO = { stdout: (s) => { out.stdout += s; }, stderr: (s) => { out.stderr += s; }, env: {}, cwd: dir, onSignal: () => {} };
  const run = async (file: string, body: string, args: string[]) => {
    writeFileSync(join(dir, file), body); out.stdout = ''; out.stderr = '';
    return main(['report', file, ...args], io);
  };
  return { out, run };
}

test('renderTimelineCsv prints a day timeline with an empty reduction for zero eligible input', () => {
  assert.equal(renderTimelineCsv(report(text, { by: 'day' })), DAY_CSV);
});

test('renderTimelineCsv prints an hour timeline, and only the header without a timeline', () => {
  assert.equal(renderTimelineCsv(report(records.slice(0, 2).join('\n') + '\n', { by: 'hour' })), HEADER
    + '2026-01-02T03:00:00.000Z,1,1,1,0,100,60,40.00\n'
    + '2026-01-02T05:00:00.000Z,1,0,0,1,100,100,0.00\n');
  assert.equal(renderTimelineCsv(report(text)), HEADER);
});

test('report --csv prints exactly the CSV and keeps the exit code rule', async (t) => {
  const { out, run } = cli(t);
  assert.equal(await run('stats.jsonl', text, ['--by', 'day', '--csv']), 0);
  assert.equal(out.stdout, DAY_CSV);
  assert.doesNotMatch(out.stdout, /Coverage:|Timeline|\|/);
  assert.equal(await run('bad.jsonl', '{broken\n' + text, ['--by', 'day', '--csv']), 1);
  assert.equal(out.stdout, DAY_CSV);
  assert.equal(await run('empty.jsonl', '', ['--by', 'hour', '--csv']), 0);
  assert.equal(out.stdout, HEADER);
});

test('report --csv needs --by and cannot be combined with --json', async (t) => {
  const { out, run } = cli(t);
  assert.equal(await run('stats.jsonl', text, ['--csv']), 2);
  assert.match(out.stderr, /^kitzur: --csv needs --by hour\|day\n/);
  assert.equal(out.stdout, '');
  assert.equal(await run('stats.jsonl', text, ['--by', 'day', '--csv', '--json']), 2);
  assert.match(out.stderr, /^kitzur: --csv and --json cannot be used together\n/);
  assert.equal(out.stdout, '');
});
