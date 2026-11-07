import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUptime, formatStatus } from '../../src/cli/format.js';
import { unreachableHint } from '../../src/cli/commands/status.js';
import { StatusTracker } from '../../src/proxy/status.js';
import { testConfig } from '../proxy/harness.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const profile = (W: number) => ({ W, T_plan: 1024, hard: W - 2000, trigger: W - 4000, counter_mode: 'estimate' });

const full = {
  name: 'kitzur', version: '1.2.3', uptime_s: 8040,
  paths: { config: '/etc/kitzur/kitzur.jsonc', state_dir: '/var/lib/kitzur', log_file: '/var/log/kitzur.log' },
  config: { upstream: 'https://user:SECRET_PW@gw.example.com' },
  warnings: [{ key: 'output_allowance', message: 'Upstream p99 completion_tokens 9000 exceeds allowance 7000', count: 3, last: '2026-01-01T11:00:00.000Z' }],
  budget: { window: 32768, budget: 30000, trigger: 24000, target: 12000 },
  profiles: { 'big-model': profile(131072), 'small-model': profile(8192) },
  counters: { chat_requests: 12 },
  actions: { compact: 2, passthrough: 10 },
  outcomes: { ok: 10, aborted: 1, incomplete: 0, upstream_error: 1, refused: 0 },
  last_compaction: { at: '2026-01-01T11:55:00.000Z', in: 26000, out: 9000, trigger: 24000 },
  stats: { path: null, error: null, dropped: 4, write_failures: 0 },
  recent_requests: [{ action: 'compact', tokens: { in: 26000, out: 9000, trigger: 24000 }, model: 'big-model', ms: 812 }],
};

const groups = (out: string) => out.split('\n\n').map((g) => g.split('\n')[0]!.split(':')[0]);

test('formatStatus prints the groups in order, separated by blank lines', () => {
  const out = formatStatus(full, NOW);
  assert.deepEqual(groups(out), ['kitzur 1.2.3 — uptime 2h 14m', 'Warnings', 'Budget', 'Chat requests', 'Stats writer', 'Recent requests']);
  assert.match(out, /^ {2}output_allowance: Upstream p99 completion_tokens 9000 exceeds allowance 7000 \(x3\)$/m);
  assert.match(out, /^Budget: window 32768; budget 30000; trigger 24000; target 12000$/m);
  assert.match(out, /^ {2}"big-model": window 131072; trigger 127072; counter estimate$/m);
  assert.match(out, /^Chat requests: 12; actions: compact=2, passthrough=10$/m);
  assert.match(out, /^Outcomes: ok=10, aborted=1, incomplete=0, upstream_error=1, refused=0$/m);
  assert.match(out, /^Last compaction: 2026-01-01T11:55:00.000Z \(5m 0s ago\) — 26000 -> 9000 tokens \(trigger 24000\)$/m);
  assert.match(out, /^Stats writer: dropped 4$/m);
  assert.match(out, /^ {2}compact 26000 -> 9000 tokens; model="big-model"; 812ms$/m);
});

test('formatStatus: a minimal or empty body prints no undefined or NaN', () => {
  for (const s of [{}, { name: 'kitzur', uptime_s: 3 }, { budget: {}, counters: {}, stats: {}, warnings: [], profiles: {}, last_compaction: {}, recent_requests: [{}] }]) {
    const out = formatStatus(s, NOW);
    assert.doesNotMatch(out, /undefined|NaN|\[object/, out);
    assert.match(out, /^Warnings: none$/m);
    assert.match(out, /^Paths: /m);
    assert.doesNotMatch(out, /Stats writer|Outcomes/);
  }
  assert.match(formatStatus({ name: 'kitzur', uptime_s: 3 }, NOW), /^kitzur — uptime 3s$/m);
  assert.match(formatStatus({}, NOW), /^Budget: unknown$/m);
});

test('formatStatus caps the per-model lines at 8', () => {
  const profiles = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`m${i}`, profile(8192)]));
  const out = formatStatus({ ...full, profiles }, NOW);
  assert.equal(out.split('\n').filter((l) => /^ {2}"m\d+"/.test(l)).length, 8);
  assert.match(out, /^ {2}\+3 more$/m);
});

test('formatStatus flattens a multi-line warning to one line', () => {
  const out = formatStatus({ warnings: [{ key: 'x\ny', message: 'first\nsecond\r\n\tthird fourth' }] }, NOW);
  assert.match(out, /^ {2}x y: first second third fourth$/m);
});

test('formatStatus of a real snapshot shows no secrets or request content', () => {
  const cfg = testConfig({ upstream: { origin: 'https://user:SECRET_PW@gw.example.com', headers: { authorization: 'Bearer SECRET_HDR' } }, listen: { token: 'SECRET_TOKEN' } });
  const tracker = new StatusTracker(cfg, 'test', () => NOW);
  tracker.recordRequest({ action: 'compact', tokens: { in: 100, out: 20, trigger: 80 }, model: 'example-model', ms: 5 });
  tracker.forwardedPrompt('example-model', 's', 50);
  tracker.clientRequest({ model: 'example-model', messages: [{ role: 'user', content: 'SECRET_PROMPT' }] }, 's', 80);
  const s = JSON.parse(JSON.stringify(tracker.snapshot({ counter: { mode: 'estimate', id: 'test' }, learned: {}, statsDropped: 1 })));
  const out = formatStatus(s, NOW);
  assert.doesNotMatch(out, /SECRET|undefined|NaN/);
  assert.match(out, /^ {2}compact 100 -> 20 tokens; model="example-model"; 5ms$/m);
  assert.doesNotMatch(formatStatus(full, NOW), /SECRET/);
});

test('fmtUptime and the unreachable hint', () => {
  assert.deepEqual([0, 59, 61, 8040, 90000].map(fmtUptime), ['0s', '59s', '1m 1s', '2h 14m', '1d 1h']);
  assert.equal(unreachableHint('http://127.0.0.1:8080/status', '/home/user/kitzur.jsonc'),
    'kitzur: nothing answered at 127.0.0.1:8080; is it running? start it with: kitzur serve --config /home/user/kitzur.jsonc (or kitzur autostart status on Windows)');
  assert.match(unreachableHint('not a url', null), /at not a url; .*--config <path> /);
});
