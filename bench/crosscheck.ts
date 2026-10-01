// Cross-check: the TypeScript harness against the frozen Python reference harness and the real
// gobstopper v0.7.2 binary, on the evaluation's reference runs.
//
//   node dist/bench/crosscheck.js [--cases a,b,c,d,e] [--no-python] [--ref DIR] [--gob BIN] [--eval-results DIR]
//
//   (a) gobstopper tuned `--threshold 58000 --keep-recent 2 --carry-max-chars 40000`, SIM_CAP_BYTES=51200
//   (b) gobstopper defaults, uncapped snapshots (report "A_defaults")
//   (c) direct (no proxy), uncapped
//   (d) OpenCode-mechanics baseline, SIM_CAP_BYTES=51200 (plus the long post-overflow Continue text, TS only)
//   (e) gobstopper defaults, SIM_CAP_BYTES=51200 (report "F_defaults" = the "As-is defaults" row: 548k wasted)
//   (f) H_180k: `--threshold 58000 --keep-recent 2 --keep-tail-percent 30`, SIM_HUGE_AT=20 SIM_HUGE_CHARS=180000,
//       uncapped: the failure step (21; the newest turn alone stays above the limit after every escalation)
//   (g) E_default_llamacpp: gobstopper defaults against the llama.cpp error style: the attempt count and tokens of the
//       failing step (gobstopper 0.7.2 does not recognise the llama.cpp body, so the 400 reaches the client unchanged
//       after 1 attempt: 84,850 tokens at step 10)
//   (h) N_T58_nousage: `--threshold 58000 --keep-recent 2 --keep-tail-percent 30`, client --no-usage: no calibration
//       (ratio stays 1.00 because no usage sample ever arrives)
//
// With --eval-results / KITZUR_EVAL_RESULTS (reference-harness/results), each run is also compared with
// the evaluation's own results file (analyze.py output, run-name line excluded; baseline.py stdout).
//
// For (a)-(c) the TS harness runs (in-process mock + agent, gobstopper as a fresh child process), then, when
// KITZUR_REF_DIR / --ref points at the Python harness, the UNMODIFIED run.py + analyze.py run the same
// experiment. Compared field by field: the analyze summaries, the per-request sequences of mock.jsonl
// (prompt_tokens, status, body bytes, message counts, facts), the sha256 of every upstream request body,
// the gobstopper ledgers (minus timestamps), the client records, and the analyze text. Python's analyze.py
// is also run on the TS run directory, which must print exactly what bench/analyze.ts prints.
// For (d) baseline.py's stdout is compared byte for byte, plus the per-request prompt sequence (from an
// instrumented runpy launch that wraps scenario.count_tokens without modifying baseline.py).
//
// Writes bench/results/crosscheck.json and prints a table.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeStdout, readJsonlFile, report, type AnalyzeSummary } from './analyze.js';
import { defaultCounter, runExperiment } from './harness.js';
import { PromptCounter } from './lib/render.js';
import { benchTokenizer, benchTokenizerPath, gobstopperBin, RAW_RESULTS_DIR, refHarness, RESULTS_DIR, ROOT, type RefHarness } from './lib/paths.js';
import { fmtInt, sum, textTable } from './lib/stats.js';
import { runOpenCodeSim } from './opencode-sim.js';
import { scenarioEnv, type ScenarioOptions } from './scenarios/reference.js';
import { Direct } from './systems/direct.js';
import { Gobstopper, GOB_TUNED_ARGS } from './systems/gobstopper.js';
import { codeVersion } from './matrix.js';
import type { BenchSystem } from './systems/types.js';

type Json = Record<string, unknown>;

interface RunCase {
  id: 'a' | 'b' | 'c' | 'e' | 'f' | 'g' | 'h';
  title: string;
  system: 'gobstopper' | 'direct';
  gobArgs: string[];
  scenario: ScenarioOptions;
  /** mock error style (run.py --mock --error-style X); default the Python default 'vllm' */
  errorStyle?: string;
  /** client usage off (run.py --client --no-usage) */
  noUsage?: boolean;
  pyName: string;
  /** the evaluation's results file for this run (reference-harness/results/<file>) */
  resultsFile?: string;
  /** targets from the evaluation [MEASURED with Python] */
  targets: Record<string, number | boolean>;
}

