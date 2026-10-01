// The fuzz suite runner (bench/README.mdgate G9).
//
//   node dist/bench/fuzz/run.js [--chains 10000] [--base 1] [--workers 4] [--resume] [--http 300]
//                               [--out bench/results/fuzz.json] [--checks quick|full] [--repro SEED]
//
// Seeds base … base+chains−1 are spread over forked workers (dynamic batches); every chain's outcome is appended
// to bench/results/raw/fuzz/base-<base>/chains.jsonl, so an interrupted run resumes with --resume. The summary
// goes to --out: {histories, chains, requests, violations, coverage (count and share of chains per path, with
// the §10 minimums), seeds, runtime, http}. A violation prints its seed and a shrunk repro JSON
// (bench/results/raw/fuzz/repro-<seed>.json). The exit code is 1 on any violation or unmet coverage minimum.
import { fork } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_RESULTS_DIR, RESULTS_DIR, benchTokenizerPath } from '../lib/paths.js';
import { loadTokenizerCached } from '../../src/tokenize/load.js';
import type { Tokenizer } from '../../src/tokenize/tokenizer.js';
import { genChain, type FuzzChain } from './gen.js';
import { checkChain, COVERAGE_KEYS, DEFAULT_CHECKS, type ChainOutcome, type CheckOptions, type Violation } from './invariants.js';
import { shrink } from './shrink.js';

const HERE = fileURLToPath(import.meta.url);

/** §10 coverage minimums (share of chains). */
export const MINIMUMS: Record<string, number> = {
  compact: 0.25, admission: 0.05, oversize: 0.05, slim: 0.02, impossible: 0.01, guardAny: 0.005, clamp: 0.01,
};

function arg(name: string, def: string | null = null): string | null {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : def;
}
const flag = (name: string): boolean => process.argv.includes('--' + name);

let tokMemo: Tokenizer | null | undefined;
export function fuzzTokenizer(): Tokenizer | null {
  if (tokMemo !== undefined) return tokMemo;
  const p = process.env['KITZUR_TEST_TOKENIZER'] ?? benchTokenizerPath();
  tokMemo = p && existsSync(p) ? loadTokenizerCached(p, null, { stateDir: join(RAW_RESULTS_DIR, 'fuzz', '.tokcache') }) : null;
  return tokMemo;
}

export function checksFor(name: string): CheckOptions {
  return name === 'quick' ? { ...DEFAULT_CHECKS, freshEvery: 3, boundaryReplay: 3 } : DEFAULT_CHECKS;
}

/** Generates and checks one seed. */
export function runSeed(seed: number, checks: CheckOptions): ChainOutcome & { tags: string[] } {
  const tok = fuzzTokenizer();
  let chain: FuzzChain;
  try {
    chain = genChain(seed, { exact: tok !== null });
  } catch (e) {
    return {
      seed, requests: 0, violations: [{ inv: 'gen', seed, request: -1, detail: String(e) }], cov: {}, checks: { fresh: 0, boundaryReplay: 0, i6pairs: 0, faults: 0, ledgerFit: 0, retries: 0 },
      ms: 0, window: 0, template: '', mode: '', preset: null, tags: [],
    };
  }
  // the preset windows carry 4× larger histories: compare with fresh engines every other request there
  const ck = chain.preset && checks.freshEvery === 1 ? { ...checks, freshEvery: 2 } : checks;
  return { ...checkChain(chain, tok, ck), tags: chain.tags };
}

// ---------------------------------------------------------------- worker

async function worker(): Promise<void> {
  const checks = checksFor(arg('checks', 'full')!);
  process.on('disconnect', () => process.exit(0)); // the master is gone: do not run on as an orphan
  process.on('message', (msg: { seeds?: number[]; stop?: boolean }) => {
    if (msg.stop) process.exit(0);
    for (const seed of msg.seeds ?? []) {
      const out = runSeed(seed, checks);
      process.send!({ outcome: out });
    }
    process.send!({ ready: true });
  });
  process.send!({ ready: true });
}

// ---------------------------------------------------------------- master

interface Summary {
  histories: number;
  chains: number;
  requests: number;
  violations: { total: number; byInvariant: Record<string, number>; seeds: number[]; first: Violation[] };
  coverage: Record<string, { chains: number; share: number; min?: number; ok?: boolean }>;
  coverageOk: boolean;
  checks: { fresh: number; boundaryReplay: number; i6pairs: number; faults: number; ledgerFit: number; retries: number };
  byWindow: Record<string, { chains: number; requests: number; ms: number }>;
  seeds: { base: number; count: number; first: number; last: number };
  runtime: { wallS: number; cpuChainS: number; workers: number; slowest: Array<{ seed: number; ms: number }> };
  http?: unknown;
  repros?: string[];
}

