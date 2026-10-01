// bench verify (bench/README.md§15): re-run N random completed cells (default 5) in a different order, into a
// scratch results dir, and diff the deterministic parts against the originals:
//   - every results file field except `timing` and `versions` (and the NOT RUN / error texts are compared as is);
//   - the report's deterministic section rendered from the original vs the re-run files.
// Any difference is a determinism bug (scheduling order, leaked state, unseeded randomness): exit 1.
//
//   node dist/bench/verify.js [--results-dir DIR] [--n 5] [--seed S] [--workers 3] [--out DIR]

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PyRandom } from './lib/pyrandom.js';
import { RESULTS_DIR } from './lib/paths.js';
import { codeVersion, matrix, type Cell } from './matrix.js';
import { runPool, resultsPath } from './pool.js';
import { buildReport, loadResults } from './report.js';
import type { ResultsFile } from './metrics/results.js';
import { fileSha256 } from './matrix.js';
import { benchTokenizerPath } from './lib/paths.js';

/** The deterministic projection of a results file. */
export function deterministic(r: ResultsFile): Omit<ResultsFile, 'timing' | 'versions'> {
  const { timing: _t, versions: _v, ...rest } = r;
  return rest;
}

export interface Diff {
  runKey: string;
  cell: string;
  paths: string[];
}

/** Paths where two JSON values differ (first 20). */
export function diffJson(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 20) return out;
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push(path || '/');
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(path || '/');
    return out;
  }
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) out.push(`${path}/length ${a.length} != ${bb.length}`);
    for (let i = 0; i < Math.min(a.length, bb.length); i++) diffJson(a[i], bb[i], `${path}/${i}`, out);
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) diffJson(ao[k], bo[k], `${path}/${k}`, out);
  return out;
}

/** Pick n cells with ok results, and a shuffled order that differs from the original (seeded). */
export function pickCells(cells: readonly Cell[], have: ReadonlySet<string>, n: number, seed: number): Cell[] {
  const rng = new PyRandom(seed);
  const pool = cells.filter((c) => !c.skip && have.has(c.runKey));
  const k = Math.min(n, pool.length);
  const picked = rng.sample(pool, k);
  // a different order than matrix order: reverse when the sample happens to be sorted
  const idx = picked.map((c) => cells.indexOf(c));
  if (idx.every((x, i) => i === 0 || idx[i - 1]! < x)) picked.reverse();
  return picked;
}

/** The cell a results file was produced for (same runKey, so the re-run writes a file with the same name). */
export function cellOf(r: ResultsFile): Cell {
  return { system: r.system, scenario: r.scenario, window: r.window as Cell['window'], tier: r.tier as Cell['tier'], family: r.family as Cell['family'], runKey: r.runKey, skip: null };
}

export async function verify(o: { resultsDir: string; outDir: string; n: number; seed: number; workers: number }): Promise<{ diffs: Diff[]; checked: number; reportEqual: boolean; codeChanged: boolean }> {
  const original = loadResults(o.resultsDir).filter((r) => r.status === 'ok');
  const byKey = new Map(original.map((r) => [r.runKey, r]));
  // cells come from the results files, in matrix order (the original scheduling order), so the re-run order differs
  const order = new Map(matrix({ tiers: ['T1', 'T2'], tokenizerSha: fileSha256(benchTokenizerPath()) ?? 'none' }).map((c, i) => [`${c.system}/${c.scenario}/${c.window}`, i]));
  const cells = original.map(cellOf).sort((a, b) => (order.get(`${a.system}/${a.scenario}/${a.window}`) ?? 1e9) - (order.get(`${b.system}/${b.scenario}/${b.window}`) ?? 1e9));
  const picked = pickCells(cells, new Set(byKey.keys()), o.n, o.seed);
  const codeChanged = picked.some((c) => byKey.get(c.runKey)!.versions.codeVersion !== codeVersion());
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  await runPool(picked, { workers: o.workers, resultsDir: join(o.outDir, 'results'), rawDir: join(o.outDir, 'raw'), resume: false });
  const diffs: Diff[] = [];
  const rerun: ResultsFile[] = [];
  for (const c of picked) {
    const p = resultsPath(join(o.outDir, 'results'), c.runKey);
    const a = byKey.get(c.runKey)!;
    if (!existsSync(p)) {
      diffs.push({ runKey: c.runKey, cell: `${c.system}/${c.scenario}/${c.window}`, paths: ['(no re-run result)'] });
      continue;
    }
    const b = JSON.parse(readFileSync(p, 'utf8')) as ResultsFile;
    rerun.push(b);
    const d = diffJson(deterministic(a), deterministic(b));
    if (d.length) diffs.push({ runKey: c.runKey, cell: `${c.system}/${c.scenario}/${c.window}`, paths: d });
  }
  const origSubset = rerun.map((r) => byKey.get(r.runKey)!);
  const ra = buildReport({ results: origSubset, crosscheck: null, resultsLabel: 'verify' }).deterministic;
  const rb = buildReport({ results: rerun, crosscheck: null, resultsLabel: 'verify' }).deterministic;
  return { diffs, checked: picked.length, reportEqual: ra === rb, codeChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const res = await verify({
    resultsDir: flag('--results-dir') ?? RESULTS_DIR,
    outDir: flag('--out') ?? join(RESULTS_DIR, 'raw', 'verify'),
    n: Number(flag('--n') ?? 5),
    seed: Number(flag('--seed') ?? Date.now() % 1_000_000),
    workers: Number(flag('--workers') ?? 3),
  });
  console.log(`verified ${res.checked} cells: ${res.diffs.length ? `${res.diffs.length} DIFFER` : 'deterministic parts identical'}; report tables ${res.reportEqual ? 'identical' : 'DIFFER'}`);
  if (res.codeChanged) console.log('note: the sources changed since these results were produced (versions.codeVersion); a difference may be a code change, not nondeterminism');
  for (const d of res.diffs) console.log(`  ${d.cell} (${d.runKey.slice(0, 12)}): ${d.paths.join(', ')}`);
  if (res.diffs.length || !res.reportEqual || res.checked === 0) process.exitCode = 1;
}
