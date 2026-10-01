// The run pool (bench/README.md§12, §13): every matrix cell runs in its own forked worker process (N = 3 by
// default on the 4-core box, the 4th core left to gobstopper / the proxy children / the mock), isolated:
//   - a fresh process per run;
//   - HOME, XDG_STATE_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME under the run's isolation dir;
//   - no inherited KITZUR_* (or XDG_*) variables: the bench's own inputs (tokenizer, gobstopper binary) are resolved
//     by the parent and passed in the job message;
//   - a per-run state dir and stats path (SystemContext) for systems that keep state (kitzur, later wave).
// Results are written to <resultsDir>/<runKey>.json; `resume` reuses an existing ok/not-run file with the same runKey.
//
// Drivers of one cell (the worker side, runCell):
//   reference  byte-exact `-ref` scenarios through bench/harness.ts (the Python-parity path of the cross-check)
//   spec       every other scenario: bench/mock/server.ts in SPEC mode with the ScenarioSpec registered, and
//              bench/client/agent.ts driving the spec with strict client-visible-error detection (benchmark contract )
//   offline    bench/opencode-sim.ts (no HTTP, no bodies: prefix and fact metrics are not available)
//
//   node dist/bench/pool.js [--tier T1] [--only GLOB] [--systems a,b] [--windows 100k,32k] [--scenarios a,b]
//                           [--workers 3] [--results-dir DIR] [--raw-dir DIR] [--resume] [--keep-bodies]

import { fork, type ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonicalJSON } from '../src/tokenize/canonical.js';
import { loadTokenizer } from '../src/tokenize/tokenizer.js';
import { PromptCounter } from './lib/render.js';
import { benchTokenizerPath, gobstopperBin, RAW_RESULTS_DIR, RESULTS_DIR, ROOT } from './lib/paths.js';
import {
  codeVersion, fileSha256, getSystem, GOB_VERSION, loadSystemModules, matrix, type Cell, type MatrixOptions, type SystemContext, type Tier,
} from './matrix.js';
import { buildScenario, type ScenarioDef } from './scenarios/index.js';
import { WINDOWS, type WindowId, type WindowSpec } from './scenarios/windows.js';
import { collectRunDir, measureSim, type MessageMeasure } from './metrics/collect.js';
import { computeMetrics, RESULTS_SCHEMA, type ResultsFile, type Versions } from './metrics/results.js';
import { runTiming } from './metrics/timing.js';
import type { ClientRec, RunRecords, UpstreamRec } from './metrics/records.js';
import type { BenchSystem } from './systems/types.js';
import type { RenderBody } from './lib/render.js';

// ---------------------------------------------------------------- jobs

export interface Job {
  cell: Cell;
  runDir: string;
  isoDir: string;
  resultsDir: string;
  keepBodies: boolean;
  tokenizerPath: string;
  gobstopperBin: string | null;
  versions: Versions;
  /** mock option overrides resolved by the parent (e.g. http413's derived maxBodyBytes) */
  mockOverrides?: Record<string, unknown>;
}

export const resultsPath = (dir: string, runKey: string): string => join(dir, `${runKey}.json`);

export function configHash(cfg: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJSON(cfg)).digest('hex').slice(0, 16);
}

function baseResults(cell: Cell, versions: Versions): ResultsFile {
  const sys = getSystem(cell.system);
  const cfg = sys.config(WINDOWS[cell.window]);
  return {
    schema: RESULTS_SCHEMA, runKey: cell.runKey, status: 'not-run', reason: null, versions, system: cell.system, systemLabel: sys.label,
    scenario: cell.scenario, family: cell.family, window: cell.window, tier: cell.tier, configHash: configHash(cfg), config: cfg,
    driver: null, metrics: null, facts: null, supersession: null, gates: {}, notes: [], perRequest: [], timing: null,
  };
}

export function notRunResults(cell: Cell, versions: Versions, reason: string): ResultsFile {
  return { ...baseResults(cell, versions), status: 'not-run', reason };
}

// ---------------------------------------------------------------- worker side

function ensureIso(isoDir: string): Record<string, string> {
  const d = {
    HOME: join(isoDir, 'home'),
    XDG_STATE_HOME: join(isoDir, 'state'),
    XDG_CONFIG_HOME: join(isoDir, 'config'),
    XDG_CACHE_HOME: join(isoDir, 'cache'),
    XDG_DATA_HOME: join(isoDir, 'data'),
  };
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  return d;
}

