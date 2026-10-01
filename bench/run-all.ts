// The whole benchmark suite (bench/README.md§13, §15): `npm run bench` runs dist/bench/run-all.js.
//
//   phases  crosscheck → matrix (T1) → ablations (T2) → sweep (T3) → fuzz → latency → report
//
//   node dist/bench/run-all.js [--quick] [--tier T1,T2,T3] [--only GLOB] [--resume] [--workers 3] [--keep-bodies]
//                              [--phases crosscheck,matrix,ablations,sweep,fuzz,latency,report] [--no-crosscheck]
//                              [--snapshot] [--prune] [--results-dir DIR] [--raw-dir DIR]
//
//  --quick       G1–G7 at 100k (kitzur on every 100k T1 cell, the comparators on qa46-ref/qa46) plus G8 on
//                qa46-ref/qa46 at 32k/64k; the other cells stay NOT RUN in the report (never PASS)
//  --tier        the tiers of the matrix phases (T1 = matrix, T2 = ablations, T3 = sweep); default all three
//  --only        a glob over "system/scenario/window" applied to every matrix phase
//  --resume      reuse results files whose runKey matches (ok or not-run); the cross-check is skipped when
//                crosscheck.json already holds every case a–h for the same code version
//  --snapshot    freeze dist/ into bench/.cache/snap-<code>/ and run from there, so a rebuild by another process
//                during the run cannot mix code versions (the runKeys use the code version at freeze time)
//  --prune       move results files of older code versions (not in the new manifest) to bench/results/raw/stale-results/
//
// Every phase writes into bench/results/: <runKey>.json per cell (bench/pool.ts), crosscheck.json, manifest.json (the
// full matrix at this code version: the report only reads the runKeys listed there, so stale results of older code
// are never reported), run-all.json (phase runtimes), and the report writes BENCHMARKS.md at the repo root plus
// gates.json / BENCHMARKS.cells.json. fuzz.json and latency.json are written by the fuzz and latency suites (benchmark component;
// bench/fuzz/run.js, bench/latency.js, run here when they are built) and read by the report when present.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { benchTokenizerPath, RAW_RESULTS_DIR, RESULTS_DIR, refHarness, ROOT } from './lib/paths.js';
import { codeVersion, fileSha256, matrix, type Cell, type Tier } from './matrix.js';
import { runPool, type Outcome } from './pool.js';

export const PHASES = ['crosscheck', 'matrix', 'ablations', 'sweep', 'fuzz', 'latency', 'report'] as const;
export type Phase = (typeof PHASES)[number];
const PHASE_TIER: Partial<Record<Phase, Tier>> = { matrix: 'T1', ablations: 'T2', sweep: 'T3' };

export interface RunAllOptions {
  quick: boolean;
  tiers: Tier[];
  only: string | null;
  resume: boolean;
  workers: number;
  keepBodies: boolean;
  phases: Phase[];
  resultsDir: string;
  rawDir: string;
  /** move results files the manifest does not list (older code versions) to raw/stale-results/ */
  prune: boolean;
}

export function parseArgs(argv: readonly string[]): RunAllOptions & { snapshot: boolean } {
  const flag = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  let phases = (flag('--phases')?.split(',') as Phase[] | undefined) ?? [...PHASES];
  for (const p of phases) if (!PHASES.includes(p)) throw new Error(`unknown phase ${p} (have ${PHASES.join(', ')})`);
  if (argv.includes('--no-crosscheck')) phases = phases.filter((p) => p !== 'crosscheck');
  const tiers = (flag('--tier')?.split(',') as Tier[] | undefined) ?? ['T1', 'T2', 'T3'];
  return {
    quick: argv.includes('--quick'), tiers, only: flag('--only') ?? null, resume: argv.includes('--resume'),
    workers: Number(flag('--workers') ?? 3), keepBodies: argv.includes('--keep-bodies'), phases,
    resultsDir: flag('--results-dir') ?? RESULTS_DIR, rawDir: flag('--raw-dir') ?? RAW_RESULTS_DIR, snapshot: argv.includes('--snapshot'),
    prune: argv.includes('--prune'),
  };
}