const RUN_CASES: RunCase[] = [
  {
    id: 'a', title: 'gobstopper tuned, SIM_CAP_BYTES=51200', system: 'gobstopper', gobArgs: GOB_TUNED_ARGS,
    scenario: { capBytes: 51200 }, pyName: 'xc_a_gob_tuned_cap51200', resultsFile: 'F_proposed.md',
    targets: {"compactions": 7, "sent_total": 1734159, "peak": 60984, "steps_ok": 46, "client_errors": 0, "rejections": 0},
  },
  {
    id: 'b', title: 'gobstopper defaults, uncapped (A_defaults)', system: 'gobstopper', gobArgs: [],
    scenario: {}, pyName: 'xc_b_gob_defaults_uncapped', resultsFile: 'A_defaults.md',
    // results/A_defaults.md; the report's "548k wasted" is F_defaults (case e), not this uncapped run
    targets: {"rejections": 7, "steps_ok": 46, "compactions": 7, "sent_total": 2695444, "accepted_total": 2126689, "wasted_rejected_tokens": 568755, "peak": 66541},
  },
  {
    id: 'c', title: 'direct (no proxy), uncapped', system: 'direct', gobArgs: [],
    scenario: {}, pyName: 'xc_c_direct_uncapped',
    targets: {"steps_ok": 10, "client_errors": 1, "failed_at_step": 10},
  },
  {
    id: 'e', title: 'gobstopper defaults, SIM_CAP_BYTES=51200 (F_defaults)', system: 'gobstopper', gobArgs: [],
    scenario: { capBytes: 51200 }, pyName: 'xc_e_gob_defaults_cap51200', resultsFile: 'F_defaults.md',
    // report.md "Other runs": As-is defaults = 46 steps, 7 compactions, 7 overflows (548k tokens), 2,140,612 accepted, peak 64,413
    targets: {"steps_ok": 46, "compactions": 7, "rejections": 7, "wasted_rejected_tokens": 548297, "accepted_total": 2140718, "peak": 64427},
  },
  {
    id: 'f', title: 'H_180k: gobstopper T58 kr2 tp30, SIM_HUGE_AT=20 SIM_HUGE_CHARS=180000 (failure step)', system: 'gobstopper',
    gobArgs: ['--threshold', '58000', '--keep-recent', '2', '--keep-tail-percent', '30'],
    scenario: { hugeAt: 20, hugeChars: 180_000 }, pyName: 'xc_f_h180k', resultsFile: 'H_180k.md',
    // results/H_180k.md: 21/22 steps, 1 client error, 23 upstream requests, 2 rejections, 987,533 sent, 3 compactions, peak 58,862
    targets: {"steps_ok": 21, "client_errors": 1, "failed_at_step": 21, "fail_step_attempts": 2, "fail_step_tokens": 148634, "upstream_requests": 23, "rejections": 2, "sent_total": 987560, "accepted_total": 838926, "compactions": 3, "peak": 58878},
  },
  {
    id: 'g', title: 'E_default_llamacpp: gobstopper defaults, llama.cpp error style (resend / attempts at the failing step)', system: 'gobstopper',
    gobArgs: [], scenario: {}, errorStyle: 'llamacpp', pyName: 'xc_g_e_default_llamacpp', resultsFile: 'E_default_llamacpp.md',
    // results/E_default_llamacpp.md: 10/11 steps, 11 upstream requests, 1 rejection, 440,286 sent (accepted 355,436), peak 56,643
    targets: {"steps_ok": 10, "client_errors": 1, "failed_at_step": 10, "upstream_requests": 11, "rejections": 1, "sent_total": 440287, "accepted_total": 355436, "fail_step_attempts": 1, "fail_step_tokens": 84851, "peak": 56643},
  },
  {
    id: 'h', title: 'N_T58_nousage: gobstopper T58 kr2 tp30, client --no-usage (no calibration)', system: 'gobstopper',
    gobArgs: ['--threshold', '58000', '--keep-recent', '2', '--keep-tail-percent', '30'],
    scenario: {}, noUsage: true, pyName: 'xc_h_n_t58_nousage', resultsFile: 'N_T58_nousage.md',
    // results/N_T58_nousage.md: 46/46, 47 upstream requests, 1 rejection, 2,100,631 sent, 6 compactions, peak 66,689, calibration 1.00 → 1.00
    targets: {"steps_ok": 46, "client_errors": 0, "upstream_requests": 47, "rejections": 1, "sent_total": 2100698, "accepted_total": 2032107, "compactions": 6, "peak": 66690, "calibration_ratio_last": 1},
  },
];

