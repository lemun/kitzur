// The stable keys of each --json output, as documented in docs/JSON-OUTPUT.md. Offline: a temp config,
// a temp state dir, and for status a local stub listener serving a StatusTracker snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { StatusTracker } from '../../src/proxy/status.js';
import { testConfig } from '../proxy/harness.js';
import { ROOT } from '../helpers.js';

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

async function withTmp(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-json-'));
  try {
    writeFileSync(join(dir, 'kitzur.json'), JSON.stringify({ upstream: { origin: 'https://llm.example.com' } }));
    await f(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'string|null';
const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Parses stdout as one JSON document and checks each stable key's type. */
function contract(out: string, keys: Record<string, Kind>, label: string): Record<string, unknown> {
  const o = JSON.parse(out) as Record<string, unknown>;
  for (const [k, t] of Object.entries(keys)) {
    assert.ok(Object.hasOwn(o, k), `${label}: missing ${k}`);
    assert.ok(t.split('|').includes(kind(o[k])), `${label}: ${k} is ${kind(o[k])}, documented ${t}`);
  }
  return o;
}

const doc = readFileSync(join(ROOT, 'docs/JSON-OUTPUT.md'), 'utf8');
/** The documented stable keys of one command: rows `| \`key\` | type | stable |` under its heading. */
function documented(heading: string): Record<string, Kind> {
  const section = doc.split(/^## /m).find((s) => s.startsWith(`\`${heading}\``));
  assert.ok(section, `docs/JSON-OUTPUT.md has no section for ${heading}`);
  const rows = [...section.matchAll(/^\| `([^`]+)` \| ([a-z|]+) \| stable \|/gm)];
  assert.ok(rows.length, `${heading}: no stable keys documented`);
  return Object.fromEntries(rows.map(([, k, t]) => [k, t as Kind]));
}

test('count --json keeps its documented keys', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
    const r = await run(['count', 'r.json', '--estimate', '--json', '--config', 'kitzur.json', '--state-dir', dir], dir);
    assert.equal(r.code, 0, r.err);
    const o = contract(r.out, documented('kitzur count --json'), 'count');
    assert.deepEqual(Object.keys((o['perMessage'] as object[])[0]!).sort(), ['i', 'role', 'tokens']);
  }));

test('doctor --json keeps its documented keys, also when the config cannot load', () =>
  withTmp(async (dir) => {
    const keys = documented('kitzur doctor --json');
    for (const config of ['kitzur.json', 'missing.json']) {
      const r = await run(['doctor', '--json', '--config', config, '--state-dir', dir], dir);
      const o = contract(r.out, keys, `doctor ${config}`);
      assert.equal(o['exitCode'], r.code);
      for (const c of o['checks'] as Array<Record<string, unknown>>) {
        assert.equal(typeof c['code'], 'string');
        assert.ok(['ok', 'warn', 'error'].includes(c['status'] as string));
        assert.equal(typeof c['message'], 'string');
      }
    }
  }));

test('config validate --json and config show --json keep their documented keys', () =>
  withTmp(async (dir) => {
    const v = await run(['config', 'validate', '--json', '--config', 'kitzur.json'], dir);
    assert.equal(contract(v.out, documented('kitzur config validate --json'), 'validate')['ok'], v.code === 0);
    const missing = await run(['config', 'validate', '--json', '--config', 'missing.json'], dir);
    assert.equal(missing.code, 2);
    assert.equal(contract(missing.out, documented('kitzur config validate --json'), 'validate (unloadable)')['ok'], false);
    const s = await run(['config', 'show', '--json', '--config', 'kitzur.json'], dir);
    contract(s.out, documented('kitzur config show --json'), 'show');
  }));

test('state show --json keeps its documented keys with and without a learned.json', () =>
  withTmp(async (dir) => {
    const keys = documented('kitzur state show --json');
    const empty = await run(['state', 'show', '--json', '--config', 'kitzur.json', '--state-dir', dir], dir);
    assert.equal(empty.code, 0, empty.err);
    assert.deepEqual(contract(empty.out, keys, 'state show').entries, {});
    writeFileSync(join(dir, 'learned.json'), '{not json');
    const bad = await run(['state', 'show', '--json', '--config', 'kitzur.json', '--state-dir', dir], dir);
    assert.equal(bad.code, 1);
    contract(bad.out, keys, 'state show (unreadable)');
  }));

test('status --json reprints the /status body with its documented keys; an unreachable URL prints nothing on stdout', () =>
  withTmp(async (dir) => {
    const tracker = new StatusTracker(testConfig(), 'test');
    tracker.paths = () => ({ config: null, state_dir: dir, log_file: null });
    const body = JSON.stringify(tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {} }));
    const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`;
      const r = await run(['status', '--url', url, '--json'], dir);
      assert.equal(r.code, 0, r.err);
      contract(r.out, documented('kitzur status --json'), 'status');
    } finally { await new Promise((ok) => server.close(ok)); }
    const down = await run(['status', '--url', 'http://127.0.0.1:1/status', '--json', '--timeout-ms', '500'], dir);
    assert.equal(down.code, 1);
    assert.equal(down.out, '');
    assert.match(down.err, /^kitzur: cannot reach /);
  }));

test('tls-probe --json reports a failure as {"error"} on stdout', () =>
  withTmp(async (dir) => {
    const r = await run(['tls-probe', 'https://127.0.0.1:1', '--json', '--timeout-ms', '500', '--config', 'kitzur.json'], dir);
    assert.equal(r.code, 1);
    contract(r.out, { error: 'string' }, 'tls-probe');
    assert.ok(doc.includes('`{"error": "..."}`'));
  }));

test('report --json keeps its documented keys; --by day adds a timeline', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'stats.jsonl'), [
      { seq: 1, ts: '2026-01-02T03:04:05Z', action: 'compact', compacted: true, tokens_in: 100, tokens_out: 60, client_status: 200, attempts: [{ kind: 'ok', status: 200 }] },
      { seq: 2, ts: '2026-01-03T00:30:00Z', action: 'passthrough', tokens_in: 40, tokens_out: 40, client_status: 200 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = await run(['report', 'stats.jsonl', '--json'], dir);
    assert.equal(r.code, 0, r.err);
    const o = contract(r.out, documented('kitzur report --json'), 'report');
    assert.ok(!Object.hasOwn(o, 'timeline'));
    const by = await run(['report', 'stats.jsonl', '--json', '--by', 'day'], dir);
    assert.equal(by.code, 0, by.err);
    const timeline = contract(by.out, { timeline: 'array' }, 'report --by day')['timeline'] as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(timeline[0]!).sort(), ['compactions', 'failures', 'forwarded', 'input', 'reductionPercent', 'requests', 'retries', 'start']);
  }));