export function summarize(outs: ChainOutcome[], base: number, count: number, wallS: number, workers: number): Summary {
  const cov: Record<string, number> = {};
  const byInv: Record<string, number> = {};
  const vseeds = new Set<number>();
  const first: Violation[] = [];
  const checks = { fresh: 0, boundaryReplay: 0, i6pairs: 0, faults: 0, ledgerFit: 0, retries: 0 };
  const byWindow: Summary['byWindow'] = {};
  let requests = 0;
  let cpu = 0;
  for (const o of outs) {
    requests += o.requests;
    cpu += o.ms;
    for (const k of Object.keys(o.cov)) cov[k] = (cov[k] ?? 0) + 1;
    if (o.cov.guard || o.cov.guardFault) cov['guardAny'] = (cov['guardAny'] ?? 0) + 1;
    for (const x of o.violations) {
      byInv[x.inv] = (byInv[x.inv] ?? 0) + 1;
      vseeds.add(x.seed);
      if (first.length < 40) first.push(x);
    }
    for (const k of Object.keys(checks) as Array<keyof typeof checks>) checks[k] += o.checks[k] ?? 0;
    const w = `${o.preset ?? o.window / 1000 + 'k'}/${o.template}/${o.mode}`;
    const e = (byWindow[w] ??= { chains: 0, requests: 0, ms: 0 });
    e.chains++;
    e.requests += o.requests;
    e.ms += o.ms;
  }
  const n = outs.length;
  const coverage: Summary['coverage'] = {};
  let ok = true;
  for (const k of [...COVERAGE_KEYS, 'guardAny']) {
    const c = cov[k] ?? 0;
    const e: Summary['coverage'][string] = { chains: c, share: n ? Math.round((c / n) * 10000) / 10000 : 0 };
    const m = MINIMUMS[k];
    if (m !== undefined) {
      e.min = m;
      e.ok = n > 0 && c / n >= m;
      ok &&= e.ok;
    }
    coverage[k] = e;
  }
  const slowest = [...outs].sort((a, b) => b.ms - a.ms).slice(0, 5).map((o) => ({ seed: o.seed, ms: o.ms }));
  const seeds = outs.map((o) => o.seed);
  return {
    histories: n, chains: n, requests,
    violations: { total: [...Object.values(byInv)].reduce((a, b) => a + b, 0), byInvariant: byInv, seeds: [...vseeds].sort((a, b) => a - b).slice(0, 200), first },
    coverage, coverageOk: ok, checks, byWindow,
    seeds: { base, count, first: Math.min(...seeds), last: Math.max(...seeds) },
    runtime: { wallS: Math.round(wallS), cpuChainS: Math.round(cpu / 1000), workers, slowest },
  };
}