function readJsonlFile(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The per-message measure of the mock's render. qwen3: exact segments for the LCP, per-message attribution from the
 * sim pieces (fresh is then approximate; noted in the results). */
async function measureFor(sc: ScenarioDef, counter: PromptCounter): Promise<{ measure: (b: RenderBody) => MessageMeasure; note: string | null }> {
  if ((sc.mock.render ?? 'sim') === 'sim') return { measure: (b) => measureSim(counter, b), note: null };
  const q = (await import('./mock/qwen3-render.js')) as { renderQwen3: (raw: string) => string };
  return {
    measure: (b) => {
      const sim = measureSim(counter, b);
      const segments = counter.segments(q.renderQwen3(JSON.stringify(b)));
      const total = counter.countSegments(segments);
      return { perMessage: sim.perMessage, overhead: total - sim.perMessage.reduce((x, y) => x + y, 0), total, segments };
    },
    note: 'qwen3 render: LCP/hit/uncached exact on the qwen3 render; fresh attributes tokens per message with the sim render (approximate)',
  };
}

async function runOffline(job: Job, sc: ScenarioDef, w: WindowSpec, counter: PromptCounter): Promise<ResultsFile> {
  const { runOpenCodeSim } = await import('./opencode-sim.js');
  const cfg = getSystem(job.cell.system).config(w) as { continueText: 'short' | 'long'; summaryTokens: number };
  const t0 = performance.now();
  const steps = sc.sessions[0]!.steps;
  const r = runOpenCodeSim({ counter, limit: w.W, maxOut: w.O, scenario: sc.reference ?? {}, steps, continueText: cfg.continueText, summaryTokens: cfg.summaryTokens });
  const ms = performance.now() - t0;
  // records without bodies: sizes and statuses only
  const up: UpstreamRec[] = [];
  const client: ClientRec[] = [];
  let seq = 0;
  let row = 0;
  const bare = (x: Partial<UpstreamRec>): UpstreamRec => ({
    seq: ++seq, session: 'default', step: 0, kind: 'main', status: 200, rejected: false, prompt: 0, completion: null, maxTokens: w.O,
    bytes: 0, lcp: 0, lcpGlobal: null, digests: [], msgTokens: [], overhead: 0, facts: [], pairingError: null, pairingStrict: [], ...x,
  });
  // chronological: a summarizer request follows every rejected request (overflow compaction, same step) and every
  // accepted request whose reported usage reached `usable` (proactive compaction, labelled with the next step)
  for (const q of r.requests) {
    up.push(bare({ step: q.step, status: q.accepted ? 200 : 400, rejected: !q.accepted, prompt: q.prompt }));
    const next = r.rows[row];
    if (next && ((!q.accepted && next.step === q.step) || (q.accepted && next.step === q.step + 1 && !next.reason.startsWith('provider')))) {
      up.push(bare({ step: next.step, kind: 'summarizer', prompt: next.summ_in }));
      row++;
    }
  }
  for (; row < r.rows.length; row++) up.push(bare({ step: r.rows[row]!.step, kind: 'summarizer', prompt: r.rows[row]!.summ_in }));
  for (let k = 0; k < steps; k++) {
    if (r.failedAt !== null && k > r.failedAt) break;
    const failed = r.failedAt === k;
    client.push({
      session: 'default', step: k, kind: 'main', attempt: 1, digests: [], facts: [], prompt: null, bytes: null, status: failed ? 400 : 200,
      clientErrorKind: failed ? 'http_400' : null, usage: null, maxTokens: w.O, pairingStrict: [],
    });
  }
  const rr: RunRecords = { up, client, steps: { default: steps } };
  const m = computeMetrics({ scenario: sc, window: w, rr, ledger: null, compactionsReported: r.totals.compactions });
  const metrics = {
    ...m.metrics, compactions_generic: 0, compaction_steps: [], client_compactions: r.totals.compactions, client_rewrites: r.totals.compactions,
    hit: null, lcp: null, uncached: null, fresh: null, fresh_synth: null, fresh_literal: null, L: null, reusable: null,
    hit_global: null, hit_block16: null, template_breaks: null, completion: r.totals.completion,
  };
  if (metrics.processed !== r.totals.total_prompt_tokens) throw new Error(`opencode-sim processed ${metrics.processed} != total ${r.totals.total_prompt_tokens}`);
  return {
    ...baseResults(job.cell, job.versions), status: 'ok', driver: 'offline', metrics, facts: null, supersession: null,
    gates: { G1: m.gates['G1']! },
    notes: [
      `opencode-sim (${cfg.continueText} Continue): ${r.totals.compactions} compactions, ${r.totals.overflow_errors} overflow errors, main ${r.totals.main}, rejected ${r.totals.rejected}, summarizer input ${r.totals.summ_in}`,
      'offline simulator: no request bodies, so prefix and fact metrics are not available',
    ],
    perRequest: m.perRequest,
    timing: runTiming(ms, [], null, new Date()),
  };
}

/**
 * The OpenCode / Kilo client (bench/client/opencode.ts) in front of the mock, direct or through a proxy, one session
 * after another. The client saves its own request bodies (origs/<session>_<kind>_step<N>_a<attempt>.json, the C_k of
 * benchmark contract ) and its records in client.jsonl, so the client side is collected like the sim agent's.
 */
async function runOpenCodeDriver(
  job: Job, sc: ScenarioDef, w: WindowSpec, counter: PromptCounter, system: BenchSystem | null, variant: 'opencode' | 'kilo',
  sessionSteps: Record<string, number>,
): Promise<{ ledger: Array<Record<string, unknown>> | null; systemMs: number | null; notes: string[] }> {
  const { MockServer } = await import('./mock/server.js');
  const oc = (await import('./client/opencode.js')) as typeof import('./client/opencode.js');
  const mock = new MockServer({ counter, outDir: job.runDir, limit: w.W, spec: { render: 'sim', ...sc.mock, ...(job.mockOverrides ?? {}) }, scenarios: [sc] });
  await mock.start(0);
  writeFileSync(join(job.runDir, 'mock.out'), mock.startupLine() + '\n');
  const notes: string[] = [`driver: ${variant} client (faithful mode, truthful limits ${w.W}/${w.O})${system ? ' through the system under test' : ', direct'}`];
  let ledger: Array<Record<string, unknown>> | null = null;
  let systemMs: number | null = null;
  try {
    const base = system ? await system.start(mock.url, job.runDir) : mock.url;
    writeFileSync(join(job.runDir, 'proxy.args'), system ? (system.args ?? []).join(' ') : '(direct)');
    let first = true;
    for (const s of sc.sessions) {
      sessionSteps[s.id] = s.steps;
      const r = await oc.runOpenCode({
        base, counter, spec: sc, session: s.id, mode: 'faithful', variant, context: w.W, output: w.O, outDir: job.runDir, appendLog: !first,
        origRender: sc.mock.render ?? 'sim',
      });
      first = false;
      notes.push(`${s.id}: ${r.compactions.length} client compactions (${r.compactions.map((c) => `${c.reason}@${c.step}`).join(', ') || 'none'}), ${r.stepsCompleted}/${r.steps} steps${r.error ? `, error ${r.error.kind} at step ${r.error.step}` : ''}`);
    }
  } finally {
    if (system) {
      const rep = await system.stop();
      systemMs = (rep.meta['wall_ms'] as number | undefined) ?? null;
      ledger = rep.ledger.length ? rep.ledger : null;
    }
    await mock.stop();
  }
  if (sc.sessions.length > 1) notes.push('the OpenCode client runs one session at a time (sessions sequential, not interleaved)');
  return { ledger, systemMs, notes };
}

/** Direct runs: each client request is the upstream request at the same position (per session and kind, in order). */
export function attachDirectClientBodies(rr: RunRecords): void {
  const ups = new Map<string, UpstreamRec[]>();
  for (const r of [...rr.up].sort((a, b) => a.seq - b.seq)) {
    const k = `${r.session}\u0000${r.kind}`;
    let g = ups.get(k);
    if (!g) ups.set(k, (g = []));
    g.push(r);
  }
  const pos = new Map<string, number>();
  for (const c of rr.client) {
    const k = `${c.session}\u0000${c.kind}`;
    const i = pos.get(k) ?? 0;
    pos.set(k, i + 1);
    const u = ups.get(k)?.[i];
    if (!u) continue;
    c.digests = u.digests;
    c.facts = u.facts;
    c.pairingStrict = u.pairingStrict;
    c.prompt = u.prompt;
  }
}

/** Run one cell in this process (the worker). */
export async function runCell(job: Job): Promise<ResultsFile> {
  const startedAt = new Date();
  const t0 = performance.now();
  const { cell } = job;
  const sys = getSystem(cell.system);
  const w = WINDOWS[cell.window];
  const sc = buildScenario(cell.scenario, cell.window);
  const counter = new PromptCounter(loadTokenizer(job.tokenizerPath));
  if (sys.kind === 'offline') return runOffline(job, sc, w, counter);
  await loadSystemModules();
  rmSync(job.runDir, { recursive: true, force: true });
  mkdirSync(job.runDir, { recursive: true });
  const ctx: SystemContext = {
    window: w, scenario: sc, runDir: job.runDir, stateDir: join(job.isoDir, 'kitzur-state'), homeDir: join(job.isoDir, 'home'),
    statsPath: join(job.runDir, 'ledger.jsonl'), gobstopperBin: job.gobstopperBin, tokenizerPath: job.tokenizerPath,
  };
  mkdirSync(ctx.stateDir, { recursive: true });
  const notes: string[] = [];
  const sessionSteps: Record<string, number> = {};
  const single = sc.sessions.length === 1;
  let driver: string;
  let stepMs: number[] = [];
  let systemMs: number | null = null;
  let ledger: Array<Record<string, unknown>> | null = null;
  const clientKind: 'sim' | 'opencode' | 'kilo' = sys.client === 'opencode' ? (sc.client === 'kilo' ? 'kilo' : 'opencode') : sc.client;
  const restarts = (sc.events ?? []).filter((e): e is { atStep: number; kind: 'sigterm' | 'sigkill' | 'fresh-state' } => e.kind !== 'client-compact');
  if (restarts.length && !sys.restartable) throw new Error(`${sys.id} cannot be restarted (F13 events)`);
  if (restarts.length && clientKind !== 'sim') throw new Error('F13 restart events need the sim agent (its beforeStep hook)');
  const useReference = (sys.driver ?? 'auto') === 'auto' && !!sc.reference && (sc.mock.render ?? 'sim') === 'sim' && sc.client === 'sim' && sys.client === 'scenario' && single && !sc.events?.length && !sc.clientOptions;
  if (useReference) {
    driver = 'reference';
    const { runExperiment } = await import('./harness.js');
    const { Direct } = await import('./systems/direct.js');
    const system = sys.create?.(ctx) ?? new Direct();
    const steps = sc.sessions[0]!.steps;
    sessionSteps['default'] = steps;
    const res = await runExperiment({
      name: cell.runKey, runDir: job.runDir, system, scenario: sc.reference!, counter,
      mock: { limit: w.W }, client: { steps, maxTokens: w.O, saveOrigs: true },
    });
    stepMs = res.client.map((c) => (c.ms_complete as number | undefined) ?? 0);
    systemMs = (res.system.meta['wall_ms'] as number | undefined) ?? null;
    ledger = res.system.ledger.length ? res.system.ledger : null;
    notes.push('driver: reference (bench/harness.ts, the Python-parity path; the legacy client is not strict, which only matters for responses a proxy synthesizes)');
  } else if (clientKind !== 'sim') {
    driver = clientKind;
    const oc = await runOpenCodeDriver(job, sc, w, counter, sys.create?.(ctx) ?? null, clientKind, sessionSteps);
    stepMs = [];
    systemMs = oc.systemMs;
    ledger = oc.ledger;
    notes.push(...oc.notes);
  } else {
    driver = 'spec';
    const { MockServer } = await import('./mock/server.js');
    const { runAgent } = await import('./client/agent.js');
    const mockSpec = { render: 'sim' as const, ...sc.mock, ...(job.mockOverrides ?? {}) };
    const mock = new MockServer({ counter, outDir: job.runDir, limit: w.W, spec: mockSpec, scenarios: [sc] });
    await mock.start(0);
    writeFileSync(join(job.runDir, 'mock.out'), mock.startupLine() + '\n');
    const system = sys.create?.(ctx) ?? null;
    for (const s of sc.sessions) sessionSteps[s.id] = s.steps;
    try {
      const base = system ? await system.start(mock.url, job.runDir) : mock.url;
      writeFileSync(join(job.runDir, 'proxy.args'), system ? (system.args ?? []).join(' ') : '(direct)');
      // F13: restart the system under test before the requests of each event step (sessions share the system)
      const pending = new Map(restarts.map((e) => [e.atStep, e.kind]));
      const beforeStep = restarts.length
        ? async ({ step }: { session: string; step: number }): Promise<string | void> => {
            const kind = pending.get(step);
            if (!kind) return;
            pending.delete(step);
            const r = system as (BenchSystem & { restart?: (k: typeof kind) => Promise<string> }) | null;
            if (!r) {
              notes.push(`${kind} before step ${step}: direct (no system state), nothing restarted`);
              return;
            }
            if (!r.restart) throw new Error(`${sys.id}: the system object has no restart()`);
            const nb = await r.restart(kind);
            notes.push(`${kind} restart before step ${step}`);
            return nb;
          }
        : undefined;
      const agent = await runAgent({
        base, counter, outDir: job.runDir, spec: sc, strict: true, maxTokens: w.O, saveOrigs: true,
        usage: sc.clientOptions?.includeUsage ?? true, stream: sc.clientOptions?.stream ?? true, origRender: sc.mock.render ?? 'sim',
        ...(beforeStep ? { beforeStep } : {}),
      });
      stepMs = agent.records.map((c) => (c.ms_complete as number | undefined) ?? 0);
    } finally {
      if (system) {
        const rep = await system.stop();
        systemMs = (rep.meta['wall_ms'] as number | undefined) ?? null;
        ledger = rep.ledger.length ? rep.ledger : null;
      }
      await mock.stop();
    }
  }
  const { measure, note } = await measureFor(sc, counter);
  if (note) notes.push(note);
  const rr = collectRunDir(job.runDir, { counter, facts: sc.facts, steps: sessionSteps, measure, defaultSession: 'default' });
  if (!ledger) ledger = readJsonlFile(join(job.runDir, 'ledger.jsonl'));
  // benchmark contract compactions_reported: gobstopper = ledger `compacted` or attempts > 1 (analyze.py); OpenCode = its
  // summarizer requests
  const m = computeMetrics({
    scenario: sc, window: w, rr, ledger: ledger.length ? ledger : null,
    // the OpenCode client direct: its own summarizer requests; behind a proxy: the proxy's own count (ledger)
    ...(clientKind !== 'sim' && !ledger.length ? { compactionsReported: rr.up.filter((r) => r.kind === 'summarizer').length } : {}),
  });
  if (!job.keepBodies) {
    rmSync(join(job.runDir, 'reqs'), { recursive: true, force: true });
    rmSync(join(job.runDir, 'origs'), { recursive: true, force: true });
  }
  return {
    ...baseResults(cell, job.versions), status: 'ok', driver, metrics: m.metrics, facts: m.facts, supersession: m.supersession,
    gates: m.gates, clientErrors: m.clientErrors, notes, perRequest: m.perRequest, timing: runTiming(performance.now() - t0, stepMs, systemMs, startedAt),
  };
}

function errorResults(job: Job, e: unknown): ResultsFile {
  return { ...baseResults(job.cell, job.versions), status: 'error', reason: e instanceof Error ? `${e.message}` : String(e) };
}

async function workerMain(): Promise<void> {
  const job = await new Promise<Job>((resolve) => process.once('message', (m) => resolve(m as Job)));
  let out: ResultsFile;
  try {
    out = await runCell(job);
  } catch (e) {
    console.error(e);
    out = errorResults(job, e);
  }
  mkdirSync(job.resultsDir, { recursive: true });
  writeFileSync(resultsPath(job.resultsDir, job.cell.runKey), JSON.stringify(out, null, 1) + '\n');
  process.send?.({ done: true, status: out.status, reason: out.reason });
  process.disconnect?.();
}

// ---------------------------------------------------------------- parent side

export interface PoolOptions {
  workers?: number;
  resultsDir?: string;
  rawDir?: string;
  keepBodies?: boolean;
  resume?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface Outcome {
  cell: Cell;
  status: ResultsFile['status'] | 'cached';
  reason: string | null;
  ms: number;
}

/** The environment of a worker: the parent's minus KITZUR_* and XDG_*, with HOME and XDG_* under the run. */
export function isolatedEnv(base: NodeJS.ProcessEnv, isoDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith('KITZUR_') || k.startsWith('XDG_')) continue;
    env[k] = v;
  }
  return { ...env, ...ensureIso(isoDir) };
}

