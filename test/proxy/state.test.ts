import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import {
  PlanLog, StateStore, defaultStateDir, freshLearnedEntry, keyMatches, learnedKey, planningChanged, readLearnedState, resetState, showState, writeFileAtomic,
} from '../../src/proxy/state.js';
import { applyAcceptedRatio, ceil1pct, correctionFor, judgeSample, p90, EndpointCalibrator } from '../../src/proxy/calibration.js';
import type { LearnedEntry, Plan } from '../../src/types.js';
import type { RemoteTokenizer } from '../../src/tokenize/remote.js';
import { createProfile } from '../../src/tokenize/template.js';
import { testConfig, sleep } from './harness.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'kitzur-state-'));
const NOW = new Date('2026-09-28T12:00:00Z');

test('state dir default and keys', () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: '/x/state' }, '/users/example'), '/x/state/kitzur');
  assert.equal(defaultStateDir({}, '/users/example'), '/users/example/.local/state/kitzur');
  assert.equal(defaultStateDir({ XDG_STATE_HOME: 'relative' }, '/users/example'), '/users/example/.local/state/kitzur', 'XDG paths must be absolute');
  assert.equal(learnedKey('http://gw:8000', 'qwen'), 'http://gw:8000|qwen');
  assert.equal(learnedKey('http://gw:8000', undefined), 'http://gw:8000|');
  assert.ok(keyMatches('http://gw:8000|qwen', 'qwen'));
  assert.ok(keyMatches('http://gw:8000|qwen', 'http://gw:8000'));
  assert.ok(keyMatches('http://gw:8000|qwen', 'http://gw:8000|qwen'));
  assert.ok(!keyMatches('http://gw:8000|qwen', 'qwen-small'));
});

test('a planning change is on disk before set() returns; sample-only changes are debounced', async () => {
  const dir = tmp();
  const s = new StateStore({ dir, configuredWindow: 100_000, counterId: 'c1', debounceMs: 30, now: () => NOW });
  const key = learnedKey('http://gw', 'm');
  const e = { ...s.entry(key), window: 89_000 };
  s.set(key, e);
  const disk = readLearnedState(join(dir, 'learned.json'));
  assert.equal(disk.state.entries[key]?.window, 89_000, 'written synchronously');
  // a sample-only change: not yet on disk, then flushed by the debounce
  s.set(key, { ...s.entry(key), samples: 3, ratios: [1, 1, 1] });
  assert.equal(readLearnedState(join(dir, 'learned.json')).state.entries[key]?.samples, 0);
  await sleep(80);
  assert.equal(readLearnedState(join(dir, 'learned.json')).state.entries[key]?.samples, 3);
  // no temp files left behind
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  s.close();
});

test('entries learned under another window or counter are discarded at load ()', () => {
  const dir = tmp();
  const mk = (w: number, c: string): LearnedEntry => ({ ...freshLearnedEntry(w, c), window: 50_000, tighten: 512 });
  writeFileSync(join(dir, 'learned.json'), JSON.stringify({ version: 2, entries: { 'o|a': mk(100_000, 'c1'), 'o|b': mk(64_000, 'c1'), 'o|c': mk(100_000, 'c2') } }));
  const s = new StateStore({ dir, configuredWindow: 100_000, counterId: 'c1' });
  assert.deepEqual(Object.keys(s.entries()), ['o|a']);
  assert.deepEqual(s.discarded.sort(), ['o|b', 'o|c']);
  assert.equal(s.entry('o|b').window, null, 'a discarded key starts fresh');
  assert.equal(s.entry('o|a').tighten, 512);
});

