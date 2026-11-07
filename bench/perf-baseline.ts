// Planner performance baseline: the engine (estimate counter, real summarizer and rules, in process, no
// tokenizer, no network, no listener) over the reference coding-agent history at three sizes and two windows.
// Per case: deterministic results and the median planner time of 5 runs divided by a fixed CPU-bound
// calibration loop timed in the same process (a machine-relative cost, not milliseconds). Default: a table;
// --check: compare with bench/baselines/engine-perf.json (exit 1 on a regression); --update: rewrite it (refused
// under CI=true); --json: machine-readable output. See bench/baselines/README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { ChatMessage, ChatRequest } from '../src/types.js';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/engine/engine.js';
import { createSummarizer } from '../src/engine/summary.js';
import { createToolRules } from '../src/engine/rules/index.js';
import { counterFromConfig } from '../src/tokenize/counter.js';
import { assistantMessage, initialHistory, toolOutput, tools as scenarioTools, USER_INJECT } from './scenarios/reference.js';
import { ROOT } from './lib/paths.js';

export const BASELINE_PATH = join(ROOT, 'bench', 'baselines', 'engine-perf.json');
export const REFRESH = 'npm run build && node dist/bench/perf-baseline.js --update';
export const SLOWDOWN = 1.5;
export const RUNS = 5;
export const REQUESTS = 40;
export const CASES: readonly Case[] = [200, 1000, 4000].flatMap((messages) => ['32k', '100k'].map((window) => ({ messages, window })));

export interface Case { messages: number; window: string }
export interface Results { requests: number; tokensIn: number; tokensOut: number; compactions: number; retention: Record<string, number> }
export interface CaseRecord { results: Results; relCost: number }
export interface Baseline { schema: 1; date: string; cases: Record<string, CaseRecord> }
export type Clock = () => number;

const hrNow: Clock = () => performance.now();
export const caseKey = (c: Case): string => `${c.messages}msg@${c.window}`;

/** The reference history grown step by step to at least `n` messages, sent at `requests` evenly spaced boundaries. */
function* session(n: number, requests = REQUESTS): Generator<ChatMessage[]> {
  const msgs = initialHistory() as ChatMessage[];
  let next = n / requests;
  for (let step = 0; msgs.length < n; step++) {
    const a = assistantMessage(step) as ChatMessage;
    msgs.push(a);
    for (const c of a.tool_calls ?? []) msgs.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(step, { capBytes: 4096 }) });
    const inj = USER_INJECT.get(step);
    if (inj !== undefined) msgs.push({ role: 'user', content: inj });
    if (msgs.length < next && msgs.length < n) continue;
    next += n / requests;
    yield msgs;
  }
}

/** One planner run of a case: deterministic results and the engine time in clock units. */
export function runCase(c: Case, now: Clock = hrNow): { results: Results; ms: number } {
  const cfg = loadConfig({ preset: c.window, env: {}, sets: ['calibration.enabled=false'] }).config;
  const counter = counterFromConfig(cfg);
  const e = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg), faults: null });
  const tools = scenarioTools();
  const results: Results = { requests: 0, tokensIn: 0, tokensOut: 0, compactions: 0, retention: {} };
  let ms = 0;
  for (const msgs of session(c.messages)) {
    const req = { model: 'qwen', messages: msgs.slice(), tools, max_tokens: cfg.budget.defaultMaxTokens } as ChatRequest;
    const t0 = now();
    const r = e.process(req, { attempt: 1 });
    ms += now() - t0;
    Object.assign(results, { requests: results.requests + 1, compactions: r.plan?.compactions ?? 0, tokensIn: r.stats.tokensIn, tokensOut: r.stats.tokensOut, retention: { ...r.stats.retention } });
  }
  return { results, ms };
}

let sink = 0;
/** A fixed CPU-bound loop (integer hashing), in clock units. */
export function calibrate(now: Clock = hrNow, iterations = 100_000_000): number {
  const t0 = now();
  let h = 0x811c9dc5;
  for (let i = 0; i < iterations; i++) h = Math.imul(h ^ i, 0x01000193) >>> 0;
  const ms = now() - t0;
  sink ^= h; // keeps the loop observable
  return ms;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number): number => Math.round(x * 1000) / 1000;

export function measure(cases: readonly Case[] = CASES, o: { runs?: number; now?: Clock; calibrate?: () => number } = {}): Record<string, CaseRecord> {
  const runs = o.runs ?? RUNS;
  const cal = o.calibrate ?? (() => calibrate(o.now));
  const out: Record<string, CaseRecord> = {};
  for (const c of cases) {
    const cals: number[] = [];
    const rs = Array.from({ length: runs }, () => (cals.push(cal()), runCase(c, o.now)));
    out[caseKey(c)] = { results: rs.at(-1)!.results, relCost: round(median(rs.map((r) => r.ms)) / Math.max(median(cals), 1e-9)) };
  }
  return out;
}

