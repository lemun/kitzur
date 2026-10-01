// The matrix (cells, tiers, runKey, the system hook) and the pool (isolation, the worker-side cell runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystem, globToRegExp, gobTunedArgs, matrix, registerSystem, runKey, systemIds, type Cell } from '../../bench/matrix.js';
import { isolatedEnv, notRunResults, runCell, runPool, versionsNow, type Job } from '../../bench/pool.js';
import { cellOf, deterministic, diffJson, pickCells } from '../../bench/verify.js';
import { WINDOWS } from '../../bench/scenarios/windows.js';
import type { ResultsFile } from '../../bench/metrics/results.js';
import { testTokenizerPath } from '../helpers.js';

const base = { codeVersion: 'code-v1', tokenizerSha: 'tok-v1' };
const find = (cs: Cell[], sys: string, sc: string, w: string): Cell | undefined => cs.find((c) => c.system === sys && c.scenario === sc && c.window === w);

test('matrix T1: windows per family and system (benchmark contract §13)', () => {
  const cs = matrix({ ...base, tiers: ['T1'] });
  for (const w of ['100k', '64k', '32k', '128k']) assert.ok(find(cs, 'gobstopper-tuned', 'qa46-ref', w), `gob tuned qa46-ref @${w}`);
  assert.ok(find(cs, 'gobstopper-default', 'qa46-ref', '100k'));
  assert.equal(find(cs, 'gobstopper-default', 'qa46-ref', '32k'), undefined, 'defaults run at 100k only');
  assert.ok(find(cs, 'gobstopper-tuned', 'err-vllm-018', '32k') && find(cs, 'gobstopper-tuned', 'err-gateway502', '64k'));
  assert.equal(find(cs, 'gobstopper-tuned', 'err-sglang', '32k'), undefined, 'only the G8 styles at 32k/64k');
  assert.equal(find(cs, 'gobstopper-tuned', 'huge180k', '128k'), undefined, '128k is F1/F2 only');
  assert.ok(find(cs, 'gobstopper-tuned', 'talk80', '128k'));
  assert.ok(find(cs, 'direct', 'imp-tools', '32k'));
  assert.equal(find(cs, 'direct', 'imp-tools', '100k'), undefined, 'F14 fixed-prompt cells are defined at 32k');
  assert.ok(find(cs, 'direct', 'code60', '100k') && !find(cs, 'direct', 'code60', '32k'));
  // structurally inapplicable cells are not listed (the offline simulator replays only the reference scenario; the
  // OpenCode client has no per-step restart hook); restartable systems get F13
  assert.equal(find(cs, 'opencode-sim', 'qa46', '100k'), undefined);
  assert.equal(find(cs, 'opencode-sim', 'qa46-ref', '100k')!.skip, null);
  assert.equal(find(cs, 'opencode', 'rs46-sigterm', '100k'), undefined);
  assert.equal(find(cs, 'gobstopper-tuned', 'rs46-sigterm', '100k')!.skip, null);
  assert.equal(find(cs, 'kitzur', 'rs46-sigkill', '32k')!.skip, null);
  // the OpenCode client runs behind proxies now (it saves its request bodies)
  assert.equal(find(cs, 'kitzur', 'cc60-oc', '100k')!.skip, null);
  assert.equal(find(cs, 'opencode-kitzur', 'qa46-ref', '64k')!.skip, null);
  for (const c of cs) assert.equal(c.tier, 'T1');
});

test('kitzur systems: config per window (preset, template per mock render, ablation overrides), T2 ablations, T3 sweep', async () => {
  const { kitzurConfig, kitzurTemplate, ABLATIONS, KITZUR_DEFAULT, SWEEP } = await import('../../bench/matrix.js');
  const { buildScenario } = await import('../../bench/scenarios/index.js');
  assert.deepEqual(getSystem('kitzur').config(WINDOWS['64k']), { system: 'kitzur', preset: '64k', template: 'match', set: {}, tokenizer: 'bench' });
  const clamp = ABLATIONS.find((a) => a.id === 'kitzur-clamp')!;
  assert.deepEqual(kitzurConfig(clamp, WINDOWS['32k'])['set'], { 'budget.maxTokensClamp.enabled': true, 'client.compactionPointTokens': 32_000 });
  const mm = ABLATIONS.find((a) => a.id === 'kitzur-template-mismatch')!;
  assert.equal(kitzurTemplate(KITZUR_DEFAULT, buildScenario('qa46-ref')), 'sim');
  assert.equal(kitzurTemplate(KITZUR_DEFAULT, buildScenario('rs46')), 'qwen3', 'rs46 renders qwen3');
  assert.equal(kitzurTemplate(mm, buildScenario('qa46-ref')), 'qwen3');
  assert.equal(kitzurTemplate(mm, buildScenario('rs46')), 'sim');
  const t2 = matrix({ ...base, tiers: ['T2'] });
  for (const a of ABLATIONS) {
    const mine = t2.filter((c) => c.system === a.id);
    assert.equal(mine.length, a.id === 'kitzur-reasoning-drop' ? 2 : 8, a.id);
  }
  const t3 = matrix({ ...base, tiers: ['T3'] });
  assert.equal(t3.length, SWEEP.triggerFraction.length * SWEEP.targetFraction.length * SWEEP.summaryFraction.length);
  assert.ok(t3.every((c) => c.scenario === 'qa46' && c.window === '100k' && c.skip === null));
  const keys = new Set([...t2, ...t3].map((c) => c.runKey));
  assert.equal(keys.size, t2.length + t3.length, 'distinct runKeys');
});