// ---------------------------------------------------------------- helpers

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function run(cmd: string, args: string[], env?: Record<string, string>, cwd?: string): { code: number; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  // scenario.py reads SIM_* at call time: only the knobs of the case may reach the Python side
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('SIM_')) base[k] = v;
  const r = spawnSync(cmd, args, { env: { ...base, ...env }, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60_000 });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

/** Numbers every run is compared on, derived identically from both run directories. */
function derived(dir: string): Json {
  const mock = readJsonlFile(join(dir, 'mock.jsonl'));
  const client = readJsonlFile(join(dir, 'client.jsonl'));
  const failed = client.find((c) => c['status'] !== 200);
  const failStep = failed ? (failed['step'] as number) : null;
  const atFail = failStep === null ? [] : mock.filter((m) => m['step'] === failStep);
  const ledger = readJsonlFile(join(dir, 'ledger.jsonl'));
  const ratios = ledger.map((l) => l['ratio_permille']).filter((x): x is number => typeof x === 'number');
  return {
    upstream_requests: mock.length,
    accepted_total: sum(mock.filter((m) => m['status'] === 200).map((m) => m['prompt_tokens'] as number)),
    wasted_rejected_tokens: sum(mock.filter((m) => m['rejected_for_length']).map((m) => m['prompt_tokens'] as number)),
    completion_total: sum(mock.map((m) => (m['completion_tokens'] as number | undefined) ?? 0)),
    orig_total: sum(client.map((c) => c['orig_qwen_tokens'] as number)),
    failed_at_step: failStep,
    pairing_errors: mock.filter((m) => m['pairing_error']).length,
    // (g): the upstream attempts of the failing step and their prompt tokens (the "resend-original" count)
    fail_step_attempts: failStep === null ? null : atFail.length,
    fail_step_tokens: failStep === null ? null : sum(atFail.map((m) => m['prompt_tokens'] as number)),
    // (h): gobstopper's applied calibration ratio (ledger ratio_permille / 1000) of the last request; null = no ledger field
    calibration_ratio_last: ratios.length ? ratios[ratios.length - 1]! / 1000 : null,
  };
}

interface SeqDiff {
  field: string;
  equal: boolean;
  n: [number, number];
  firstDiff?: { index: number; ts: unknown; py: unknown };
}

function compareSeq(field: string, a: unknown[], b: unknown[]): SeqDiff {
  const n: [number, number] = [a.length, b.length];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = JSON.stringify(a[i]);
    const y = JSON.stringify(b[i]);
    if (x !== y) return { field, equal: false, n, firstDiff: { index: i, ts: a[i], py: b[i] } };
  }
  return { field, equal: true, n };
}

function reqShas(dir: string): string[] {
  const d = join(dir, 'reqs');
  if (!existsSync(d)) return [];
  return readdirSync(d).sort().map((f) => sha(readFileSync(join(d, f))));
}