/** The --quick selection (benchmark contract ): G1–G7 at 100k plus G8 on qa46 at 32k/64k. */
export function quickFilter(c: Cell): boolean {
  if (c.tier !== 'T1') return false;
  const cmp = ['gobstopper-tuned', 'opencode', 'opencode-sim', 'opencode-sim-compat'];
  if (c.window === '100k') return c.system === 'kitzur' || (cmp.includes(c.system) && ['qa46-ref', 'qa46', 'talk80-ref'].includes(c.scenario));
  if (c.window === '32k' || c.window === '64k') return (c.system === 'kitzur' || cmp.includes(c.system)) && ['qa46-ref', 'qa46'].includes(c.scenario);
  return false;
}

export interface Manifest {
  codeVersion: string;
  tokenizerSha: string;
  generated: string;
  cells: Array<Pick<Cell, 'system' | 'scenario' | 'window' | 'tier' | 'runKey'>>;
}

function log(line: string): void {
  console.log(`[run-all ${new Date().toISOString().slice(11, 19)}] ${line}`);
}

function node(script: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: env ?? process.env, cwd: ROOT });
  return r.status ?? 1;
}

/** crosscheck.json is current: all of a–h present, each matching, for this code version. */
function crosscheckCurrent(dir: string, code: string): boolean {
  const p = join(dir, 'crosscheck.json');
  if (!existsSync(p)) return false;
  try {
    const x = JSON.parse(readFileSync(p, 'utf8')) as { versions?: { codeVersion?: string }; results?: Array<{ id: string }> };
    const ids = new Set((x.results ?? []).map((r) => r.id));
    return x.versions?.codeVersion === code && ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].every((i) => ids.has(i));
  } catch {
    return false;
  }
}