test('runKey = sha256(system cfg, scenario, window, code version, tokenizer sha)', () => {
  const g = getSystem('gobstopper-tuned');
  const k = runKey(g, 'qa46-ref', WINDOWS['100k'], 'c', 't');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, runKey(g, 'qa46-ref', WINDOWS['100k'], 'c', 't'));
  assert.notEqual(k, runKey(g, 'qa46-ref', WINDOWS['32k'], 'c', 't'), 'the window (and the per-window threshold)');
  assert.notEqual(k, runKey(g, 'qa46', WINDOWS['100k'], 'c', 't'));
  assert.notEqual(k, runKey(g, 'qa46-ref', WINDOWS['100k'], 'c2', 't'));
  assert.notEqual(k, runKey(g, 'qa46-ref', WINDOWS['100k'], 'c', 't2'));
  assert.notEqual(k, runKey(getSystem('gobstopper-default'), 'qa46-ref', WINDOWS['100k'], 'c', 't'));
  assert.deepEqual(gobTunedArgs(WINDOWS['32k']), ['--threshold', '20500', '--keep-recent', '2', '--carry-max-chars', '40000']);
  const cs = matrix({ ...base, tiers: ['T1'], only: 'gobstopper-tuned/qa46*/100k' });
  assert.deepEqual(cs.map((c) => c.scenario).sort(), ['qa46', 'qa46-ref', 'qa46-ref-qwen3']);
  assert.ok(globToRegExp('a*/b?').test('axx/bc'));
});

test('the typed system hook: a later wave registers kitzur (and ablations) and gets T1 / T2 cells', () => {
  registerSystem({
    id: 'kitzur-test', label: 'kitzur (test hook)', kind: 'http', client: 'scenario', allWindows: true,
    config: (w) => ({ system: 'kitzur', preset: w.id }), supports: () => null, create: () => null,
  });
  registerSystem({
    id: 'kitzur-test-ledger-off', label: 'ledger off', kind: 'http', client: 'scenario', allWindows: true, ablationOf: 'kitzur-test',
    config: (w) => ({ system: 'kitzur', preset: w.id, ledger: false }), supports: () => null, create: () => null,
  });
  assert.ok(systemIds().includes('kitzur-test'));
  assert.throws(() => registerSystem({ ...getSystem('kitzur-test') }), /already registered/);
  const t1 = matrix({ ...base, tiers: ['T1'], systems: ['kitzur-test'] });
  assert.ok(find(t1, 'kitzur-test', 'rs46-sigterm', '32k'));
  const t2 = matrix({ ...base, tiers: ['T2'], systems: ['kitzur-test-ledger-off'] });
  assert.deepEqual([...new Set(t2.map((c) => `${c.scenario}@${c.window}`))].sort(), [
    'huge180k@100k', 'huge180k@32k', 'qa46-ref@100k', 'qa46-ref@32k', 'rs46@100k', 'rs46@32k', 'talk80@100k', 'talk80@32k',
  ]);
});

test('run isolation (benchmark contract ): no KITZUR_* / XDG_* inherited; HOME and XDG_* under the run', () => {
  const iso = mkdtempSync(join(tmpdir(), 'kitzur-iso-'));
  try {
    const env = isolatedEnv({ PATH: '/bin', HOME: '/users/example', KITZUR_CONFIG: 'x', KITZUR_BENCH_TOKENIZER: 'y', XDG_STATE_HOME: '/s', XDG_RUNTIME_DIR: '/r' }, iso);
    assert.equal(env['PATH'], '/bin');
    assert.equal(env['HOME'], join(iso, 'home'));
    assert.equal(env['XDG_STATE_HOME'], join(iso, 'state'));
    assert.equal(env['XDG_CONFIG_HOME'], join(iso, 'config'));
    assert.ok(!Object.keys(env).some((k) => k.startsWith('KITZUR_')));
    assert.equal(env['XDG_RUNTIME_DIR'], undefined);
    for (const d of ['home', 'state', 'config', 'cache', 'data']) assert.ok(existsSync(join(iso, d)), d);
  } finally {
    rmSync(iso, { recursive: true, force: true });
  }
});