/** Everything comparable between two run directories. */
function compareRunDirs(ts: string, py: string): SeqDiff[] {
  const m1 = readJsonlFile(join(ts, 'mock.jsonl'));
  const m2 = readJsonlFile(join(py, 'mock.jsonl'));
  const c1 = readJsonlFile(join(ts, 'client.jsonl'));
  const c2 = readJsonlFile(join(py, 'client.jsonl'));
  const l1 = readJsonlFile(join(ts, 'ledger.jsonl'));
  const l2 = readJsonlFile(join(py, 'ledger.jsonl'));
  const pick = (rs: Json[], k: string): unknown[] => rs.map((r) => r[k]);
  const noTs = (rs: Json[]): unknown[] => rs.map(({ ts: _t, ...r }) => r);
  const out: SeqDiff[] = [];
  for (const k of ['prompt_tokens', 'status', 'step', 'max_tokens', 'n_messages', 'has_summary', 'facts', 'body_chars', 'pairing_error', 'rejected_for_length', 'completion_tokens'])
    out.push(compareSeq(`mock.${k}`, pick(m1, k), pick(m2, k)));
  out.push(compareSeq('reqs.sha256 (upstream bodies)', reqShas(ts), reqShas(py)));
  for (const k of ['orig_messages', 'orig_est_tokens', 'orig_qwen_tokens', 'status', 'error_body'])
    out.push(compareSeq(`client.${k}`, pick(c1, k), pick(c2, k)));
  out.push(compareSeq('ledger (all fields but ts)', noTs(l1), noTs(l2)));
  return out;
}

function compareSummary(a: AnalyzeSummary, b: AnalyzeSummary): string[] {
  const diffs: string[] = [];
  for (const k of Object.keys(a) as Array<keyof AnalyzeSummary>) {
    const x = JSON.stringify(a[k]);
    const y = JSON.stringify(b[k]);
    if (x !== y) diffs.push(`${k}: ts=${x} py=${y}`);
  }
  return diffs;
}

const withoutFirstLine = (s: string): string => s.slice(s.indexOf('\n') + 1);

// ---------------------------------------------------------------- the cases

/** Compare an analyze/baseline stdout with the evaluation's results file (analyze runs: minus the run-name line). */
function vsResultsFile(evalResults: string | null, file: string | undefined, stdout: string, skipFirstLine: boolean): Json | undefined {
  if (!evalResults || !file) return undefined;
  const p = join(evalResults, file);
  if (!existsSync(p)) return { file: p, missing: true };
  const want = readFileSync(p, 'utf8').trimEnd();
  const got = stdout.trimEnd();
  return { file: p, identical: skipFirstLine ? withoutFirstLine(got) === withoutFirstLine(want) : got === want };
}

