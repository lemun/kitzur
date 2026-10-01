// BENCHMARKS.md and gates.json as a pure function of the results files (bench/README.md; ).
//
//  - every numeric cell is {value, tag, src}: src is a JSON pointer into a results file (MEASURED) or a citation
//    (READ / MODEL); a MEASURED cell without src is refused (cell() throws). The cells are also written to
//    BENCHMARKS.cells.json for machine checking.
//  - gates are computed from explicit runKeys as PASS | FAIL(gap, cause) | NOT RUN(reason); NOT RUN never counts as PASS.
//  - the deterministic part (everything above "## Timing") is byte-identical across re-runs with the same results
//    (bench/verify.ts checks it); timing and machine info live in their own section at the end.
//
//   node dist/bench/report.js [--results-dir DIR] [--out DIR] [--crosscheck FILE] [--all]
//   (--all: ignore manifest.json and report every results file, newest per cell)
//   (default: bench/results → BENCHMARKS.md at the repo root and bench/results/gates.json)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESULTS_DIR, ROOT } from './lib/paths.js';
import { fmtInt } from './lib/stats.js';
import type { ResultsFile, RunMetrics } from './metrics/results.js';
import { FAMILY_NAMES, familyOf, hasScenario } from './scenarios/index.js';
import { CONFIGURED_STYLES, G8_STYLES } from './scenarios/errors.js';
import type { FamilyId, GateId } from './scenarios/types.js';
import { WINDOW_IDS, WINDOWS, windowLabel, type WindowId } from './scenarios/windows.js';

// ---------------------------------------------------------------- cells

export type Tag = 'MEASURED' | 'READ' | 'MODEL' | 'INFERRED';
export type Fmt = 'int' | 'pct' | 'ratio4' | 'text' | 'bool' | 'steps';

export interface Cell {
  value: number | string | boolean | null;
  tag: Tag;
  /** JSON pointer into a results file (MEASURED) or a citation */
  src: string | null;
  fmt: Fmt;
}

export class ReportError extends Error {}

export function cell(value: Cell['value'], tag: Tag, src: string | null, fmt: Fmt = 'int'): Cell {
  if (tag === 'MEASURED' && value !== null && !src) throw new ReportError(`MEASURED cell ${String(value)} has no src`);
  return { value, tag, src, fmt };
}

export const ptr = (r: ResultsFile, path: string): string => `results/${r.runKey}.json#/${path}`;

export function fmtCell(c: Cell): string {
  const v = c.value;
  if (v === null) return '–';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  switch (c.fmt) {
    case 'int':
      return Number.isInteger(v) ? fmtInt(v) : String(v);
    case 'pct':
      return `${(v * 100).toFixed(2)}%`;
    case 'ratio4':
      return v.toFixed(4);
    default:
      return String(v);
  }
}

type Entry = Cell | string;

export class Table {
  readonly rows: Entry[][] = [];
  constructor(readonly headers: string[]) {}
  add(row: Entry[]): void {
    if (row.length !== this.headers.length) throw new ReportError(`row has ${row.length} cells, table has ${this.headers.length} columns`);
    this.rows.push(row);
  }
  cells(): Cell[] {
    return this.rows.flat().filter((e): e is Cell => typeof e !== 'string');
  }
  render(): string {
    const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const line = (xs: string[]): string => `| ${xs.map(esc).join(' | ')} |`;
    return [line(this.headers), `|${this.headers.map(() => '---').join('|')}|`, ...this.rows.map((r) => line(r.map((e) => (typeof e === 'string' ? e : fmtCell(e)))))].join('\n');
  }
}

// ---------------------------------------------------------------- inputs

/** bench/run-all.ts manifest.json: the full matrix at one code version (the report reads only these runKeys). */
export interface ManifestIn {
  codeVersion: string;
  cells: Array<{ system: string; scenario: string; window: string; tier: string; runKey: string }>;
}

/**
 * fuzz.json (benchmark component, bench/fuzz/run.ts, benchmark contract ; read when present). Fields used: chains; violations (a count, a list,
 * or {total}); coverage ({path: {share, min?, ok?}} or {path: share}); coverageOk / coverageMet (override the computed
 * verdict).
 */
export interface FuzzIn {
  chains?: number;
  violations?: number | unknown[] | { total?: number };
  coverage?: Record<string, number | { share: number; min?: number; ok?: boolean }>;
  coverageOk?: boolean;
  coverageMet?: boolean;
  [k: string]: unknown;
}

type LatDist = { n?: number; p50?: number | null; p90?: number | null; p99?: number | null; max?: number | null };
/**
 * latency.json (benchmark component, bench/latency.ts, benchmark contract ; read when present). Fields used: gate7 {p99 | p99Ms, n?} (p99 of
 * reqPath + respPath over class (a)); classes.<id> either a flat distribution or {n, overhead, engine, ...} with
 * distributions; class (a) is `a_steady` (or `a` / `steady`).
 */
export interface LatencyIn {
  gate7?: { p99Ms?: number; p99?: number; n?: number; pass?: boolean } | null;
  classes?: Record<string, LatDist & { overhead?: LatDist; engine?: LatDist; reqPath?: LatDist; respPath?: LatDist; [k: string]: unknown }>;
  [k: string]: unknown;
}

export const COVERAGE_MIN: Readonly<Record<string, number>> = {
  compact: 0.25, admission: 0.05, oversize: 0.05, slim: 0.02, impossible: 0.01, guardAny: 0.005, clamp: 0.01,
};

export function readJsonIf<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Keep the results the manifest lists; manifest cells without a results file become NOT RUN placeholders. */
export function applyManifest(all: readonly ResultsFile[], m: ManifestIn | null): ResultsFile[] {
  if (!m) return [...all];
  const keys = new Map(m.cells.map((c) => [c.runKey, c]));
  const have = all.filter((r) => keys.has(r.runKey));
  const got = new Set(have.map((r) => r.runKey));
  for (const c of m.cells) {
    if (got.has(c.runKey)) continue;
    have.push({
      schema: 1, runKey: c.runKey, status: 'not-run', reason: 'not run yet at this code version', versions: null as unknown as ResultsFile['versions'],
      system: c.system, systemLabel: c.system, scenario: c.scenario, family: hasScenario(c.scenario) ? familyOfSafe(c.scenario) : 'F?', window: c.window,
      tier: c.tier, configHash: '', config: {}, driver: null, metrics: null, facts: null, supersession: null, gates: {}, notes: [], perRequest: [], timing: null,
    });
  }
  return have;
}

function familyOfSafe(id: string): string {
  try {
    return familyOf(id);
  } catch {
    return 'F?';
  }
}

export function loadResults(dir: string): ResultsFile[] {
  if (!existsSync(dir)) return [];
  const out: ResultsFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || ['crosscheck.json', 'gates.json', 'manifest.json', 'fuzz.json', 'latency.json', 'run-all.json', 'BENCHMARKS.cells.json'].includes(name)) continue;
    const j = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<ResultsFile>;
    if (typeof j.runKey === 'string' && typeof j.system === 'string' && typeof j.scenario === 'string') out.push(j as ResultsFile);
  }
  return out;
}

const SYSTEM_ORDER = ['direct', 'opencode', 'opencode-sim', 'opencode-sim-compat', 'gobstopper-default', 'gobstopper-tuned', 'kitzur'];
const sysRank = (s: string): number => {
  const i = SYSTEM_ORDER.indexOf(s);
  return i >= 0 ? i : s.startsWith('kitzur') ? SYSTEM_ORDER.length + 1 : SYSTEM_ORDER.length;
};
const winRank = (w: string): number => ['100k', '64k', '32k', '128k'].indexOf(w);
const statusRank = (s: string): number => (s === 'ok' ? 0 : s === 'not-run' ? 1 : 2);

/** One results file per (system, scenario, window): ok > not-run > error, then the newest run, then the runKey. */
export function selectLatest(all: readonly ResultsFile[]): ResultsFile[] {
  const best = new Map<string, ResultsFile>();
  for (const r of all) {
    const k = `${r.system}\u0000${r.scenario}\u0000${r.window}`;
    const b = best.get(k);
    const newer = (x: ResultsFile, y: ResultsFile): boolean => {
      if (statusRank(x.status) !== statusRank(y.status)) return statusRank(x.status) < statusRank(y.status);
      const tx = x.timing?.startedAt ?? '';
      const ty = y.timing?.startedAt ?? '';
      if (tx !== ty) return tx > ty;
      return x.runKey > y.runKey;
    };
    if (!b || newer(r, b)) best.set(k, r);
  }
  return [...best.values()].sort(
    (a, b) =>
      famRank(a.family) - famRank(b.family) || (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : 0) ||
      winRank(a.window) - winRank(b.window) || sysRank(a.system) - sysRank(b.system) || (a.system < b.system ? -1 : a.system > b.system ? 1 : 0),
  );
}
const famRank = (f: string): number => Number(f.replace(/^F/, '')) || 99;

function find(rs: readonly ResultsFile[], system: string, scenario: string, window: string): ResultsFile | null {
  return rs.find((r) => r.system === system && r.scenario === scenario && r.window === window) ?? null;
}
const ok = (r: ResultsFile | null | undefined): r is ResultsFile & { metrics: RunMetrics } => !!r && r.status === 'ok' && !!r.metrics;

// ---------------------------------------------------------------- gates

export type GateStatus = 'PASS' | 'FAIL' | 'NOT RUN';
export interface GateResult {
  gate: GateId;
  status: GateStatus;
  gap: string | null;
  cause: string | null;
  reason: string | null;
  /** the runKeys the verdict was computed from */
  runKeys: string[];
  detail: string[];
}