async function master(): Promise<void> {
  const count = Number(arg('chains', '10000'));
  const base = Number(arg('base', '1'));
  const workers = Math.max(1, Number(arg('workers', '4')));
  const outPath = arg('out', join(RESULTS_DIR, 'fuzz.json'))!;
  const checks = arg('checks', 'full')!;
  const dir = join(RAW_RESULTS_DIR, 'fuzz', `base-${base}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'chains.jsonl');
  const done = new Map<number, ChainOutcome>();
  if (flag('resume') && existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line) as ChainOutcome;
        if (o.seed >= base && o.seed < base + count) done.set(o.seed, o);
      } catch {
        /* a torn last line */
      }
    }
  } else writeFileSync(log, '');
  const todo: number[] = [];
  for (let s = base; s < base + count; s++) if (!done.has(s)) todo.push(s);
  console.log(`fuzz: ${count} chains from seed ${base} (${done.size} done, ${todo.length} to run) on ${workers} workers, checks ${checks}`);
  const t0 = performance.now();
  let next = 0;
  let finished = 0;
  let viol = 0;
  const BATCH = 4;
  await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, () => new Promise<void>((resolve, reject) => {
    const w = fork(HERE, ['--worker', '--checks', checks], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=3072'] });
    let inflight: number[] = [];
    w.on('message', (m: { ready?: boolean; outcome?: ChainOutcome }) => {
      if (m.outcome) {
        const o = m.outcome;
        inflight = inflight.filter((s) => s !== o.seed);
        done.set(o.seed, o);
        appendFileSync(log, JSON.stringify(o) + '\n');
        finished++;
        if (o.violations.length) {
          viol++;
          console.log(`VIOLATION seed ${o.seed}: ${o.violations.slice(0, 3).map((x) => `${x.inv}@${x.request} ${x.detail.slice(0, 200)}`).join(' | ')}`);
        }
        if (finished % 250 === 0) {
          const el = (performance.now() - t0) / 1000;
          console.log(`  ${finished}/${todo.length} chains, ${viol} with violations, ${el.toFixed(0)} s (eta ${((el / finished) * (todo.length - finished)).toFixed(0)} s)`);
        }
      }
      if (m.ready) {
        if (next >= todo.length) {
          w.send({ stop: true });
          return;
        }
        inflight = todo.slice(next, next + BATCH);
        next += BATCH;
        w.send({ seeds: inflight });
      }
    });
    w.on('exit', (code) => {
      if (code === 0 && inflight.length === 0) resolve();
      else {
        // a crashed worker (out of memory, …): record its in-flight seeds as violations and go on
        for (const s of inflight) {
          const o: ChainOutcome = {
            seed: s, requests: 0, violations: [{ inv: 'worker-crash', seed: s, request: -1, detail: `worker exited with ${code}` }], cov: {},
            checks: { fresh: 0, boundaryReplay: 0, i6pairs: 0, faults: 0, ledgerFit: 0, retries: 0 }, ms: 0, window: 0, template: '', mode: '', preset: null,
          };
          done.set(s, o);
          appendFileSync(log, JSON.stringify(o) + '\n');
        }
        code === 0 ? resolve() : reject(new Error(`worker exited with ${code}; seeds ${inflight.join(',')} — rerun with --resume`));
      }
    });
  })));
  const wall = (performance.now() - t0) / 1000;
  const outs = [...done.values()].sort((a, b) => a.seed - b.seed);
  const sum = summarize(outs, base, count, wall, workers);
  // shrink the first few violating seeds
  const repros: string[] = [];
  for (const s of sum.violations.seeds.slice(0, Number(arg('shrink', '8')))) {
    const o = done.get(s)!;
    const inv = o.violations[0]!.inv;
    if (inv === 'worker-crash' || inv === 'gen') continue;
    const r = shrink(genChain(s, { exact: fuzzTokenizer() !== null }), inv, fuzzTokenizer(), checksFor(checks));
    const p = join(RAW_RESULTS_DIR, 'fuzz', `repro-${s}.json`);
    writeFileSync(p, JSON.stringify(r, null, 1));
    repros.push(p);
    console.log(`repro seed ${s} (${inv}): ${r.requests.length} requests, ${r.messages} messages → ${p}`);
  }
  if (repros.length) sum.repros = repros;
  if (existsSync(outPath)) {
    try {
      const old = JSON.parse(readFileSync(outPath, 'utf8')) as Summary;
      if (old.http && !sum.http) sum.http = old.http;
    } catch {
      /* replace */
    }
  }
  writeFileSync(outPath, JSON.stringify(sum, null, 2) + '\n');
  console.log(`fuzz: ${sum.chains} chains, ${sum.requests} requests, ${sum.violations.total} violations in ${sum.violations.seeds.length} chains, coverage ${sum.coverageOk ? 'ok' : 'UNMET'}, ${wall.toFixed(0)} s → ${outPath}`);
  for (const [k, e] of Object.entries(sum.coverage)) if (e.min !== undefined) console.log(`  ${k.padEnd(10)} ${(e.share * 100).toFixed(2).padStart(6)}%  (min ${(e.min * 100).toFixed(1)}%) ${e.ok ? 'ok' : 'UNMET'}`);
  process.exitCode = sum.violations.total || !sum.coverageOk ? 1 : 0;
}

async function repro(seed: number): Promise<void> {
  const o = runSeed(seed, checksFor(arg('checks', 'full')!));
  console.log(JSON.stringify({ ...o, tags: o.tags }, null, 1));
  process.exitCode = o.violations.length ? 1 : 0;
}

if (process.argv[1] === HERE) {
  if (flag('worker')) await worker();
  else if (arg('repro') !== null) await repro(Number(arg('repro')));
  else await master();
}