test('verify helpers: deterministic projection, JSON diff, a re-run order different from the original', () => {
  const r = { runKey: 'k', timing: { wallMs: 1 }, versions: { node: 'a' }, metrics: { x: 1, y: [1, 2] } } as unknown as ResultsFile;
  const r2 = { ...r, timing: { wallMs: 2 }, versions: { node: 'b' } } as unknown as ResultsFile;
  assert.deepEqual(diffJson(deterministic(r), deterministic(r2)), []);
  const r3 = { ...r, metrics: { x: 2, y: [1, 3, 4] } } as unknown as ResultsFile;
  assert.deepEqual(diffJson(deterministic(r), deterministic(r3)), ['/metrics/x', '/metrics/y/length 2 != 3', '/metrics/y/1']);
  const cells = matrix({ ...base, tiers: ['T1'], systems: ['direct'], windows: ['100k'] }).filter((c) => !c.skip);
  const picked = pickCells(cells, new Set(cells.map((c) => c.runKey)), 5, 7);
  assert.equal(picked.length, 5);
  const idx = picked.map((c) => cells.indexOf(c));
  assert.ok(!idx.every((x, i) => i === 0 || idx[i - 1]! < x), 'not in matrix order');
  const c0 = cells[0]!;
  assert.deepEqual(cellOf({ system: c0.system, scenario: c0.scenario, window: c0.window, tier: c0.tier, family: c0.family, runKey: c0.runKey } as unknown as ResultsFile), c0);
});

const tok = testTokenizerPath();

function job(cell: Cell, root: string): Job {
  return {
    cell, runDir: join(root, 'run'), isoDir: join(root, 'iso'), resultsDir: join(root, 'results'), keepBodies: false,
    tokenizerPath: tok!, gobstopperBin: null, versions: versionsNow(tok, null),
  };
}

test('runCell: the offline OpenCode simulator reproduces baseline.py (2,492,849 / 462,177 rejected / 6)', { skip: tok ? false : 'no dev tokenizer' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitzur-cell-'));
  try {
    const cell = matrix({ ...base, tiers: ['T1'], only: 'opencode-sim-compat/qa46-ref/100k' })[0]!;
    const r = await runCell(job(cell, root));
    assert.equal(r.status, 'ok');
    assert.equal(r.driver, 'offline');
    assert.equal(r.metrics!.processed, 2_492_849);
    assert.equal(r.metrics!.rejected, 462_177);
    assert.equal(r.metrics!.rejections, 6);
    assert.equal(r.metrics!.processed_aux, 36_451);
    assert.equal(r.metrics!.compactions_reported, 6);
    assert.equal(r.metrics!.hit, null, 'no bodies offline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCell: the spec driver (qa46 with O1, direct) gives complete records, facts and per-request data', { skip: tok ? false : 'no dev tokenizer' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitzur-cell-'));
  try {
    const cell = matrix({ ...base, tiers: ['T1'], only: 'direct/qa46/32k' })[0]!;
    const r = await runCell(job(cell, root));
    assert.equal(r.status, 'ok', r.reason ?? '');
    assert.equal(r.driver, 'spec');
    const m = r.metrics!;
    assert.ok(m.steps_ok < m.steps, 'direct overflows at 32k/8k');
    assert.equal(m.client_errors, 1);
    assert.equal(m.rejections, 1);
    assert.equal(m.compactions_generic, 0);
    assert.equal(m.pairing_errors, 0);
    assert.equal(m.hit! > 0.5, true);
    assert.equal(m.L, 0, 'direct: every uncached token is a first send');
    assert.equal(r.perRequest.length, m.upstream_requests);
    assert.ok(r.perRequest.every((p) => /^[0-9a-f]{32}$/.test(p.msgsDigest)));
    assert.ok(r.facts!.find((f) => f.id === 'goal')!.status === 'pass');
    assert.ok(!existsSync(join(root, 'run', 'reqs')), 'bodies are dropped unless keepBodies');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPool: one forked, isolated worker per cell writes <runKey>.json; resume reuses it', { skip: tok ? false : 'no dev tokenizer' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitzur-pool-'));
  try {
    const cells = matrix({ ...base, tiers: ['T1'], only: 'direct/qa46-ref/32k' });
    const skip = { ...matrix({ ...base, tiers: ['T1'], only: 'opencode-sim/qa46-ref/100k' })[0]!, skip: 'the offline OpenCode simulator only replays the reference scenario' };
    const out = await runPool([...cells, skip], { workers: 2, resultsDir: join(root, 'results'), rawDir: join(root, 'raw'), log: () => {} });
    assert.deepEqual(out.map((o) => o.status).sort(), ['not-run', 'ok']);
    const r = JSON.parse(readFileSync(join(root, 'results', `${cells[0]!.runKey}.json`), 'utf8')) as ResultsFile;
    assert.equal(r.status, 'ok');
    assert.equal(r.driver, 'reference');
    assert.equal(r.window, '32k');
    assert.ok(r.metrics!.failed_at !== null);
    const nr = JSON.parse(readFileSync(join(root, 'results', `${skip.runKey}.json`), 'utf8')) as ResultsFile;
    assert.equal(nr.status, 'not-run');
    assert.match(nr.reason!, /reference scenario/);
    const again = await runPool(cells, { workers: 1, resultsDir: join(root, 'results'), rawDir: join(root, 'raw'), resume: true, log: () => {} });
    assert.deepEqual(again.map((o) => o.status), ['cached']);
    assert.equal(notRunResults(cells[0]!, r.versions, 'why').reason, 'why');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