async function runCase(c: RunCase, ref: RefHarness | null, gob: string | null, evalResults: string | null, log: (s: string) => void): Promise<Json> {
  const res: Json = { id: c.id, title: c.title, targets: c.targets };
  if (c.system === 'gobstopper' && !gob) {
    res['skipped'] = 'no gobstopper binary (set KITZUR_GOBSTOPPER_BIN or KITZUR_REF_DIR)';
    return res;
  }
  // ---- TS harness
  const system: BenchSystem = c.system === 'gobstopper' ? new Gobstopper({ bin: gob!, args: c.gobArgs }) : new Direct();
  const tsDir = join(RAW_RESULTS_DIR, `xc-${c.id}-ts`);
  log(`[${c.id}] TS harness: ${c.title}`);
  const r = await runExperiment({
    name: `xc-${c.id}-ts`, runDir: tsDir, system, scenario: c.scenario,
    ...(c.errorStyle ? { mock: { errorStyle: c.errorStyle } } : {}),
    ...(c.noUsage ? { client: { usage: false } } : {}),
  });
  const tsRep = report(tsDir);
  const tsOut = analyzeStdout(tsDir);
  writeFileSync(join(tsDir, 'analyze.ts.md'), tsOut);
  const rf = vsResultsFile(evalResults, c.resultsFile, tsOut, true);
  if (rf) res['results_file'] = rf;
  const lcp = sum(r.mock.map((m) => m.lcp_tokens ?? 0));
  const prompts = sum(r.mock.map((m) => m.prompt_tokens));
  res['ts'] = {
    run_dir: tsDir,
    ms: Math.round(r.ms.total),
    summary: tsRep.summary,
    derived: derived(tsDir),
    prefix_lcp_tokens: lcp,
    prefix_hit_rate: prompts ? Math.round((lcp / prompts) * 10000) / 10000 : null,
    gobstopper_status: r.system.status,
    server_closed_all: r.client.every((x) => x.server_closed),
  };
  // the evaluation's numbers (targets) on the TS side
  const tsVals: Json = { ...(derived(tsDir) as Json), ...(tsRep.summary as unknown as Json) };
  const missed = Object.entries(c.targets).filter(([k, v]) => JSON.stringify(tsVals[k]) !== JSON.stringify(v)).map(([k, v]) => `${k}: ts=${JSON.stringify(tsVals[k])} target=${JSON.stringify(v)}`);
  res['targets_met'] = missed.length === 0;
  if (missed.length) res['targets_missed'] = missed;
  log(`[${c.id}] TS done in ${(r.ms.total / 1000).toFixed(1)} s: ${JSON.stringify(tsRep.summary)}${missed.length ? ` TARGETS MISSED: ${missed.join('; ')}` : ''}`);
  if (!ref) return res;
  // ---- Python harness (unmodified run.py + analyze.py)
  const env = scenarioEnv(c.scenario);
  const runArgs = [join(ref.sim, 'run.py'), c.pyName, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])];
  if (c.system === 'direct') runArgs.push('--direct');
  else if (c.gobArgs.length) runArgs.push('--proxy', ...c.gobArgs);
  if (c.errorStyle) runArgs.push('--mock', '--error-style', c.errorStyle);
  runArgs.push('--client', '--save-origs', ...(c.noUsage ? ['--no-usage'] : []));
  log(`[${c.id}] Python harness: ${runArgs.slice(1).join(' ')}`);
  const py = run(ref.python, runArgs);
  if (py.code !== 0) throw new Error(`run.py failed (${py.code}): ${py.stderr.slice(-2000)}`);
  const pyDir = join(ref.runs, c.pyName);
  const an = run(ref.python, [join(ref.sim, 'analyze.py'), pyDir]);
  if (an.code !== 0) throw new Error(`analyze.py failed: ${an.stderr.slice(-2000)}`);
  writeFileSync(join(tsDir, 'analyze.py-on-python-run.md'), an.stdout);
  const pyLines = an.stdout.trimEnd().split('\n');
  const pySummary = JSON.parse(pyLines[pyLines.length - 1]!) as AnalyzeSummary;
  // Python analyze.py on the TS run dir must print what bench/analyze.ts printed
  const anTs = run(ref.python, [join(ref.sim, 'analyze.py'), tsDir]);
  const seq = compareRunDirs(tsDir, pyDir);
  res['py'] = { run_dir: pyDir, ms: Math.round(py.ms), summary: pySummary, derived: derived(pyDir), run_stdout: py.stdout.trim() };
  res['match'] = {
    summary_diffs: compareSummary(tsRep.summary, pySummary),
    derived_equal: JSON.stringify(derived(tsDir)) === JSON.stringify(derived(pyDir)),
    analyze_text_equal_except_run_name: withoutFirstLine(tsOut) === withoutFirstLine(an.stdout),
    analyze_py_on_ts_run_equals_analyze_ts: anTs.code === 0 && anTs.stdout === tsOut,
    sequences: seq,
  };
  log(`[${c.id}] Python done in ${(py.ms / 1000).toFixed(1)} s: ${JSON.stringify(pySummary)}`);
  return res;
}