const KITZUR = 'kitzur';

function notRun(gate: GateId, reason: string, runKeys: string[] = [], detail: string[] = []): GateResult {
  return { gate, status: 'NOT RUN', gap: null, cause: null, reason, runKeys, detail };
}
function fail(gate: GateId, gap: string, cause: string, runKeys: string[], detail: string[] = []): GateResult {
  return { gate, status: 'FAIL', gap, cause, reason: null, runKeys, detail };
}
function pass(gate: GateId, runKeys: string[], detail: string[] = []): GateResult {
  return { gate, status: 'PASS', gap: null, cause: null, reason: null, runKeys, detail };
}

interface CrossCheck {
  results?: Array<{ id: string; match?: Record<string, unknown>; ts?: Record<string, unknown>; py?: unknown }>;
}

/** §14 T0: every cross-check case matches, and the (a) assertions hold on the gobstopper-tuned qa46-ref 100k cell. */
function gateT0(rs: readonly ResultsFile[], xc: CrossCheck | null): GateResult {
  const detail: string[] = [];
  const keys: string[] = [];
  const a = find(rs, 'gobstopper-tuned', 'qa46-ref', '100k');
  let assertions: boolean | null = null;
  if (ok(a)) {
    keys.push(a.runKey);
    const m = a.metrics;
    const steps = JSON.stringify(m.compaction_steps);
    const checks: Array<[string, boolean]> = [
      [`generic compactions ${m.compactions_generic} at ${steps} (7 at [10,17,22,27,32,37,43])`, m.compactions_generic === 7 && steps === '[10,17,22,27,32,37,43]'],
      [`hit ${m.hit?.toFixed(4)} (0.8009)`, m.hit !== null && m.hit.toFixed(4) === '0.8009'],
      [`uncached ${m.uncached} (345,357)`, m.uncached === 345_357],
      [`fresh ${m.fresh} (315,423)`, m.fresh === 315_423],
    ];
    for (const [t, b] of checks) detail.push(`(a) ${b ? 'holds' : 'FAILS'}: ${t}`);
    assertions = checks.every(([, b]) => b);
  }
  const cases = xc?.results ?? [];
  const caseOk = (c: (typeof cases)[number]): boolean => {
    if ((c as { targets_met?: boolean }).targets_met === false) return false;
    if ((c as { skipped?: string }).skipped) return false;
    const m = c.match ?? {};
    const seqs = [...((m['sequences'] as Array<{ equal: boolean }> | undefined) ?? []), ...(m['count_sequence'] ? [m['count_sequence'] as { equal: boolean }] : [])];
    const flags = Object.entries(m).filter(([k, v]) => typeof v === 'boolean' && k !== 'python_skipped').map(([, v]) => v as boolean);
    const diffs = (m['summary_diffs'] as unknown[] | undefined) ?? [];
    return flags.every(Boolean) && seqs.every((s) => s.equal) && diffs.length === 0;
  };
  const have = new Set(cases.map((c) => c.id));
  const skipped = cases.filter((c) => (c as { skipped?: string }).skipped);
  const tsOnly = cases.filter((c) => !c.match && !(c as { skipped?: string }).skipped);
  for (const c of cases) detail.push(`case ${c.id}: ${(c as { skipped?: string }).skipped ? `skipped (${(c as { skipped?: string }).skipped})` : !c.match ? 'TS side only (no Python run)' : caseOk(c) ? 'matches' : 'MISMATCH'}`);
  const missing = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].filter((x) => !have.has(x));
  if (assertions === false) return fail('T0', 'the (a) generic-metric assertions', detail.filter((d) => d.includes('FAILS')).join('; '), keys, detail);
  const bad = cases.filter((c) => c.match && !caseOk(c));
  if (bad.length) return fail('T0', 'cross-check mismatch', bad.map((c) => c.id).join(', '), keys, detail);
  const tsBad = tsOnly.filter((c) => (c as { targets_met?: boolean }).targets_met === false);
  if (tsBad.length) return fail('T0', 'TS harness misses the evaluation numbers', tsBad.map((c) => c.id).join(', '), keys, detail);
  if (!xc) return notRun('T0', 'no crosscheck.json', keys, detail);
  if (skipped.length) return notRun('T0', `cross-check cases skipped: ${skipped.map((c) => c.id).join(', ')}`, keys, detail);
  if (tsOnly.length) return notRun('T0', `cases without the Python run: ${tsOnly.map((c) => c.id).join(', ')} (set KITZUR_REF_DIR)`, keys, detail);
  if (assertions === null) return notRun('T0', 'no gobstopper-tuned qa46-ref 100k cell for the (a) assertions', keys, detail);
  if (missing.length) return notRun('T0', `cross-check cases ${missing.join(', ')} are not implemented in crosscheck.json (a–e match, (a) assertions hold)`, keys, detail);
  return pass('T0', keys, detail);
}

const G1_EXCLUDED = new Set(['imp-tools', 'imp-sys']);

function leanCells(rs: readonly ResultsFile[], window: WindowId): ResultsFile[] {
  return rs.filter((r) => r.system === KITZUR && r.window === window);
}

function gateG1(rs: readonly ResultsFile[], window: WindowId = '100k', gate: GateId = 'G1', scenarios?: readonly string[]): GateResult {
  const cells = leanCells(rs, window).filter((r) => r.family !== 'F11' && (!scenarios || scenarios.includes(r.scenario)));
  // imp-tools / imp-sys are defined at 32k/8k only; the 100k gate includes them at their own window
  if (gate === 'G1' && window === '100k') cells.push(...rs.filter((r) => r.system === KITZUR && G1_EXCLUDED.has(r.scenario) && r.window !== window));
  if (!cells.length) return notRun(gate, `no ${KITZUR} results at ${window}`);
  const bad: string[] = [];
  const nr = cells.filter((r) => r.status !== 'ok');
  for (const r of cells.filter(ok)) {
    if (G1_EXCLUDED.has(r.scenario)) {
      // the client receives the documented 400 and the mock sees no request for that step (DESIGN.md)
      const e = (r.clientErrors ?? []).find((x) => x.status === 400 && (x.body ?? '').includes('kitzur_fixed_prompt_too_large'));
      if (!e) bad.push(`${r.scenario}: no kitzur_fixed_prompt_too_large 400 reached the client`);
      else if (r.perRequest.some((p) => p.kind === 'main' && p.session === e.session && p.step === e.step)) bad.push(`${r.scenario}: the mock saw a request for step ${e.step}`);
      continue;
    }
    if (!r.gates['G1']?.pass) bad.push(`${r.scenario}: ${r.gates['G1']?.detail ?? 'no G1 check'}`);
  }
  const keys = cells.map((r) => r.runKey);
  if (bad.length) return fail(gate, `${bad.length} scenario(s)`, bad.join('; '), keys);
  if (nr.length) return notRun(gate, `${nr.length} kitzur cell(s) not run: ${nr.map((r) => r.scenario).join(', ')}`, keys);
  return pass(gate, keys, [`${cells.length} scenarios`]);
}

const G2_SCENARIOS = ['qa46-ref', 'talk80-ref', 'qa46', 'talk80', 'cc60-oc'];

function gateG2(rs: readonly ResultsFile[], window: WindowId = '100k', gate: GateId = 'G2', scenarios: readonly string[] = G2_SCENARIOS): GateResult {
  const cells = scenarios.map((s) => find(rs, KITZUR, s, window));
  if (cells.every((c) => !c)) return notRun(gate, `no ${KITZUR} results at ${window}`);
  const keys = cells.filter((c): c is ResultsFile => !!c).map((c) => c.runKey);
  const bad: string[] = [];
  const missing: string[] = [];
  scenarios.forEach((s, i) => {
    const r = cells[i];
    if (!ok(r)) return void missing.push(s);
    const failed = (r.facts ?? []).filter((f) => f.gate && f.status !== 'pass');
    if (failed.length) bad.push(`${s}: ${failed.map((f) => `${f.id} ${f.status}`).join(', ')}`);
  });
  if (bad.length) return fail(gate, `${bad.length} scenario(s) with failing gated facts`, bad.join('; '), keys);
  if (missing.length) return notRun(gate, `missing ${missing.join(', ')}`, keys);
  return pass(gate, keys);
}

function comparatorFor(window: WindowId): string {
  // at 32k gobstopper tuned fails at step 3, so gates 3/4 compare against OpenCode mechanics (benchmark contract )
  return window === '32k' ? 'opencode-sim-compat' : 'gobstopper-tuned';
}

function gateG3(rs: readonly ResultsFile[], window: WindowId = '100k', gate: GateId = 'G3'): GateResult {
  const keys: string[] = [];
  const bad: string[] = [];
  const detail: string[] = [];
  let any = false;
  for (const s of ['qa46-ref', 'qa46']) {
    const L = find(rs, KITZUR, s, window);
    const cmpSys = s === 'qa46' && window === '32k' ? 'opencode' : comparatorFor(window);
    const G = find(rs, cmpSys, s, window);
    if (!ok(L) || !ok(G)) {
      detail.push(`${s}: ${!ok(L) ? 'kitzur' : cmpSys} not run`);
      continue;
    }
    any = true;
    keys.push(L.runKey, G.runKey);
    const lp = L.metrics.processed;
    const gp = G.metrics.processed;
    const d = `${s}: processed ${fmtInt(lp)} vs ${cmpSys} ${fmtInt(gp)} (${(((lp - gp) / gp) * 100).toFixed(1)}%)`;
    detail.push(d);
    if (lp > gp) bad.push(d);
  }
  if (!any) return notRun(gate, `no ${KITZUR} and comparator pair at ${window}`, keys, detail);
  if (bad.length) return fail(gate, bad.join('; '), 'above the comparator (a ≤ +10% exception needs the reason in the ablation table)', keys, detail);
  if (detail.some((d) => d.includes('not run'))) return notRun(gate, detail.filter((d) => d.includes('not run')).join('; '), keys, detail);
  return pass(gate, keys, detail);
}