export function versionsNow(tokenizerPath: string | null, gobBin: string | null): Versions {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const commit = git.status === 0 ? git.stdout.trim() + (dirty.stdout.trim() ? '+dirty' : '') : null;
  let gobVersion: string | null = null;
  if (gobBin) {
    const v = spawnSync(gobBin, ['--version'], { encoding: 'utf8' });
    gobVersion = v.status === 0 ? v.stdout.trim() : null;
  }
  return { commit, node: process.version, gobSha: fileSha256(gobBin), gobVersion, tokenizerSha: fileSha256(tokenizerPath), codeVersion: codeVersion() };
}

const WORKER = fileURLToPath(import.meta.url);

/** Largest body a system forwarded on a scenario (for http413's derived maxBodyBytes). */
function derivedOverrides(cell: Cell, sc: ScenarioDef, resultsDir: string, all: Cell[]): { overrides?: Record<string, unknown>; skip?: string } {
  if (!sc.maxBodyBytesFrom) return {};
  const src = all.find((c) => c.system === cell.system && c.scenario === sc.maxBodyBytesFrom!.scenario && c.window === cell.window);
  const p = src ? resultsPath(resultsDir, src.runKey) : null;
  if (!p || !existsSync(p)) return { skip: `needs the ${cell.system}/${sc.maxBodyBytesFrom.scenario}/${cell.window} cell first (B_max)` };
  const r = JSON.parse(readFileSync(p, 'utf8')) as ResultsFile;
  const bmax = Math.max(0, ...r.perRequest.filter((x) => x.kind === 'main').map((x) => x.bytes));
  if (!bmax) return { skip: `the ${sc.maxBodyBytesFrom.scenario} cell has no forwarded bodies` };
  return { overrides: { maxBodyBytes: Math.floor(sc.maxBodyBytesFrom.factor * bmax) } };
}