function caseD(ref: RefHarness | null, evalResults: string | null, log: (s: string) => void): Json {
  const scenario: ScenarioOptions = { capBytes: 51200 };
  // timed with a cold segment cache (a fresh counter over the already loaded tokenizer)
  const t = performance.now();
  const short = runOpenCodeSim({ counter: new PromptCounter(benchTokenizer()), scenario });
  const msShort = performance.now() - t;
  const long = runOpenCodeSim({ counter: defaultCounter(), scenario, continueText: 'long' });
  const res: Json = {
    id: 'd',
    title: 'OpenCode mechanics (baseline.py), SIM_CAP_BYTES=51200',
    targets: {"compactions": 6, "rejected": 462177, "total_prompt_tokens": 2492849},
    ts: { ms: Math.round(msShort), totals: short.totals, stdout: short.stdout, requests: short.requests.length },
    ts_long_continue: { totals: long.totals, stdout: long.stdout },
  };
  const tt = res['targets'] as Record<string, number>;
  res['targets_met'] = Object.entries(tt).every(([k, v]) => (short.totals as unknown as Record<string, number>)[k] === v);
  const rf = vsResultsFile(evalResults, 'baseline_capped.md', short.stdout, false);
  if (rf) res['results_file'] = rf;
  log(`[d] TS: ${JSON.stringify(short.totals)}`);
  log(`[d] TS long Continue: total ${fmtInt(long.totals.total_prompt_tokens)}, rejected ${fmtInt(long.totals.rejected)}`);
  if (!ref) return res;
  const env = scenarioEnv(scenario);
  const plain = run(ref.python, [join(ref.sim, 'baseline.py')], env);
  if (plain.code !== 0) throw new Error(`baseline.py failed: ${plain.stderr.slice(-2000)}`);
  // Same run, instrumented without touching baseline.py: record every scenario.count_tokens result.
  const tracePath = join(RAW_RESULTS_DIR, 'xc-d-py-count-trace.json');
  const driver = [
    'import json, os, runpy, sys',
    `SIM = ${JSON.stringify(ref.sim)}`,
    'sys.path.insert(0, SIM)',
    'import scenario',
    'calls = []',
    '_orig = scenario.count_tokens',
    'def _wrapped(body):',
    '    n = _orig(body); calls.append(n); return n',
    'scenario.count_tokens = _wrapped',
    "sys.argv = ['baseline.py']",
    "runpy.run_path(os.path.join(SIM, 'baseline.py'), run_name='__main__')",
    `json.dump(calls, open(${JSON.stringify(tracePath)}, 'w'))`,
  ].join('\n');
  mkdirSync(RAW_RESULTS_DIR, { recursive: true });
  const inst = run(ref.python, ['-c', driver], env);
  if (inst.code !== 0) throw new Error(`instrumented baseline failed: ${inst.stderr.slice(-2000)}`);
  const pyCalls = JSON.parse(readFileSync(tracePath, 'utf8')) as number[];
  // TS trace of the same call sites: every attempt's prompt, and the post-compaction count after each rejection
  const tsCalls: number[] = [];
  let ci = 0;
  for (const q of short.requests) {
    tsCalls.push(q.prompt);
    if (!q.accepted) tsCalls.push(short.rows[ci++]!.after);
  }
  const lines = plain.stdout.trimEnd().split('\n');
  const pyTotals = JSON.parse(lines[lines.length - 1]!) as Json;
  res['py'] = { ms: Math.round(plain.ms), totals: pyTotals, stdout: plain.stdout };
  res['match'] = {
    stdout_identical: plain.stdout === short.stdout,
    instrumented_stdout_identical: inst.stdout === short.stdout,
    count_sequence: compareSeq('count_tokens results in call order', tsCalls, pyCalls),
  };
  log(`[d] Python done in ${(plain.ms / 1000).toFixed(1)} s: stdout identical = ${String(plain.stdout === short.stdout)}`);
  return res;
}

// ---------------------------------------------------------------- report