function gateG4(rs: readonly ResultsFile[], window: WindowId = '100k', gate: GateId = 'G4'): GateResult {
  const keys: string[] = [];
  const bad: string[] = [];
  const detail: string[] = [];
  let any = false;
  for (const s of ['qa46-ref', 'qa46']) {
    const L = find(rs, KITZUR, s, window);
    const cmp = window === '32k' ? 'opencode' : 'gobstopper-tuned';
    const G = find(rs, cmp, s, window);
    if (!ok(L) || !ok(G) || L.metrics.hit === null || G.metrics.hit === null) {
      detail.push(`${s}: ${!ok(L) ? 'kitzur' : cmp} not run (or no bodies)`);
      continue;
    }
    any = true;
    keys.push(L.runKey, G.runKey);
    const lm = L.metrics;
    const gm = G.metrics;
    let d = `${s}: hit ${(lm.hit! * 100).toFixed(2)}% vs ${(gm.hit! * 100).toFixed(2)}%; uncached ${fmtInt(lm.uncached!)} vs ${fmtInt(gm.uncached!)}; L ${fmtInt(lm.L!)} vs ${fmtInt(gm.L!)}; reusable ${(lm.reusable! * 100).toFixed(2)}% vs ${(gm.reusable! * 100).toFixed(2)}%`;
    // the OpenCode client's hit covers its accepted requests only: the new tool outputs it first sends in rejected
    // requests are summarized away (2,000-char cut) and never reach an accepted one
    if (cmp === 'opencode' && gm.rejections) d += ` (the comparator's ${gm.rejections} rejected requests, ${fmtInt(gm.rejected)} tokens, ${fmtInt(gm.processed)} processed vs ${fmtInt(lm.processed)}, are outside its hit)`;
    detail.push(d);
    if (lm.hit! < gm.hit!) {
      const cheaper = lm.uncached! <= gm.uncached! && lm.reusable! >= gm.reusable!;
      bad.push(`${d}${cheaper ? ' (uncached and reusable beat the comparator: the ratio alone misses, )' : ''}`);
    }
  }
  if (!any) return notRun(gate, `no ${KITZUR} and comparator pair at ${window}`, keys, detail);
  if (bad.length) return fail(gate, bad.join('; '), 'hit ratio below the comparator', keys, detail);
  if (detail.some((d) => d.includes('not run'))) return notRun(gate, detail.filter((d) => d.includes('not run')).join('; '), keys, detail);
  return pass(gate, keys, detail);
}

function gateG5(rs: readonly ResultsFile[], window: WindowId = '100k', gate: GateId = 'G5'): GateResult {
  const r = find(rs, KITZUR, 'huge180k', window);
  if (!r) return notRun(gate, `no ${KITZUR} huge180k result at ${window}`);
  if (!ok(r)) return notRun(gate, `huge180k ${r.status}: ${r.reason ?? ''}`, [r.runKey]);
  const m = r.metrics;
  if (m.client_errors === 0 && m.steps_ok === m.steps) return pass(gate, [r.runKey]);
  return fail(gate, `${m.client_errors} client errors, ${m.steps_ok}/${m.steps} steps`, JSON.stringify(m.client_error_kinds), [r.runKey]);
}

function gateG6(rs: readonly ResultsFile[], window: WindowId = '100k', gate: GateId = 'G6', styles: readonly string[] = CONFIGURED_STYLES): GateResult {
  const ids = styles.flatMap((s) => [`err-${s}`, `err-${s}-hidden`]).filter((id) => hasScenario(id));
  const cells = ids.map((id) => find(rs, KITZUR, id, window));
  if (cells.every((c) => !c)) return notRun(gate, `no ${KITZUR} F11 results at ${window}`);
  const keys = cells.filter((c): c is ResultsFile => !!c).map((c) => c.runKey);
  const bad: string[] = [];
  const missing: string[] = [];
  ids.forEach((id, i) => {
    const r = cells[i];
    if (!ok(r)) return void missing.push(id);
    if (!r.gates['G6']?.pass) bad.push(`${id}: ${r.gates['G6']?.detail ?? 'no check'}`);
  });
  const u = find(rs, KITZUR, 'err-unknown400', window);
  if (ok(u) && (u.metrics.max_attempts > 2 || !u.metrics.retry_monotone)) bad.push(`err-unknown400: attempts ${u.metrics.max_attempts}, monotone ${u.metrics.retry_monotone}`);
  if (bad.length) return fail(gate, `${bad.length} style cell(s)`, bad.join('; '), keys);
  if (missing.length) return notRun(gate, `missing ${missing.join(', ')}`, keys);
  return pass(gate, keys);
}

function gateG8(rs: readonly ResultsFile[]): GateResult {
  const parts: GateResult[] = [];
  const g8 = (w: WindowId): string[] => {
    const set = ['qa46-ref', 'qa46', 'qa150', 'talk80-ref', 'talk80', 'talk200', 'huge150k', 'huge180k', 'huge400k', 'huge400k-cap51200', 'huge180k-test', 'huge180k-user', 'corr60', 'rs46-sigterm', 'rs46-sigkill', 'rs46-freshstate'];
    return set.filter((s) => rs.some((r) => r.system === KITZUR && r.scenario === s && r.window === w));
  };
  for (const w of ['32k', '64k'] as WindowId[]) {
    parts.push(gateG1(rs, w, 'G8', g8(w)));
    parts.push(gateG2(rs, w, 'G8', ['qa46-ref', 'talk80-ref', 'qa46', 'talk80']));
    parts.push(gateG3(rs, w, 'G8'));
    parts.push(gateG4(rs, w, 'G8'));
    parts.push(gateG5(rs, w, 'G8'));
    parts.push(gateG6(rs, w, 'G8', G8_STYLES));
  }
  const keys = [...new Set(parts.flatMap((p) => p.runKeys))];
  const detail = parts.map((p) => `${p.status}${p.reason ? ` (${p.reason})` : ''}${p.gap ? ` gap: ${p.gap}` : ''}`);
  if (parts.some((p) => p.status === 'FAIL')) return fail('G8', parts.filter((p) => p.status === 'FAIL').map((p) => p.gap).join('; '), parts.filter((p) => p.status === 'FAIL').map((p) => p.cause).join('; '), keys, detail);
  if (parts.some((p) => p.status === 'NOT RUN')) return notRun('G8', `no complete ${KITZUR} G8 set at 32k/64k`, keys, detail);
  return pass('G8', keys, detail);
}

/** I5: the canonical upstream bodies of the restart variants equal the control's, request by request. */
export function divergence(run: ResultsFile, control: ResultsFile): number {
  const key = (p: ResultsFile['perRequest'][number]): string => `${p.session}\u0000${p.step}\u0000${p.kind}\u0000${p.attempt}`;
  const c = new Map(control.perRequest.map((p) => [key(p), p.msgsDigest]));
  let n = 0;
  for (const p of run.perRequest) if (c.get(key(p)) !== p.msgsDigest) n++;
  n += Math.max(0, control.perRequest.length - run.perRequest.length);
  return n;
}

function gateI5(rs: readonly ResultsFile[]): GateResult {
  const keys: string[] = [];
  const detail: string[] = [];
  const bad: string[] = [];
  let any = false;
  for (const w of ['100k', '64k', '32k'] as WindowId[]) {
    const ctl = find(rs, KITZUR, 'qa46', w);
    for (const s of ['rs46-sigterm', 'rs46-sigkill']) {
      const r = find(rs, KITZUR, s, w);
      if (!ok(r) || !ok(ctl)) continue;
      any = true;
      keys.push(r.runKey, ctl.runKey);
      const d = divergence(r, ctl);
      detail.push(`${s} @${w}: divergence ${d}`);
      if (d) bad.push(`${s} @${w}: ${d}`);
    }
  }
  if (!any) return notRun('I5', `no ${KITZUR} restart results with their qa46 control`);
  if (bad.length) return fail('I5', bad.join('; '), 'requests whose canonical upstream body differs from the control', keys, detail);
  return pass('I5', keys, detail);
}

/** G7 (benchmark contract ): p99 of reqPath + respPath over class (a) below 100 ms, n ≥ 500. */
export function gateG7(lat: LatencyIn | null): GateResult {
  if (!lat) return notRun('G7', 'no results/latency.json (the latency phase, bench/latency.ts, benchmark component)');
  const g = lat.gate7 ?? undefined;
  const a = lat.classes?.['a_steady'] ?? lat.classes?.['a'] ?? lat.classes?.['steady'];
  const p99 = g?.p99Ms ?? g?.p99 ?? a?.overhead?.p99 ?? a?.p99 ?? null;
  const n = g?.n ?? a?.overhead?.n ?? a?.n ?? null;
  if (p99 === null || p99 === undefined) return notRun('G7', 'latency.json has no class (a) p99 (gate7.p99 or classes.a_steady.overhead.p99)');
  const d = `class (a) p99 reqPath+respPath ${p99} ms over n = ${n ?? '?'}`;
  if (n !== null && n < 500) return fail('G7', `n = ${n} < 500`, 'too few samples for a p99', ['latency.json'], [d]);
  if (p99 >= 100) return fail('G7', `p99 ${p99} ms ≥ 100 ms`, 'request-path latency above the gate', ['latency.json'], [d]);
  return pass('G7', ['latency.json'], [d]);
}