test('corrupt or foreign files do not stop the proxy; entries are sanitized', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'learned.json'), '{not json');
  const s = new StateStore({ dir, configuredWindow: 100_000, counterId: 'c1' });
  assert.match(s.lastError ?? '', /learned\.json/);
  assert.equal(s.entry('x').correction, 1);
  writeFileSync(join(dir, 'learned.json'), JSON.stringify({ version: 2, entries: { k: { configuredWindow: 100_000, counterId: 'c1', tighten: 'x', ratios: [1, 'a', 2] } } }));
  const s2 = new StateStore({ dir, configuredWindow: 100_000, counterId: 'c1' });
  const e = s2.entry('k');
  assert.deepEqual([e.tighten, e.ratios, e.window, e.correction], [0, [1, 2], null, 1]);
});

test('state show / reset with key filters', () => {
  const dir = tmp();
  const s = new StateStore({ dir, configuredWindow: 100_000, counterId: 'c1' });
  s.set('http://a|m1', { ...s.entry('http://a|m1'), tighten: 256 });
  s.set('http://a|m2', { ...s.entry('http://a|m2'), tighten: 512 });
  s.set('http://b|m1', { ...s.entry('http://b|m1'), window: 90_000 });
  assert.deepEqual(Object.keys(showState(dir, 'm1').state.entries).sort(), ['http://a|m1', 'http://b|m1']);
  assert.deepEqual(resetState(dir, 'http://a').sort(), ['http://a|m1', 'http://a|m2']);
  assert.deepEqual(Object.keys(showState(dir).state.entries), ['http://b|m1']);
  assert.deepEqual(s.reset(), ['http://a|m1', 'http://a|m2', 'http://b|m1']);
  assert.deepEqual(readLearnedState(join(dir, 'learned.json')).state.entries, {});
});

test('memory-only store and atomic writes into missing directories', () => {
  const s = new StateStore({ dir: null, configuredWindow: 100_000, counterId: 'c' });
  s.set('k', { ...s.entry('k'), window: 80_000 });
  assert.equal(s.entry('k').window, 80_000);
  assert.equal(s.path, null);
  const deep = join(tmp(), 'a', 'b', 'c', 'f.json');
  writeFileAtomic(deep, 'x');
  assert.equal(readFileSync(deep, 'utf8'), 'x');
});

test('planningChanged covers the planning inputs and includeUsageRejected', () => {
  const e = freshLearnedEntry(100_000, 'c');
  assert.equal(planningChanged(e, { ...e, samples: 9, ratios: [1] }), false);
  for (const k of ['window', 'maxPrompt', 'maxBodyBytes'] as const) assert.equal(planningChanged(e, { ...e, [k]: 5 }), true, k);
  assert.equal(planningChanged(e, { ...e, tighten: 256 }), true);
  assert.equal(planningChanged(e, { ...e, correction: 1.02 }), true);
  assert.equal(planningChanged(e, { ...e, includeUsageRejected: true }), true);
  assert.equal(planningChanged(undefined, e), false);
});

test('plan log: append-only JSONL per day, torn lines skipped', () => {
  const dir = tmp();
  const log = new PlanLog(dir, () => NOW);
  const plan = { version: 2, engine: 'x', n: 3, hEnd: 1, cut: 1, summary: null, headRewrites: {}, rewrites: {}, compactions: 0, fit: 'ok', key: 'k1' } as Plan;
  log.append('k1', plan);
  log.append('k2', { ...plan, key: 'k2' });
  writeFileSync(join(dir, 'plans', '2026-09-28.jsonl'), readFileSync(join(dir, 'plans', '2026-09-28.jsonl'), 'utf8') + '{"key":"k3","pl');
  assert.deepEqual([...log.load()].map(([k]) => k), ['k1', 'k2']);
  assert.ok(existsSync(join(dir, 'plans', '2026-09-28.jsonl')));
});

// ---------------------------------------------------------------- calibration ()

test('ceil_1% and p90', () => {
  assert.equal(ceil1pct(1.02), 1.02);
  assert.equal(ceil1pct(1.0201), 1.03);
  assert.equal(ceil1pct(1), 1);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5]), 5);
});