export async function runAll(o: RunAllOptions): Promise<number> {
  const t0 = performance.now();
  const here = fileURLToPath(new URL('.', import.meta.url));
  const tokenizerPath = benchTokenizerPath();
  if (!tokenizerPath) throw new Error('no tokenizer.json: run scripts/fetch-tokenizer.sh or set KITZUR_BENCH_TOKENIZER');
  const code = codeVersion();
  const tokSha = fileSha256(tokenizerPath) ?? 'none';
  mkdirSync(o.resultsDir, { recursive: true });
  const runtimes: Record<string, { ms: number; cells?: Record<string, number> }> = {};
  let failures = 0;
  // the full matrix at this code version: the report reads only these runKeys
  const all = matrix({ tiers: ['T1', 'T2', 'T3'], codeVersion: code, tokenizerSha: tokSha });
  const manifest: Manifest = {
    codeVersion: code, tokenizerSha: tokSha, generated: new Date().toISOString(),
    cells: all.map((c) => ({ system: c.system, scenario: c.scenario, window: c.window, tier: c.tier, runKey: c.runKey })),
  };
  writeFileSync(join(o.resultsDir, 'manifest.json'), JSON.stringify(manifest) + '\n');
  if (o.prune) {
    // results of older code versions (runKeys the manifest does not list) move to raw/stale-results/
    const keep = new Set(all.map((c) => `${c.runKey}.json`));
    const stale = readdirSync(o.resultsDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f) && !keep.has(f));
    if (stale.length) {
      const dest = join(o.rawDir, 'stale-results');
      mkdirSync(dest, { recursive: true });
      for (const f of stale) renameSync(join(o.resultsDir, f), join(dest, f));
      log(`prune: moved ${stale.length} results files of older code versions to ${dest.slice(ROOT.length + 1)}`);
    }
  }
  log(`code ${code.slice(0, 12)}, tokenizer ${tokSha.slice(0, 12)}, ${all.length} cells in the full matrix; phases ${o.phases.join(' → ')}`);

  for (const phase of o.phases) {
    const tp = performance.now();
    if (phase === 'crosscheck') {
      if (o.resume && crosscheckCurrent(o.resultsDir, code)) log('crosscheck: current (cases a–h, same code), skipped');
      else if (o.quick) log('crosscheck: skipped by --quick (T0 stays as crosscheck.json has it)');
      else {
        const ref = refHarness();
        log(`crosscheck: ${ref ? 'TS ∥ Python ∥ gobstopper' : 'TS side only (KITZUR_REF_DIR not set: T0 stays NOT RUN)'}`);
        const args = ref ? ['--fresh'] : ['--no-python', '--fresh'];
        const evalResults = process.env['KITZUR_EVAL_RESULTS'];
        if (evalResults) args.push('--eval-results', evalResults);
        if (node(join(here, 'crosscheck.js'), args) !== 0) {
          failures++;
          log('crosscheck: FAILED (see its output)');
        }
      }
    } else if (PHASE_TIER[phase]) {
      const tier = PHASE_TIER[phase]!;
      if (!o.tiers.includes(tier)) {
        log(`${phase}: tier ${tier} not selected`);
        continue;
      }
      let cells = matrix({ tiers: [tier], codeVersion: code, tokenizerSha: tokSha, ...(o.only ? { only: o.only } : {}) });
      if (o.quick) cells = cells.filter(quickFilter);
      log(`${phase} (${tier}): ${cells.length} cells`);
      const out: Outcome[] = await runPool(cells, {
        workers: o.workers, resultsDir: o.resultsDir, rawDir: o.rawDir, resume: o.resume, keepBodies: o.keepBodies,
        log: (l) => log(`${phase}: ${l}`),
      });
      const by = (s: string): number => out.filter((x) => x.status === s).length;
      runtimes[phase] = { ms: Math.round(performance.now() - tp), cells: { ok: by('ok'), cached: by('cached'), notRun: by('not-run'), error: by('error') } };
      log(`${phase}: ok ${by('ok')}, cached ${by('cached')}, not-run ${by('not-run')}, error ${by('error')} in ${((performance.now() - tp) / 1000).toFixed(0)} s`);
      if (by('error')) failures++;
      continue;
    } else if (phase === 'fuzz' || phase === 'latency') {
      const script = phase === 'fuzz' ? join(here, 'fuzz', 'run.js') : join(here, 'latency.js');
      if (!existsSync(script)) log(`${phase}: ${script.slice(ROOT.length + 1)} is not built (benchmark component); the report reads results/${phase}.json if present`);
      else if (o.resume && existsSync(join(o.resultsDir, `${phase}.json`))) log(`${phase}: results/${phase}.json exists, skipped (--resume)`);
      else {
        log(`${phase}: ${script.slice(ROOT.length + 1)}`);
        if (node(script, o.quick ? ['--quick'] : []) !== 0) {
          failures++;
          log(`${phase}: FAILED`);
        }
      }
    } else if (phase === 'report') {
      writeFileSync(join(o.resultsDir, 'run-all.json'), JSON.stringify({ codeVersion: code, generated: new Date().toISOString(), runtimes, options: { ...o, resultsDir: undefined, rawDir: undefined } }, null, 1) + '\n');
      const args = o.resultsDir !== RESULTS_DIR ? ['--results-dir', o.resultsDir, '--out', o.resultsDir] : [];
      if (node(join(here, 'report.js'), args) !== 0) failures++;
    }
    runtimes[phase] = { ms: Math.round(performance.now() - tp) };
  }
  log(`done in ${((performance.now() - t0) / 60000).toFixed(1)} min${failures ? `, ${failures} phase(s) with failures` : ''}`);
  return failures ? 1 : 0;
}

/** Freeze dist/{src,bench} into bench/.cache/snap-<code16>/ and re-run this script from there. */
function snapshotAndReexec(argv: string[]): number {
  const code = codeVersion();
  const snap = join(ROOT, 'bench', '.cache', `snap-${code.slice(0, 16)}`);
  if (!existsSync(join(snap, 'bench', 'run-all.js'))) {
    rmSync(snap, { recursive: true, force: true });
    mkdirSync(snap, { recursive: true });
    cpSync(join(ROOT, 'dist', 'src'), join(snap, 'src'), { recursive: true });
    cpSync(join(ROOT, 'dist', 'bench'), join(snap, 'bench'), { recursive: true });
  }
  log(`running from the frozen copy ${snap.slice(ROOT.length + 1)} (code ${code.slice(0, 12)})`);
  return node(join(snap, 'bench', 'run-all.js'), argv.filter((a) => a !== '--snapshot'), { ...process.env, KITZUR_BENCH_CODE_VERSION: code });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  if (o.snapshot) process.exitCode = snapshotAndReexec(argv);
  else process.exitCode = await runAll(o);
}