/** G9 (benchmark contract ): ≥ 10,000 chains, 0 invariant violations, every coverage minimum met. */
export function gateG9(fz: FuzzIn | null): GateResult {
  if (!fz) return notRun('G9', 'no results/fuzz.json (the fuzz suite, bench/fuzz, benchmark component)');
  const chains = typeof fz.chains === 'number' ? fz.chains : null;
  const v = fz.violations;
  const viol = Array.isArray(v) ? v.length : typeof v === 'number' ? v : v && typeof v === 'object' && typeof v.total === 'number' ? v.total : null;
  const detail: string[] = [`chains ${chains ?? '?'}`, `violations ${viol ?? '?'}`];
  const under: string[] = [];
  for (const [k, x] of Object.entries(fz.coverage ?? {})) {
    const share = typeof x === 'number' ? x : x.share;
    const min = typeof x === 'number' ? COVERAGE_MIN[k] : (x.min ?? COVERAGE_MIN[k]);
    detail.push(`${k} ${(share * 100).toFixed(2)}%${min !== undefined ? ` (min ${(min * 100).toFixed(1)}%)` : ''}`);
    if (min !== undefined && share < min) under.push(k);
  }
  const missingPaths = fz.coverage ? Object.keys(COVERAGE_MIN).filter((k) => !(k in fz.coverage!)) : Object.keys(COVERAGE_MIN);
  const coverageMet = fz.coverageOk ?? fz.coverageMet ?? (under.length === 0 && missingPaths.length === 0);
  if (chains === null || viol === null) return notRun('G9', 'fuzz.json lacks chains / violations', ['fuzz.json'], detail);
  const bad: string[] = [];
  if (chains < 10_000) bad.push(`${chains} chains < 10,000`);
  if (viol > 0) bad.push(`${viol} invariant violation(s)`);
  if (!coverageMet) bad.push(`coverage minimums unmet: ${[...under, ...missingPaths.map((m) => `${m} (not reported)`)].join(', ') || 'coverageOk=false'}`);
  if (bad.length) return fail('G9', bad.join('; '), 'see fuzz.json', ['fuzz.json'], detail);
  return pass('G9', ['fuzz.json'], detail);
}

export function computeGates(rs: readonly ResultsFile[], xc: CrossCheck | null, fz: FuzzIn | null = null, lat: LatencyIn | null = null): GateResult[] {
  return [
    gateT0(rs, xc),
    gateG1(rs),
    gateG2(rs),
    gateG3(rs),
    gateG4(rs),
    gateG5(rs),
    gateG6(rs),
    gateG7(lat),
    gateG8(rs),
    gateG9(fz),
    gateI5(rs),
  ];
}

// ---------------------------------------------------------------- tables

const SPEC17 = 'bench/README.md';

interface PreReg {
  label: string;
  system: string;
  scenario: string;
  window: WindowId;
  tokens: number | null;
  failedAt?: number;
  compactions: number | null;
  steps?: number[];
  hit: number | null;
  uncached?: number;
  fresh?: number;
  L?: number;
  reusable?: number;
}

/** The pre-registered MEASURED numbers (§4, §17) that the non-kitzur systems must reproduce. */
export const PRE_REGISTERED: readonly PreReg[] = [
  { label: 'gobstopper tuned 100k', system: 'gobstopper-tuned', scenario: 'qa46-ref', window: '100k', tokens: 1_734_118, compactions: 7, steps: [10, 17, 22, 27, 32, 37, 43], hit: 0.8009, uncached: 345_346, fresh: 315_413, L: 29_933, reusable: 0.9789 },
  { label: 'gobstopper tuned 64k (41,000)', system: 'gobstopper-tuned', scenario: 'qa46-ref', window: '64k', tokens: 1_457_614, compactions: 14, hit: 0.7149 },
  { label: 'gobstopper tuned 32k (20,500)', system: 'gobstopper-tuned', scenario: 'qa46-ref', window: '32k', tokens: null, failedAt: 3, compactions: null, hit: null },
  { label: 'gobstopper tuned Talk-80 100k', system: 'gobstopper-tuned', scenario: 'talk80-ref', window: '100k', tokens: 3_347_391, compactions: 14, hit: null },
  { label: 'OpenCode mechanics 100k', system: 'opencode-sim-compat', scenario: 'qa46-ref', window: '100k', tokens: 2_492_784, compactions: 6, hit: null },
  { label: 'OpenCode mechanics 64k', system: 'opencode-sim-compat', scenario: 'qa46-ref', window: '64k', tokens: 1_627_470, compactions: 7, hit: null },
  { label: 'OpenCode mechanics 32k', system: 'opencode-sim-compat', scenario: 'qa46-ref', window: '32k', tokens: 1_104_045, compactions: 17, hit: null },
  { label: 'OpenCode mechanics 100k, long Continue', system: 'opencode-sim', scenario: 'qa46-ref', window: '100k', tokens: 2_495_544, compactions: 6, hit: null },
];

function preRegisteredTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['row', 'window', 'tokens (pre-registered)', 'tokens (measured)', 'compactions (pre-reg.)', 'compactions (measured, reported)', 'hit (pre-reg.)', 'hit (measured)', 'match', 'run']);
  for (const p of PRE_REGISTERED) {
    const r = find(rs, p.system, p.scenario, p.window);
    const pre = (v: number | null, fmt: Fmt = 'int'): Cell => cell(v, 'READ', v === null ? null : SPEC17, fmt);
    if (!ok(r)) {
      t.add([p.label, windowLabel(WINDOWS[p.window]), pre(p.tokens), r ? `NOT RUN (${r.reason ?? r.status})` : 'NOT RUN (no result)', pre(p.compactions), '–', pre(p.hit, 'pct'), '–', '–', r ? r.runKey.slice(0, 12) : '–']);
      continue;
    }
    const m = r.metrics;
    const failed = m.failed_at && m.steps_ok < m.steps;
    const tokOk = p.failedAt !== undefined ? !!failed && m.failed_at!.step === p.failedAt : m.processed === p.tokens;
    const compOk = p.compactions === null || (m.compactions_reported ?? m.compactions_generic) === p.compactions;
    const hitOk = p.hit === null || (m.hit !== null && Math.abs(m.hit - p.hit) < 5e-5);
    const extra = p.uncached !== undefined ? m.uncached === p.uncached && m.fresh === p.fresh && m.L === p.L : true;
    t.add([
      p.label, windowLabel(WINDOWS[p.window]),
      p.failedAt !== undefined ? `failed at step ${p.failedAt}` : pre(p.tokens),
      failed && p.failedAt !== undefined ? cell(`failed at step ${m.failed_at!.step}`, 'MEASURED', ptr(r, 'metrics/failed_at'), 'text') : cell(m.processed, 'MEASURED', ptr(r, 'metrics/processed')),
      pre(p.compactions),
      cell(m.compactions_reported ?? m.compactions_generic, 'MEASURED', ptr(r, 'metrics/compactions_reported')),
      pre(p.hit, 'pct'),
      cell(m.hit, 'MEASURED', m.hit === null ? null : ptr(r, 'metrics/hit'), 'pct'),
      tokOk && compOk && hitOk && extra ? 'yes' : 'NO',
      r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

function prefixTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['system', 'scenario', 'window', 'hit', 'Σ LCP', 'uncached', 'fresh', 'fresh (synthesized)', 'L', 'reusable', 'hit_block16', 'hit_global', 'template breaks', 'run']);
  for (const r of rs) {
    if (!ok(r) || r.metrics.hit === null) continue;
    const m = r.metrics;
    t.add([
      r.system, r.scenario, windowLabel(WINDOWS[r.window as WindowId]),
      cell(m.hit, 'MEASURED', ptr(r, 'metrics/hit'), 'pct'), cell(m.lcp, 'MEASURED', ptr(r, 'metrics/lcp')),
      cell(m.uncached, 'MEASURED', ptr(r, 'metrics/uncached')), cell(m.fresh, 'MEASURED', ptr(r, 'metrics/fresh')),
      cell(m.fresh_synth, 'MEASURED', ptr(r, 'metrics/fresh_synth')), cell(m.L, 'MEASURED', ptr(r, 'metrics/L')),
      cell(m.reusable, 'MEASURED', ptr(r, 'metrics/reusable'), 'pct'), cell(m.hit_block16, 'MEASURED', ptr(r, 'metrics/hit_block16'), 'pct'),
      cell(m.hit_global, 'MEASURED', m.hit_global === null ? null : ptr(r, 'metrics/hit_global'), 'pct'),
      cell(m.template_breaks, 'MEASURED', ptr(r, 'metrics/template_breaks')), r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

/** The rows every table carries (benchmark contract ); kitzur rows come from a later wave. */
export const EXPECTED_SYSTEMS: ReadonlyArray<{ id: string; label: string; applies: (scenario: string, window: string) => boolean }> = [
  { id: 'direct', label: 'direct', applies: () => true },
  { id: 'opencode', label: 'OpenCode client, direct', applies: () => true },
  { id: 'opencode-sim', label: 'OpenCode mechanics (offline)', applies: (s) => s === 'qa46-ref' || s === 'talk80-ref' },
  { id: 'gobstopper-default', label: 'gobstopper defaults', applies: (_s, w) => w === '100k' },
  { id: 'gobstopper-tuned', label: 'gobstopper tuned', applies: () => true },
  { id: 'kitzur', label: 'kitzur', applies: () => true },
  { id: 'opencode-kitzur', label: 'OpenCode client through kitzur', applies: () => true },
];

/** Placeholder rows for the expected systems that have no results file for a (scenario, window). */
function withExpectedRows(rs: readonly ResultsFile[]): Array<ResultsFile | { missing: true; system: string; scenario: string }> {
  const out: Array<ResultsFile | { missing: true; system: string; scenario: string }> = [];
  const scenarios = [...new Set(rs.map((r) => r.scenario))];
  for (const sc of scenarios) {
    const here = rs.filter((r) => r.scenario === sc);
    const w = here[0]!.window;
    for (const e of EXPECTED_SYSTEMS) if (e.applies(sc, w) && !here.some((r) => r.system === e.id)) out.push({ missing: true, system: e.id, scenario: sc });
    out.push(...here);
  }
  return out;
}

function familyTable(rs: readonly ResultsFile[]): Table {
  const t = new Table([
    'scenario', 'system', 'steps ok', 'client errors', 'rejections (tokens)', 'processed', 'main accepted', 'summarizer+title',
    'compactions (generic / reported)', 'b2b', 'client compactions', 'peak (hard)', 'hit', 'uncached', 'gated facts', 'run',
  ]);
  const rows = withExpectedRows(rs).sort((a, b) => (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : sysRank(a.system) - sysRank(b.system)));
  for (const r of rows) {
    if ('missing' in r) {
      t.add([r.scenario, r.system, 'NOT RUN: no results file', '', '', '', '', '', '', '', '', '', '', '', '', '–']);
      continue;
    }
    if (!ok(r)) {
      t.add([r.scenario, r.system, r.status === 'error' ? `ERROR: ${(r.reason ?? '').slice(0, 80)}` : `NOT RUN: ${(r.reason ?? '').slice(0, 80)}`, '', '', '', '', '', '', '', '', '', '', '', '', r.runKey.slice(0, 12)]);
      continue;
    }
    const m = r.metrics;
    const gated = (r.facts ?? []).filter((f) => f.gate);
    const oc = r.system.startsWith('opencode');
    t.add([
      r.scenario, r.system,
      cell(`${m.steps_ok}/${m.steps}`, 'MEASURED', ptr(r, 'metrics/steps_ok'), 'text'),
      cell(m.client_errors, 'MEASURED', ptr(r, 'metrics/client_errors')),
      cell(`${fmtInt(m.rejections)} (${fmtInt(m.rejected)})`, 'MEASURED', ptr(r, 'metrics/rejected'), 'text'),
      cell(m.processed, 'MEASURED', ptr(r, 'metrics/processed')),
      cell(m.processed_main_accepted, 'MEASURED', ptr(r, 'metrics/processed_main_accepted')),
      cell(m.processed_aux, 'MEASURED', ptr(r, 'metrics/processed_aux')),
      cell(`${m.compactions_generic} / ${m.compactions_reported ?? '–'}`, 'MEASURED', ptr(r, 'metrics/compactions_generic'), 'text'),
      cell(m.b2b, 'MEASURED', ptr(r, 'metrics/b2b')),
      cell(m.client_compactions, 'MEASURED', ptr(r, 'metrics/client_compactions')),
      cell(`${fmtInt(m.peak)} (${fmtInt(m.hard)})`, 'MEASURED', ptr(r, 'metrics/peak'), 'text'),
      cell(m.hit, 'MEASURED', m.hit === null ? null : ptr(r, 'metrics/hit'), 'pct'),
      cell(m.uncached, 'MEASURED', m.uncached === null ? null : ptr(r, 'metrics/uncached')),
      r.facts === null ? '–' : cell(`${gated.filter((f) => f.status === 'pass').length}/${gated.length}${oc ? ' [INFERRED]' : ''}`, oc ? 'INFERRED' : 'MEASURED', ptr(r, 'facts'), 'text'),
      r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

function factsTable(rs: readonly ResultsFile[], scenario: string, window: string): Table | null {
  const cells = rs.filter((r) => r.scenario === scenario && r.window === window && ok(r) && r.facts);
  if (!cells.length) return null;
  const facts = cells[0]!.facts!;
  const t = new Table(['fact', 'channel', 'expect', 'gated', ...cells.map((r) => r.system)]);
  for (const f of facts) {
    t.add([
      `\`${f.id}\``, f.channel, f.expect, f.gate ? 'yes' : 'no',
      ...cells.map((r): Entry => {
        const x = r.facts!.find((y) => y.id === f.id);
        if (!x) return '–';
        const extra = x.status === 'fail' ? (x.revivedAt !== null ? ` (revived @${x.revivedAt})` : x.resurfacedAt !== null ? ` (resurfaced @${x.resurfacedAt})` : x.missing.length ? ` (missing @${x.missing[0]})` : '') : '';
        return cell(`${x.status}${extra}`, r.system.startsWith('opencode') ? 'INFERRED' : 'MEASURED', ptr(r, `facts/${r.facts!.indexOf(x)}`), 'text');
      }),
    ]);
  }
  return t;
}

function supersessionTable(rs: readonly ResultsFile[]): Table | null {
  const cells = rs.filter((r) => ok(r) && r.supersession);
  if (!cells.length) return null;
  const t = new Table(['system', 'window', 'true', 'missed', 'false', 'not exercised', 'kept', 'not planted', 'run']);
  for (const r of cells) {
    const c = r.supersession!.counts;
    const m = (k: string): Cell => cell(c[k] ?? 0, 'MEASURED', ptr(r, `supersession/counts/${k}`));
    t.add([r.system, windowLabel(WINDOWS[r.window as WindowId]), m('true'), m('missed'), m('false'), m('not-exercised'), m('kept'), m('not-planted'), r.runKey.slice(0, 12)]);
  }
  return t;
}

// ---------------------------------------------------------------- comparison tables (B1)

const pctDelta = (a: number, b: number): string => `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%`;
const gatedFacts = (r: ResultsFile): string => {
  const g = (r.facts ?? []).filter((f) => f.gate);
  return g.length ? `${g.filter((f) => f.status === 'pass').length}/${g.length}` : '–';
};

/** Headline: kitzur against gobstopper tuned and the OpenCode baselines, per window, on the reference sessions. */
function headlineTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['window', 'scenario', 'system', 'steps ok', 'client errors', 'processed', 'vs kitzur', 'compactions (generic / reported)', 'peak', 'hit', 'uncached', 'gated facts', 'run']);
  const systems = ['kitzur', 'gobstopper-tuned', 'opencode', 'opencode-sim-compat', 'opencode-kitzur'];
  for (const w of ['100k', '64k', '32k', '128k'] as WindowId[]) {
    for (const sc of ['qa46-ref', 'qa46', 'talk80-ref', 'talk80']) {
      const L = find(rs, KITZUR, sc, w);
      for (const sys of systems) {
        const r = find(rs, sys, sc, w);
        if (!r) continue;
        if (!ok(r)) {
          t.add([windowLabel(WINDOWS[w]), sc, sys, `${r.status === 'error' ? 'ERROR' : 'NOT RUN'}: ${(r.reason ?? '').slice(0, 60)}`, '', '', '', '', '', '', '', '', r.runKey.slice(0, 12)]);
          continue;
        }
        const m = r.metrics;
        t.add([
          windowLabel(WINDOWS[w]), sc, sys,
          cell(`${m.steps_ok}/${m.steps}`, 'MEASURED', ptr(r, 'metrics/steps_ok'), 'text'),
          cell(m.client_errors, 'MEASURED', ptr(r, 'metrics/client_errors')),
          cell(m.processed, 'MEASURED', ptr(r, 'metrics/processed')),
          ok(L) && sys !== KITZUR ? cell(pctDelta(m.processed, L.metrics.processed), 'MEASURED', ptr(r, 'metrics/processed'), 'text') : '–',
          cell(`${m.compactions_generic} / ${m.compactions_reported ?? '–'}`, 'MEASURED', ptr(r, 'metrics/compactions_generic'), 'text'),
          cell(m.peak, 'MEASURED', ptr(r, 'metrics/peak')),
          cell(m.hit, 'MEASURED', m.hit === null ? null : ptr(r, 'metrics/hit'), 'pct'),
          cell(m.uncached, 'MEASURED', m.uncached === null ? null : ptr(r, 'metrics/uncached')),
          r.facts === null ? '–' : cell(gatedFacts(r), r.system.startsWith('opencode') ? 'INFERRED' : 'MEASURED', ptr(r, 'facts'), 'text'),
          r.runKey.slice(0, 12),
        ]);
      }
    }
  }
  return t;
}

/** §17 kitzur MODEL predictions next to the measured kitzur runs. */
const LEAN_MODEL: ReadonlyArray<{ scenario: string; window: WindowId; tokens: number; compactions: number; hit: number; uncached: number | null }> = [
  { scenario: 'qa46-ref', window: '100k', tokens: 1_715_087, compactions: 7, hit: 0.8064, uncached: 332_101 },
  { scenario: 'qa46-ref', window: '64k', tokens: 1_268_109, compactions: 13, hit: 0.7498, uncached: 317_223 },
  { scenario: 'qa46-ref', window: '32k', tokens: 790_067, compactions: 18, hit: 0.7839, uncached: 170_741 },
  { scenario: 'qa46-ref', window: '128k', tokens: 2_291_984, compactions: 4, hit: 0.8559, uncached: 330_330 },
  { scenario: 'talk80-ref', window: '100k', tokens: 3_078_152, compactions: 12, hit: 0.8157, uncached: null },
  { scenario: 'talk80-ref', window: '64k', tokens: 2_326_161, compactions: 22, hit: 0.7656, uncached: null },
  { scenario: 'talk80-ref', window: '32k', tokens: 1_381_517, compactions: 33, hit: 0.7825, uncached: null },
];

function leanModelTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['scenario', 'window', 'tokens (MODEL)', 'tokens (measured)', 'compactions (MODEL)', 'compactions (measured)', 'hit (MODEL)', 'hit (measured)', 'uncached (MODEL)', 'uncached (measured)', 'run']);
  for (const p of LEAN_MODEL) {
    const r = find(rs, KITZUR, p.scenario, p.window);
    const mdl = (v: number | null, fmt: Fmt = 'int'): Cell => cell(v, 'MODEL', v === null ? null : SPEC17, fmt);
    if (!ok(r)) {
      t.add([p.scenario, windowLabel(WINDOWS[p.window]), mdl(p.tokens), r ? `NOT RUN (${r.reason ?? r.status})` : 'NOT RUN', mdl(p.compactions), '–', mdl(p.hit, 'pct'), '–', mdl(p.uncached), '–', '–']);
      continue;
    }
    const m = r.metrics;
    t.add([
      p.scenario, windowLabel(WINDOWS[p.window]), mdl(p.tokens), cell(m.processed, 'MEASURED', ptr(r, 'metrics/processed')), mdl(p.compactions),
      cell(m.compactions_generic, 'MEASURED', ptr(r, 'metrics/compactions_generic')), mdl(p.hit, 'pct'), cell(m.hit, 'MEASURED', m.hit === null ? null : ptr(r, 'metrics/hit'), 'pct'),
      mdl(p.uncached), cell(m.uncached, 'MEASURED', m.uncached === null ? null : ptr(r, 'metrics/uncached')), r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

const ABL_CELLS: ReadonlyArray<[string, WindowId]> = [
  ['qa46-ref', '100k'], ['talk80', '100k'], ['huge180k', '100k'], ['rs46', '100k'], ['qa46-ref', '32k'], ['talk80', '32k'], ['huge180k', '32k'], ['rs46', '32k'],
];

/** benchmark contract : every ablation against kitzur default, per (scenario, window): processed (Δ), hit, steps, gated facts. */
function ablationTable(rs: readonly ResultsFile[], ablations: ReadonlyArray<{ id: string; label: string }>): Table {
  const t = new Table(['system', 'change', ...ABL_CELLS.map(([s, w]) => `${s} @${w}`)]);
  for (const a of [{ id: KITZUR, label: 'kitzur default' }, ...ablations]) {
    const row: Entry[] = [a.id, a.label];
    for (const [sc, w] of ABL_CELLS) {
      const r = find(rs, a.id, sc, w);
      const base = find(rs, KITZUR, sc, w);
      if (!r) {
        row.push('–');
        continue;
      }
      if (!ok(r)) {
        row.push(r.status === 'error' ? 'ERROR' : 'NOT RUN');
        continue;
      }
      const m = r.metrics;
      const d = a.id !== KITZUR && ok(base) ? ` (${pctDelta(m.processed, base.metrics.processed)})` : '';
      const err = m.client_errors ? `, ${m.client_errors} err` : '';
      row.push(cell(`${fmtInt(m.processed)}${d}; hit ${m.hit === null ? '–' : (m.hit * 100).toFixed(1) + '%'}; ${m.steps_ok}/${m.steps}${err}; facts ${gatedFacts(r)}; ${m.compactions_generic}c`, 'MEASURED', ptr(r, 'metrics/processed'), 'text'));
    }
    t.add(row);
  }
  return t;
}

export interface SweepRow {
  r: ResultsFile;
  trigger: number;
  target: number;
  summary: number;
  eligible: boolean;
  why: string[];
}

/** benchmark contract selection: minimise uncached s.t. processed ≤ gob tuned, hit ≥ gob tuned, b2b = 0, all facts. */
export function sweepRows(rs: readonly ResultsFile[], scenario: string, window: WindowId): { rows: SweepRow[]; selected: SweepRow | null; gob: ResultsFile | null } {
  const gob = find(rs, 'gobstopper-tuned', scenario, window);
  const rows: SweepRow[] = [];
  for (const r of rs) {
    if (!r.system.startsWith('kitzur-sweep-') || r.scenario !== scenario || r.window !== window || !ok(r)) continue;
    const set = ((r.config as { set?: Record<string, number> }).set ?? {});
    const m = r.metrics;
    const why: string[] = [];
    if (ok(gob) && m.processed > gob.metrics.processed) why.push('processed > gob');
    if (ok(gob) && (m.hit ?? 0) < (gob.metrics.hit ?? 0)) why.push('hit < gob');
    if (m.b2b) why.push('b2b');
    if ((r.facts ?? []).some((f) => f.gate && f.status !== 'pass')) why.push('facts');
    if (m.client_errors || m.steps_ok !== m.steps) why.push('errors');
    rows.push({ r, trigger: set['compaction.triggerFraction'] ?? NaN, target: set['compaction.targetFraction'] ?? NaN, summary: set['compaction.summaryFraction'] ?? NaN, eligible: why.length === 0 && ok(gob), why });
  }
  rows.sort((a, b) => a.trigger - b.trigger || a.target - b.target || a.summary - b.summary);
  const el = rows.filter((x) => x.eligible).sort((a, b) => (a.r.metrics!.uncached ?? Infinity) - (b.r.metrics!.uncached ?? Infinity) || a.r.metrics!.processed - b.r.metrics!.processed);
  return { rows, selected: el[0] ?? null, gob };
}

function sweepTable(sw: ReturnType<typeof sweepRows>): Table {
  const t = new Table(['triggerFraction', 'targetFraction', 'summaryFraction', 'processed', 'hit', 'uncached', 'compactions', 'b2b', 'peak', 'gated facts', 'eligible (§9)', 'run']);
  for (const x of sw.rows) {
    const r = x.r;
    const m = r.metrics!;
    t.add([
      String(x.trigger), String(x.target), String(x.summary), cell(m.processed, 'MEASURED', ptr(r, 'metrics/processed')),
      cell(m.hit, 'MEASURED', m.hit === null ? null : ptr(r, 'metrics/hit'), 'pct'), cell(m.uncached, 'MEASURED', m.uncached === null ? null : ptr(r, 'metrics/uncached')),
      cell(m.compactions_generic, 'MEASURED', ptr(r, 'metrics/compactions_generic')), cell(m.b2b, 'MEASURED', ptr(r, 'metrics/b2b')), cell(m.peak, 'MEASURED', ptr(r, 'metrics/peak')),
      cell(gatedFacts(r), 'MEASURED', ptr(r, 'facts'), 'text'), x === sw.selected ? '**selected**' : x.eligible ? 'yes' : `no (${x.why.join(', ')})`, r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

/** F13 / I5: divergence of each restart run from the same system's qa46 control at the same window. */
function restartTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['system', 'window', 'scenario', 'steps ok', 'processed', 'divergence vs qa46 control', 'run']);
  for (const r of rs) {
    if (r.family !== 'F13' || !ok(r)) continue;
    const ctl = find(rs, r.system, 'qa46', r.window);
    t.add([
      r.system, windowLabel(WINDOWS[r.window as WindowId]), r.scenario, cell(`${r.metrics.steps_ok}/${r.metrics.steps}`, 'MEASURED', ptr(r, 'metrics/steps_ok'), 'text'),
      cell(r.metrics.processed, 'MEASURED', ptr(r, 'metrics/processed')),
      ok(ctl) ? cell(divergence(r, ctl), 'MEASURED', ptr(r, 'perRequest')) : 'no control',
      r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

/** F8: each session of il3x46 / il3x46-conc against its solo run (benchmark contract : canonically equal upstream bodies). */
function interleaveTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['system', 'scenario', 'session', 'requests', 'divergence vs solo', 'run']);
  const key = (p: ResultsFile['perRequest'][number]): string => `${p.step}\u0000${p.kind}\u0000${p.attempt}`;
  for (const r of rs) {
    if ((r.scenario !== 'il3x46' && r.scenario !== 'il3x46-conc') || !ok(r)) continue;
    for (const sid of ['s1', 's2', 's3']) {
      const solo = find(rs, r.system, `il3x46-solo-${sid}`, r.window);
      const mine = r.perRequest.filter((p) => p.session === sid && p.kind === 'main');
      if (!ok(solo)) {
        t.add([r.system, r.scenario, sid, String(mine.length), 'no solo run', r.runKey.slice(0, 12)]);
        continue;
      }
      const ctl = new Map(solo.perRequest.filter((p) => p.kind === 'main').map((p) => [key(p), p.msgsDigest]));
      let d = Math.max(0, ctl.size - mine.length);
      for (const p of mine) if (ctl.get(key(p)) !== p.msgsDigest) d++;
      t.add([r.system, r.scenario, sid, String(mine.length), cell(d, 'MEASURED', ptr(r, 'perRequest')), r.runKey.slice(0, 12)]);
    }
  }
  return t;
}

/** benchmark contract client compaction idleness: the OpenCode client through kitzur. */
function idleTable(rs: readonly ResultsFile[]): Table {
  const t = new Table(['scenario', 'window', 'client compactions', 'max(prompt + completion) − usable (headroom)', 'usable', 'steps ok', 'run']);
  for (const r of rs) {
    if (r.system !== 'opencode-kitzur' || !ok(r)) continue;
    const m = r.metrics;
    t.add([
      r.scenario, windowLabel(WINDOWS[r.window as WindowId]), cell(m.client_compactions, 'MEASURED', ptr(r, 'metrics/client_compactions')),
      cell(m.headroom, 'MEASURED', m.headroom === null ? null : ptr(r, 'metrics/headroom')), cell(m.headroom_usable, 'MEASURED', ptr(r, 'metrics/headroom_usable')),
      cell(`${m.steps_ok}/${m.steps}`, 'MEASURED', ptr(r, 'metrics/steps_ok'), 'text'), r.runKey.slice(0, 12),
    ]);
  }
  return t;
}

function latencyTable(lat: LatencyIn): Table {
  const t = new Table(['class', 'measure', 'n', 'p50 (ms)', 'p90 (ms)', 'p99 (ms)', 'max (ms)']);
  for (const [k, v] of Object.entries(lat.classes ?? {})) {
    const parts: Array<[string, LatDist, string]> = [];
    for (const m of ['overhead', 'engine'] as const) if (v[m] && typeof v[m] === 'object') parts.push([m === 'overhead' ? 'reqPath + respPath' : 'engine', v[m]!, `${k}/${m}`]);
    if (!parts.length) parts.push(['total', v, k]);
    for (const [label, d, path] of parts) {
      const c = (x: number | null | undefined, f: string): Cell => cell(x ?? null, 'MEASURED', x === null || x === undefined ? null : `results/latency.json#/classes/${path}/${f}`, 'text');
      t.add([k, label, c(d.n, 'n'), c(d.p50, 'p50'), c(d.p90, 'p90'), c(d.p99, 'p99'), c(d.max, 'max')]);
    }
  }
  return t;
}

// ---------------------------------------------------------------- the document

export interface ReportInput {
  results: readonly ResultsFile[];
  crosscheck: CrossCheck | null;
  /** run-all's manifest.json: only its runKeys are reported (stale results of older code are ignored) */
  manifest?: ManifestIn | null;
  fuzz?: FuzzIn | null;
  latency?: LatencyIn | null;
  /** ablation ids and labels for the ablation table (default: the systems with tier T2 in the results) */
  ablations?: ReadonlyArray<{ id: string; label: string }>;
  /** how the results dir is referred to in the text */
  resultsLabel?: string;
}

export interface ReportOutput {
  markdown: string;
  /** the part verify compares */
  deterministic: string;
  gates: { gates: Record<string, Omit<GateResult, 'gate'>>; results: number };
  cells: Cell[];
}

const TIMING_HEADING = '## Timing (not deterministic)';

/** benchmark contract */
const ABLATIONS: ReadonlyArray<[string, string]> = [
  ['ledger off', 'ledger.enabled=false'],
  ['snapshot rules off', "rules.snapshot.stub='off', rules.snapshot.slim=false"],
  ['eager stubs', "rules.snapshot.stub='eager'"],
  ['oversize off / admission off', 'oversize.enabled=false / oversize.admitTokens=1e9'],
  ['clamp', 'budget.maxTokensClamp.enabled=true, client.compactionPointTokens=W'],
  ['estimated counting', 'tokenizer.path=null'],
  ['template mismatch', 'kitzur qwen3 vs mock sim, and the reverse'],
  ['keepRecent 2', 'compaction.keepRecent=2'],
  ['reasoning tail drop', "reasoning.tail='drop' (rs46)"],
  ['summaryRole merge', "compaction.summaryRole='merge-into-first-user'"],
];

/**
 * Why each ablation moves processed tokens (the gate-3 "+x% states the reason" clause). [INFERRED] from the measured
 * cells of the ablation table and DESIGN.md; the numbers themselves are in the table.
 */
export const ABLATION_NOTES: Readonly<Record<string, string>> = {
  'kitzur-ledger-off': 'Summaries lose the facts ledger: slightly fewer tokens, but the decision / todo / path facts are lost (gated facts drop).',
  'kitzur-snapshot-off': 'No boundary stubs and no slimming: superseded and oversized snapshots stay verbatim longer, so huge180k costs more; the reference sessions barely change (their snapshots are capped by the client).',
  'kitzur-stub-eager': 'Stubs every superseded snapshot at once: each stub is a rewrite (more generic compactions) and re-prefills the tail; dearer at 100k, cheaper at 32k where room is scarce. qa46-ref lands exactly on the benchmark contract MODEL figure.',
  'kitzur-oversize-off': 'No head+tail truncation or slimming of oversized results: at 100k the 180k-char output costs an extra compaction; at 32k a single capped snapshot exceeds the budget and the request fails (the documented §5.7 400).',
  'kitzur-admission-off': 'New oversized tool results are no longer cut at their first forwarding: at 100k huge180k carries the full output until the next compaction; at 32k compaction does the cutting instead, so prompts are smaller but compactions far more frequent and the hit ratio drops.',
  'kitzur-clamp': 'The compaction point moves to W with max_tokens clamped: prompts grow towards W before compacting (fewer compactions, higher hit) but every step resends a much larger prompt, so processed tokens rise sharply. Not a default.',
  'kitzur-estimate': 'The per-class estimate overcounts (safety factor), so kitzur compacts earlier and forwards smaller prompts: fewer processed tokens, a slightly lower hit, more compactions.',
  'kitzur-template-mismatch': 'Counting with the other template: harmless when only boundary tokens differ (sim vs qwen3 on sim), but on rs46 the sim template ignores reasoning_content, so kitzur undercounts, the server rejects and recoveries add tokens; at 32k it fails.',
  'kitzur-summary-0.02': 'A smaller summary budget: fewer tokens per post-compaction prompt with the gated facts still passing on these sessions.',
  'kitzur-summary-0.08': 'A larger summary budget: more tokens per post-compaction prompt for no fact gain on these sessions.',
  'kitzur-keeprecent-2': 'Two verbatim recent steps instead of one: bigger post-compaction prompts and more compactions; dearest on rs46 (long reasoning turns) and at 32k.',
  'kitzur-reasoning-drop': 'Dropping reasoning from the verbatim tail saves its tokens; the client sends reasoning back, so the tail no longer matches the client history byte for byte.',
  'kitzur-summaryrole-merge': 'Merging the summary into the first user message changes almost nothing on these sessions.',
};

export function buildReport(input: ReportInput): ReportOutput {
  const rs = selectLatest(applyManifest(input.results, input.manifest ?? null));
  const gates = computeGates(rs, input.crosscheck, input.fuzz ?? null, input.latency ?? null);
  const out: string[] = [];
  const cells: Cell[] = [];
  const emit = (t: Table): void => {
    out.push(t.render());
    cells.push(...t.cells());
  };
  out.push('# kitzur benchmarks');
  out.push('');
  out.push(
    `Generated by \`bench/report.ts\` from ${rs.length} results files in \`${input.resultsLabel ?? 'bench/results'}\` ` +
      `(${rs.filter((r) => r.status === 'ok').length} ok, ${rs.filter((r) => r.status === 'not-run').length} not run, ` +
      `${rs.filter((r) => r.status === 'error').length} errors). Every number is a cell {value, tag, src}: MEASURED values point into ` +
      '`results/<runKey>.json` (the run column holds the runKey prefix; the full pointers are in `BENCHMARKS.cells.json`), ' +
      'READ values cite bench/README.md. Metric definitions: bench/README.md. Everything above the Timing section is deterministic.',
  );
  out.push('');
  out.push('## Gates');
  out.push('');
  const gt = new Table(['gate', 'status', 'gap / reason', 'cause', 'runs']);
  for (const g of gates) gt.add([g.gate, g.status, g.gap ?? g.reason ?? '', g.cause ?? '', String(g.runKeys.length)]);
  emit(gt);
  out.push('');
  for (const g of gates.filter((x) => x.detail.length)) out.push(`- **${g.gate}**: ${g.detail.join('; ')}`);
  out.push('');
  out.push('## Historical reference numbers (inputs predating public sanitation)');
  out.push('');
  emit(preRegisteredTable(rs));
  out.push('');
  out.push('## Headline: kitzur vs gobstopper tuned and the OpenCode baselines');
  out.push('');
  out.push('`opencode` = the OpenCode HTTP client direct (faithful mode, truthful limits W/O); `opencode-sim-compat` = the offline OpenCode mechanics (baseline.py, the §4 comparator); `opencode-kitzur` = the OpenCode client through kitzur. OpenCode-client fact figures are [INFERRED best case] (its placeholder summary carries every visible marker).');
  out.push('');
  emit(headlineTable(rs));
  out.push('');
  out.push('## kitzur: measured vs the §17 MODEL predictions');
  out.push('');
  emit(leanModelTable(rs));
  out.push('');
  out.push('## Gate 4 view: prefix metrics');
  out.push('');
  out.push('`hit` = ΣLCP/Σprompt (the gate-4 ratio); `fresh` = client messages at their first forwarding (the irreducible part); `fresh (synthesized)` = first sends of synthesized messages, part of `L` = uncached − fresh; `reusable` = ΣLCP/Σ(prompt − fresh).');
  out.push('');
  emit(prefixTable(rs));
  out.push('');
  // per family and window
  const fams = [...new Set(rs.map((r) => r.family))].sort((a, b) => famRank(a) - famRank(b));
  for (const f of fams) {
    out.push(`## ${f} ${FAMILY_NAMES[f as FamilyId] ?? ''}`);
    out.push('');
    for (const w of WINDOW_IDS) {
      const sub = rs.filter((r) => r.family === f && r.window === w);
      if (!sub.length) continue;
      out.push(`### ${f} @ ${windowLabel(WINDOWS[w])}`);
      out.push('');
      emit(familyTable(sub));
      out.push('');
      for (const sc of [...new Set(sub.map((r) => r.scenario))]) {
        const ft = factsTable(sub, sc, w);
        if (!ft) continue;
        out.push(`Facts, \`${sc}\` @ ${windowLabel(WINDOWS[w])} (benchmark contract ; OpenCode-client rows are [INFERRED best case]: its placeholder summary carries every visible marker):`);
        out.push('');
        emit(ft);
        out.push('');
      }
    }
  }
  const st = supersessionTable(rs);
  out.push('## Supersession confusion matrix (F9)');
  out.push('');
  if (st) emit(st);
  else out.push('NOT RUN: no corr60 results.');
  out.push('');
  out.push('## Restart (F13, I5)');
  out.push('');
  const rt = restartTable(rs);
  if (rt.rows.length) emit(rt);
  else out.push('NOT RUN: no F13 results.');
  out.push('');
  out.push('## Interleaved sessions vs their solo runs (F8)');
  out.push('');
  const ilt = interleaveTable(rs);
  if (ilt.rows.length) emit(ilt);
  else out.push('NOT RUN: no il3x46 results.');
  out.push('');
  out.push('## OpenCode client through kitzur: client compaction idleness (benchmark contract )');
  out.push('');
  const it = idleTable(rs);
  if (it.rows.length) emit(it);
  else out.push('NOT RUN: no opencode-kitzur results.');
  out.push('');
  out.push('## Ablations (benchmark contract )');
  out.push('');
  const ablIds = input.ablations ?? [...new Map(rs.filter((r) => r.tier === 'T2').map((r) => [r.system, { id: r.system, label: r.systemLabel }])).values()];
  if (ablIds.length) {
    out.push('Each cell: processed (Δ vs kitzur default); hit; steps ok; gated facts; generic compactions. Every row above +0% states its reason in the text below the table where one is known.');
    out.push('');
    emit(ablationTable(rs, ablIds));
    out.push('');
    out.push('Reasons [INFERRED from the measured cells]:');
    for (const a of ablIds) if (ABLATION_NOTES[a.id]) out.push(`- \`${a.id}\`: ${ABLATION_NOTES[a.id]}`);
    out.push('');
    out.push('`rs46 @32k`: rs46 is defined at 100k only (scenario windows); its completion model draws reasoning with a p95 of 6,000 tokens plus text, which a 32k/8k client (max_tokens 8,000) truncates, so every ablation hits `length_no_tool` at step 6 (a scenario property: the mock caps generation at the forwarded max_tokens), and the kitzur default has no cell there to compare with.');
  } else {
    const at = new Table(['ablation (vs kitzur default)', 'change', 'qa46-ref', 'talk80', 'huge180k', 'rs46']);
    for (const [name, change] of ABLATIONS) at.add([name, change, 'NOT RUN', 'NOT RUN', 'NOT RUN', 'NOT RUN']);
    emit(at);
  }
  out.push('');
  out.push('## Sweep (benchmark contract small grid over HTTP)');
  out.push('');
  const sw = sweepRows(rs, 'qa46', '100k');
  if (sw.rows.length) {
    out.push(`qa46 @ 100k/32k; comparator gobstopper tuned: ${ok(sw.gob) ? `processed ${fmtInt(sw.gob.metrics.processed)}, hit ${((sw.gob.metrics.hit ?? 0) * 100).toFixed(2)}%` : 'NOT RUN'}. Selection rule: minimise uncached subject to processed ≤ gob tuned, hit ≥ gob tuned, b2b = 0, every gated fact passing, no client errors. Selected: ${sw.selected ? `trigger ${sw.selected.trigger}, target ${sw.selected.target}, summary ${sw.selected.summary}` : 'none'}.`);
    out.push('');
    emit(sweepTable(sw));
  } else out.push('NOT RUN: no kitzur-sweep-* results.');
  out.push('');
  out.push('## Fuzz (benchmark contract ) and latency (benchmark contract )');
  out.push('');
  if (input.fuzz) out.push(`Fuzz (results/fuzz.json): ${gates.find((g) => g.gate === 'G9')!.detail.join('; ')}.`);
  else out.push('Fuzz: NOT RUN (no results/fuzz.json).');
  out.push('');
  if (input.latency?.classes) {
    emit(latencyTable(input.latency));
    out.push('');
  } else out.push('Latency: NOT RUN (no results/latency.json).');
  out.push('');
  const errs = rs.filter((r) => r.status !== 'ok');
  out.push('## Not run and errors');
  out.push('');
  if (!errs.length) out.push('None.');
  const notYet = errs.filter((r) => r.reason === 'not run yet at this code version');
  for (const r of errs.filter((x) => !notYet.includes(x))) out.push(`- ${r.status === 'not-run' ? 'NOT RUN' : 'ERROR'} \`${r.system}/${r.scenario}/${r.window}\`: ${r.reason ?? ''}`);
  if (notYet.length) {
    const bySys = new Map<string, number>();
    for (const r of notYet) bySys.set(`${r.tier} ${r.system}`, (bySys.get(`${r.tier} ${r.system}`) ?? 0) + 1);
    out.push(`- NOT RUN (not run yet at this code version): ${notYet.length} cells — ${[...bySys].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  out.push('');
  const deterministic = out.join('\n');
  // timing
  const tm: string[] = [TIMING_HEADING, ''];
  const v = rs.find((r) => r.versions)?.versions;
  const cpu = cpus();
  tm.push(`Machine: ${cpu[0]?.model ?? 'unknown CPU'}, ${cpu.length} cores; node ${process.version}.`);
  if (v) {
    tm.push(`Runs: node ${v.node}; ${v.gobVersion ?? 'gobstopper n/a'} (sha256 ${v.gobSha ?? 'n/a'}); tokenizer sha256 ${v.tokenizerSha ?? 'n/a'}; commit ${v.commit ?? 'n/a'}; code ${v.codeVersion.slice(0, 16)}.`);
  }
  tm.push('');
  const tt = new Table(['system', 'scenario', 'window', 'wall (s)', 'step p50 (ms)', 'step p90 (ms)', 'step max (ms)', 'started']);
  for (const r of rs.filter((x) => x.timing)) {
    const t = r.timing!;
    tt.add([r.system, r.scenario, r.window, cell(Math.round(t.wallMs / 100) / 10, 'MEASURED', ptr(r, 'timing/wallMs'), 'text'),
      cell(t.stepMs.p50, 'MEASURED', ptr(r, 'timing/stepMs/p50'), 'text'), cell(t.stepMs.p90, 'MEASURED', ptr(r, 'timing/stepMs/p90'), 'text'),
      cell(t.stepMs.max, 'MEASURED', ptr(r, 'timing/stepMs/max'), 'text'), t.startedAt]);
  }
  tm.push(tt.render());
  cells.push(...tt.cells());
  tm.push('');
  const gatesJson: ReportOutput['gates'] = { gates: {}, results: rs.length };
  for (const g of gates) {
    const { gate, ...rest } = g;
    gatesJson.gates[gate] = rest;
  }
  return { markdown: deterministic + '\n' + tm.join('\n'), deterministic, gates: gatesJson, cells };
}

/** The deterministic part of a BENCHMARKS.md text. */
export function deterministicPart(markdown: string): string {
  const i = markdown.indexOf(TIMING_HEADING);
  return i < 0 ? markdown : markdown.slice(0, i).replace(/\n$/, '');
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const dir = flag('--results-dir') ?? RESULTS_DIR;
  const outDir = flag('--out') ?? null;
  const xcPath = flag('--crosscheck') ?? join(RESULTS_DIR, 'crosscheck.json');
  const xc = existsSync(xcPath) ? (JSON.parse(readFileSync(xcPath, 'utf8')) as CrossCheck) : null;
  const manifest = args.includes('--all') ? null : readJsonIf<ManifestIn>(join(dir, 'manifest.json'));
  const rep = buildReport({
    results: loadResults(dir), crosscheck: xc, resultsLabel: dir.startsWith(ROOT) ? dir.slice(ROOT.length + 1) : dir, manifest,
    fuzz: readJsonIf<FuzzIn>(join(dir, 'fuzz.json')), latency: readJsonIf<LatencyIn>(join(dir, 'latency.json')),
  });
  const mdPath = outDir ? join(outDir, 'BENCHMARKS.md') : join(ROOT, 'BENCHMARKS.md');
  const gatesPath = outDir ? join(outDir, 'gates.json') : join(dir, 'gates.json');
  const cellsPath = outDir ? join(outDir, 'BENCHMARKS.cells.json') : join(dir, 'BENCHMARKS.cells.json');
  if (outDir) mkdirSync(outDir, { recursive: true });
  writeFileSync(mdPath, rep.markdown);
  writeFileSync(gatesPath, JSON.stringify(rep.gates, null, 1) + '\n');
  writeFileSync(cellsPath, JSON.stringify(rep.cells) + '\n');
  console.log(`wrote ${mdPath}, ${gatesPath}, ${cellsPath}`);
  for (const [g, r] of Object.entries(rep.gates.gates)) console.log(`${g.padEnd(3)} ${r.status}${r.reason ? ` — ${r.reason}` : ''}${r.gap ? ` — ${r.gap}` : ''}`);
}