export async function runPool(cells: Cell[], o: PoolOptions = {}): Promise<Outcome[]> {
  const workers = Math.max(1, o.workers ?? 3);
  const resultsDir = o.resultsDir ?? RESULTS_DIR;
  const rawDir = o.rawDir ?? RAW_RESULTS_DIR;
  const log = o.log ?? ((l: string) => console.log(l));
  const tokenizerPath = benchTokenizerPath();
  if (!tokenizerPath) throw new Error('no tokenizer.json: run scripts/fetch-tokenizer.sh or set KITZUR_BENCH_TOKENIZER');
  const gob = gobstopperBin();
  const versions = versionsNow(tokenizerPath, gob);
  mkdirSync(resultsDir, { recursive: true });
  const outcomes: Outcome[] = [];
  // http413 cells depend on their qa46 cell: run them last
  const ordered = [...cells].sort((a, b) => Number(a.scenario.startsWith('err-http413')) - Number(b.scenario.startsWith('err-http413')));
  const queue = [...ordered];
  const running = new Set<Promise<void>>();
  const startOne = (cell: Cell): Promise<void> => {
    const t = performance.now();
    const file = resultsPath(resultsDir, cell.runKey);
    if (o.resume && existsSync(file)) {
      const prev = JSON.parse(readFileSync(file, 'utf8')) as ResultsFile;
      if (prev.status === 'ok' || prev.status === 'not-run') {
        outcomes.push({ cell, status: 'cached', reason: prev.reason, ms: 0 });
        return Promise.resolve();
      }
    }
    let skip = cell.skip;
    let overrides: Record<string, unknown> | undefined;
    if (!skip && cell.system !== 'opencode-sim' && cell.system !== 'opencode-sim-compat') {
      const d = derivedOverrides(cell, buildScenario(cell.scenario, cell.window), resultsDir, cells);
      if (d.skip) skip = d.skip;
      overrides = d.overrides;
    }
    if (!skip && getSystem(cell.system).id.startsWith('gobstopper') && !gob) skip = 'gobstopper binary not found';
    if (skip) {
      writeFileSync(file, JSON.stringify(notRunResults(cell, versions, skip), null, 1) + '\n');
      outcomes.push({ cell, status: 'not-run', reason: skip, ms: 0 });
      log(`NOT RUN ${cell.system}/${cell.scenario}/${cell.window}: ${skip}`);
      return Promise.resolve();
    }
    const tag = `${cell.runKey.slice(0, 12)}-${cell.system}-${cell.scenario}-${cell.window}`;
    const job: Job = {
      cell, runDir: join(rawDir, tag), isoDir: join(rawDir, `${tag}.iso`), resultsDir, keepBodies: o.keepBodies ?? false,
      tokenizerPath, gobstopperBin: gob, versions, ...(overrides ? { mockOverrides: overrides } : {}),
    };
    rmSync(job.isoDir, { recursive: true, force: true });
    const env = isolatedEnv(process.env, job.isoDir);
    mkdirSync(rawDir, { recursive: true });
    const wlog = createWriteStream(join(rawDir, `${tag}.worker.log`));
    const attempt = (n: number): Promise<void> => new Promise<void>((resolve) => {
      const child: ChildProcess = fork(WORKER, ['--worker'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
      child.stdout!.pipe(wlog, { end: false });
      child.stderr!.pipe(wlog, { end: false });
      let msg: { status: ResultsFile['status']; reason: string | null } | null = null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        log(`TIMEOUT ${tag}`);
        child.kill('SIGKILL');
      }, o.timeoutMs ?? 30 * 60_000);
      child.on('message', (m) => (msg = m as typeof msg));
      // 'close' (not 'exit'): every IPC message and stdio byte has been delivered by then
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (!msg && n === 0 && !timedOut) {
          // a worker killed from outside (signal, OOM) before it reported: run the cell once more
          wlog.write(`\n[pool] worker exited with ${code ?? signal} before reporting; retrying once\n`);
          log(`RETRY   ${tag} (worker exited with ${code ?? signal} before reporting)`);
          void attempt(1).then(resolve);
          return;
        }
        wlog.end();
        if (!msg) {
          const r = errorResults(job, new Error(`worker exited with ${code ?? signal} before reporting`));
          writeFileSync(file, JSON.stringify(r, null, 1) + '\n');
          msg = { status: 'error', reason: r.reason };
        }
        const ms = performance.now() - t;
        outcomes.push({ cell, status: msg.status, reason: msg.reason, ms });
        log(`${msg.status.toUpperCase().padEnd(7)} ${tag} ${(ms / 1000).toFixed(1)}s${msg.reason ? ` ${msg.reason}` : ''}`);
        resolve();
      });
      child.send(job);
    });
    return attempt(0);
  };
  while (queue.length || running.size) {
    while (queue.length && running.size < workers) {
      const cell = queue.shift()!;
      // an http413 cell waits for everything else (its source cell) to finish
      if (cell.scenario.startsWith('err-http413') && running.size) {
        queue.unshift(cell);
        break;
      }
      const p: Promise<void> = startOne(cell).then(() => void running.delete(p));
      running.add(p);
    }
    if (running.size) await Promise.race(running);
  }
  return outcomes;
}