/** Schema errors of a parsed baseline file (empty = valid). */
export function validateBaseline(x: unknown): string[] {
  const errs: string[] = [];
  const b = x as Partial<Baseline> | null;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return ['baseline: not a JSON object'];
  if (b.schema !== 1) errs.push(`baseline: schema must be 1, got ${JSON.stringify(b.schema)}`);
  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) errs.push('baseline: date must be YYYY-MM-DD');
  if (b.cases === null || typeof b.cases !== 'object' || Array.isArray(b.cases)) return [...errs, 'baseline: cases must be an object'];
  for (const [k, v] of Object.entries(b.cases)) {
    const r = (v as Partial<CaseRecord> | null)?.results as Partial<Results> | undefined;
    if (!(typeof v?.relCost === 'number' && v.relCost > 0)) errs.push(`baseline: ${k}.relCost must be a positive number`);
    const nums = ['requests', 'tokensIn', 'tokensOut', 'compactions'] as const;
    if (!r || nums.some((n) => !Number.isInteger(r[n])) || r.retention === null || typeof r.retention !== 'object') errs.push(`baseline: ${k}.results is malformed`);
  }
  return errs;
}

/** Regressions of `current` against `baseline` (empty = pass). */
export function compare(baseline: Baseline, current: Record<string, CaseRecord>, slowdown = SLOWDOWN): string[] {
  const out: string[] = [];
  for (const [k, cur] of Object.entries(current)) {
    const base = baseline.cases[k];
    if (!base) {
      out.push(`${k}: missing from the baseline; refresh it with: ${REFRESH}`);
      continue;
    }
    const was = stableJSON(base.results, 0).trimEnd();
    const now = stableJSON(cur.results, 0).trimEnd();
    if (was !== now) out.push(`${k}: planner output changed: baseline ${was}, now ${now}; if intended, refresh with: ${REFRESH}`);
    if (cur.relCost > base.relCost * slowdown)
      out.push(`${k}: relative cost ${cur.relCost} exceeds the baseline ${base.relCost} by more than ${Math.round((slowdown - 1) * 100)}% (${round(cur.relCost / base.relCost)}x); if intended, refresh with: ${REFRESH}`);
  }
  for (const k of Object.keys(baseline.cases)) if (!(k in current)) out.push(`${k}: in the baseline but not measured; refresh with: ${REFRESH}`);
  return out;
}

/** JSON with sorted keys and a trailing newline; objects from depth `compact` on (case records) on one line. */
export function stableJSON(x: unknown, compact = 2): string {
  const fmt = (v: unknown, pad: string): string => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return JSON.stringify(v);
    const keys = Object.keys(v).sort();
    const o = v as Record<string, unknown>;
    if (pad.length >= 2 * compact) return `{${keys.map((k) => `${JSON.stringify(k)}:${fmt(o[k], pad)}`).join(',')}}`;
    return keys.length ? `{\n${keys.map((k) => `${pad}  ${JSON.stringify(k)}: ${fmt(o[k], pad + '  ')}`).join(',\n')}\n${pad}}` : '{}';
  };
  return fmt(x, '') + '\n';
}

export interface MainDeps {
  env?: Record<string, string | undefined>;
  log?: (s: string) => void;
  measure?: () => Record<string, CaseRecord>;
  baselinePath?: string;
  today?: () => string;
}

export function main(argv: string[], d: MainDeps = {}): number {
  const env = d.env ?? process.env;
  const log = d.log ?? ((s: string) => console.log(s));
  const path = d.baselinePath ?? BASELINE_PATH;
  const update = argv.includes('--update');
  if (update && env['CI'] === 'true') {
    log(`perf-baseline: --update refused under CI=true; refresh the baseline locally with: ${REFRESH}`);
    return 2;
  }
  const current = (d.measure ?? (() => measure()))();
  if (argv.includes('--json')) log(stableJSON({ cases: current }).trimEnd());
  else for (const [k, r] of Object.entries(current)) log(`${k.padEnd(14)} relCost ${String(r.relCost).padStart(8)}  ${JSON.stringify(r.results)}`);
  if (update) {
    const date = (d.today ?? (() => new Date().toISOString().slice(0, 10)))();
    writeFileSync(path, stableJSON({ schema: 1, date, cases: current } satisfies Baseline));
    log(`perf-baseline: wrote ${d.baselinePath ?? 'bench/baselines/engine-perf.json'}`);
    return 0;
  }
  if (!argv.includes('--check')) return 0;
  let baseline: unknown;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`perf-baseline: cannot read the baseline (${(err as Error).message}); create it with: ${REFRESH}`);
    return 1;
  }
  const errs = validateBaseline(baseline);
  const fails = errs.length ? errs.map((e) => `${e}; regenerate it with: ${REFRESH}`) : compare(baseline as Baseline, current);
  for (const f of fails) log(`perf-baseline: FAIL ${f}`);
  if (!fails.length) log('perf-baseline: ok (timing band: within 50% of the baseline relative cost)');
  return fails.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