test('sample filter: completion, finish reason, size, band; silent_truncate warning', () => {
  const cfg = testConfig();
  const base = { cfg, mode: 'exact' as const, budget: 67_000, counted: 50_000, reported: 50_500, source: 'usage' as const, complete: true, finishReason: 'stop', sameAttempt: true };
  assert.equal(judgeSample(base).verdict, 'accepted');
  assert.equal(judgeSample({ ...base, complete: false }).verdict, 'filtered');
  assert.equal(judgeSample({ ...base, finishReason: 'content_filter' }).verdict, 'filtered');
  assert.equal(judgeSample({ ...base, sameAttempt: false }).verdict, 'filtered');
  assert.equal(judgeSample({ ...base, counted: 6000, reported: 6060 }).verdict, 'filtered', 'below 0.1 · budget');
  assert.equal(judgeSample({ ...base, reported: 60_000 }).verdict, 'mismatch');
  assert.equal(judgeSample({ ...base, mode: 'estimate', reported: 100_000 }).verdict, 'accepted');
  assert.equal(judgeSample({ ...base, mode: 'estimate', reported: 130_000 }).verdict, 'mismatch');
  assert.equal(judgeSample({ ...base, source: 'endpoint', complete: false, finishReason: null }).verdict, 'accepted', 'endpoint counts need no stream');
  assert.match(judgeSample({ ...base, reported: 43_000, silentTruncate: true }).warning ?? '', /server truncates/);
  assert.equal(judgeSample({ ...base, cfg: testConfig({ calibration: { enabled: false } }) }).verdict, 'filtered');
});

test('correction: ceil_1% of p90, capped, from minSamples on, ≥ 2 quanta hysteresis, upward only', () => {
  const cfg = testConfig({ calibration: { minSamples: 3 } });
  let e = freshLearnedEntry(100_000, 'c');
  const add = (r: number) => {
    const a = applyAcceptedRatio(e, r, cfg, 'exact', NOW);
    e = a.entry;
    return a.correctionChanged;
  };
  assert.equal(add(1.03), false);
  assert.equal(add(1.03), false, 'below minSamples');
  assert.equal(add(1.03), true);
  assert.equal(e.correction, 1.03);
  assert.equal(add(1.04), false, 'one quantum: hysteresis');
  assert.equal(e.correction, 1.03);
  assert.equal(add(1.1), true);
  assert.equal(e.correction, 1.05, 'capped at maxCorrection.exact');
  for (let i = 0; i < 70; i++) add(0.97);
  assert.equal(e.correction, 1.05, 'upwardOnly never decreases');
  assert.equal(e.ratios.length, 64, 'running window of 64');
  assert.equal(e.samples, 75);
  // without upwardOnly it may come down, still by ≥ 2 quanta and never below 1
  const cfg2 = testConfig({ calibration: { minSamples: 1, upwardOnly: false } });
  const d = applyAcceptedRatio({ ...freshLearnedEntry(100_000, 'c'), correction: 1.05, ratios: Array(63).fill(0.9) }, 0.9, cfg2, 'exact', NOW);
  assert.deepEqual([d.correctionChanged, d.entry.correction], [true, 1]);
  assert.equal(correctionFor([1.3, 1.4], DEFAULT_CONFIG, 'estimate'), 1.4);
});

test('the tokenize endpoint calibrator: one in flight, skipped while down or busy', async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const remote: RemoteTokenizer = {
    style: 'vllm', url: 'http://x/tokenize',
    count: (text: string) => new Promise((r) => { calls++; release = () => r(text.length); }),
    stats: () => ({ requests: calls, ok: 0, failed: 0, skipped: 0, lastError: null }),
    down: () => false,
    close: () => undefined,
  };
  const cal = new EndpointCalibrator(remote, createProfile('chatml'));
  const req = { model: 'm', messages: [{ role: 'user', content: 'hello' }] };
  const p1 = cal.count(req);
  assert.equal(await cal.count(req), null, 'busy: skipped');
  (release as unknown as () => void)();
  const n = await p1;
  assert.ok(typeof n === 'number' && n > 5);
  assert.equal(calls, 1);
  assert.equal(cal.skipped, 1);
});