function printTable(results: Json[]): string {
  const rows: string[][] = [['case', 'metric', 'target', 'TS harness', 'Python harness', 'TS = Python']];
  const cell = (v: unknown): string => (v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? fmtInt(v) : String(v)) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  for (const r of results) {
    if (r['skipped']) {
      rows.push([String(r['id']), 'skipped', '', String(r['skipped']), '', '']);
      continue;
    }
    const ts = r['ts'] as Json;
    const py = (r['py'] as Json | undefined) ?? null;
    const targets = r['targets'] as Record<string, unknown>;
    if (r['id'] === 'd') {
      const tt = ts['totals'] as Json;
      const pt = (py?.['totals'] as Json | undefined) ?? {};
      for (const k of ['compactions', 'overflow_errors', 'main', 'rejected', 'summ_in', 'total_prompt_tokens'])
        rows.push(['d', k, cell(targets[k]), cell(tt[k]), py ? cell(pt[k]) : '-', py ? String(tt[k] === pt[k]) : '-']);
      const lt = (r['ts_long_continue'] as Json)['totals'] as Json;
      rows.push(['d', 'total (long Continue text)', '-', cell(lt['total_prompt_tokens']), 'n/a', '-']);
      const m = r['match'] as Json | undefined;
      if (m) rows.push(['d', 'stdout byte-identical', 'yes', '', '', String(m['stdout_identical'])]);
      if (m) rows.push(['d', 'count_tokens sequence', 'identical', '', '', String((m['count_sequence'] as SeqDiff).equal)]);
      const rfd = r['results_file'] as Json | undefined;
      if (rfd) rows.push(['d', '= results/baseline_capped.md', 'identical', String(rfd['identical'] ?? 'missing'), '', '']);
      rows.push(['d', 'run time (s)', '', ((ts['ms'] as number) / 1000).toFixed(1), py ? ((py['ms'] as number) / 1000).toFixed(1) : '-', '']);
      continue;
    }
    const sTs = ts['summary'] as Json;
    const dTs = ts['derived'] as Json;
    const sPy = (py?.['summary'] as Json | undefined) ?? {};
    const dPy = (py?.['derived'] as Json | undefined) ?? {};
    const get = (s: Json, d: Json, k: string): unknown => (k in s ? s[k] : d[k]);
    for (const k of ['steps_ok', 'client_errors', 'compactions', 'b2b', 'rejections', 'wasted_rejected_tokens', 'sent_total', 'accepted_total', 'peak', 'upstream_requests', 'failed_at_step', 'fail_step_attempts', 'fail_step_tokens', 'calibration_ratio_last']) {
      const a = get(sTs, dTs, k);
      const b = py ? get(sPy, dPy, k) : undefined;
      rows.push([String(r['id']), k, cell(targets[k]), cell(a), py ? cell(b) : '-', py ? String(JSON.stringify(a) === JSON.stringify(b)) : '-']);
    }
    const surv = sTs['survival'] as Record<string, boolean>;
    rows.push([String(r['id']), 'survival (lost facts)', '', Object.keys(surv).filter((k) => !surv[k]).join(',') || 'none',
      py ? Object.keys(sPy['survival'] as Json).filter((k) => !(sPy['survival'] as Json)[k]).join(',') || 'none' : '-',
      py ? String(JSON.stringify(surv) === JSON.stringify(sPy['survival'])) : '-']);
    const m = r['match'] as Json | undefined;
    if (m) {
      const seq = m['sequences'] as SeqDiff[];
      const bad = seq.filter((s) => !s.equal).map((s) => s.field);
      rows.push([String(r['id']), 'per-request sequences', 'identical', `${seq.length - bad.length}/${seq.length} identical`, '', bad.length ? 'DIFF: ' + bad.join(', ') : 'true']);
      rows.push([String(r['id']), 'analyze text (minus run name)', 'identical', '', '', String(m['analyze_text_equal_except_run_name'])]);
      rows.push([String(r['id']), 'analyze.py on TS run == analyze.ts', 'identical', '', '', String(m['analyze_py_on_ts_run_equals_analyze_ts'])]);
    }
    const rfc = r['results_file'] as Json | undefined;
    if (rfc) rows.push([String(r['id']), `= results/${String(rfc['file']).split('/').pop()}`, 'identical', String(rfc['identical'] ?? 'missing'), '', '']);
    rows.push([String(r['id']), 'run time (s)', '', ((ts['ms'] as number) / 1000).toFixed(1), py ? ((py['ms'] as number) / 1000).toFixed(1) : '-', '']);
  }
  return textTable(rows);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cases = (opt('--cases') ?? 'a,b,c,e,f,g,h,d').split(',');
  const evalResults = opt('--eval-results') ?? process.env['KITZUR_EVAL_RESULTS'] ?? null;
  const refDir = opt('--ref') ?? process.env['KITZUR_REF_DIR'];
  const ref = argv.includes('--no-python') ? null : refHarness(refDir);
  const gob = opt('--gob') ?? gobstopperBin(refDir);
  const log = (s: string): void => console.log(s);
  if (!benchTokenizerPath()) throw new Error('no tokenizer.json (scripts/fetch-tokenizer.sh or KITZUR_BENCH_TOKENIZER)');
  if (!ref) log(argv.includes('--no-python') ? 'Python harness disabled (--no-python)' : 'Python harness not found (set KITZUR_REF_DIR): TS side only');
  const versions: Json = { node: process.version };
  if (gob) versions['gobstopper'] = run(gob, ['--version']).stdout.trim();
  if (ref) versions['python'] = run(ref.python, ['-c', 'import sys, tokenizers; print(sys.version.split()[0], "tokenizers", tokenizers.__version__)']).stdout.trim();
  versions['tokenizer_sha256'] = sha(readFileSync(benchTokenizerPath()!));
  versions['codeVersion'] = codeVersion();
  const fresh: Json[] = [];
  for (const c of RUN_CASES) if (cases.includes(c.id)) fresh.push(await runCase(c, ref, gob, evalResults, log));
  if (cases.includes('d')) fresh.push(caseD(ref, evalResults, log));
  const stamp = new Date().toISOString();
  for (const r of fresh) r['generated'] = stamp;
  // a subset run (--cases) replaces only its own cases in crosscheck.json; the others are kept as they were
  const xcPath = join(RESULTS_DIR, 'crosscheck.json');
  let kept: Json[] = [];
  if (!argv.includes('--fresh') && existsSync(xcPath)) {
    try {
      const prev = JSON.parse(readFileSync(xcPath, 'utf8')) as { generated?: string; results?: Json[] };
      kept = (prev.results ?? []).filter((r) => !fresh.some((f) => f['id'] === r['id'])).map((r) => ({ generated: prev.generated, ...r }));
    } catch {
      kept = [];
    }
  }
  const order = 'abcedfgh';
  const results = [...kept, ...fresh].sort((x, y) => order.indexOf(String(x['id'])) - order.indexOf(String(y['id'])));
  const table = printTable(fresh);
  console.log('\n' + table);
  mkdirSync(RESULTS_DIR, { recursive: true });
  // stdout texts are large; keep them in raw/, not in the committed summary
  const slim = results.map((r) => {
    const x = structuredClone(r);
    for (const side of ['ts', 'py', 'ts_long_continue']) {
      const s = x[side] as Json | undefined;
      if (s) {
        delete s['stdout'];
        delete s['gobstopper_status'];
      }
    }
    return x;
  });
  // the committed summary must not carry machine-specific absolute paths
  const subs: Array<[string, string]> = [[ROOT, '.']];
  if (ref) subs.push([ref.dir, '$KITZUR_REF_DIR']);
  if (evalResults) subs.push([evalResults, '$KITZUR_EVAL_RESULTS']);
  const portable = (_k: string, v: unknown): unknown => (typeof v === 'string' ? subs.reduce((t, [a, b]) => t.split(a).join(b), v) : v);
  writeFileSync(xcPath, JSON.stringify({ generated: stamp, versions, results: slim, table: printTable(results) }, portable, 1) + '\n');
  writeFileSync(join(RAW_RESULTS_DIR, `crosscheck-full-${cases.join('')}.json`), JSON.stringify({ versions, results: fresh }, null, 1) + '\n');
  console.log(`\nwrote ${join(RESULTS_DIR, 'crosscheck.json')}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