// ---------------------------------------------------------------- CLI

if (process.argv.includes('--worker')) {
  await workerMain();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const mo: MatrixOptions = {
    tiers: (flag('--tier')?.split(',') as Tier[] | undefined) ?? ['T1'],
    ...(flag('--only') ? { only: flag('--only')! } : {}),
    ...(flag('--systems') ? { systems: flag('--systems')!.split(',') } : {}),
    ...(flag('--windows') ? { windows: flag('--windows')!.split(',') as WindowId[] } : {}),
    ...(flag('--scenarios') ? { scenarios: flag('--scenarios')!.split(',') } : {}),
    tokenizerSha: fileSha256(benchTokenizerPath()) ?? 'none',
  };
  const cells = matrix(mo);
  console.log(`${cells.length} cells (${cells.filter((c) => !c.skip).length} runnable)`);
  const t = performance.now();
  const out = await runPool(cells, {
    workers: Number(flag('--workers') ?? 3),
    ...(flag('--results-dir') ? { resultsDir: flag('--results-dir')! } : {}),
    ...(flag('--raw-dir') ? { rawDir: flag('--raw-dir')! } : {}),
    resume: args.includes('--resume'),
    keepBodies: args.includes('--keep-bodies'),
  });
  const by = (s: string): number => out.filter((x) => x.status === s).length;
  console.log(`done in ${((performance.now() - t) / 1000).toFixed(1)}s: ok ${by('ok')}, cached ${by('cached')}, not-run ${by('not-run')}, error ${by('error')}`);
  if (by('error')) process.exitCode = 1;
}
