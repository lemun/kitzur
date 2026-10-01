// Port of reference-harness sim/baseline.py: OpenCode's built-in compaction mechanics simulated offline on
// the reference session (no HTTP, no model: the summary is a placeholder of `summaryTokens`).
// With the defaults its stdout is byte-identical to `SIM_CAP_BYTES=51200 python baseline.py`
// (6 compactions, 462,169 tokens rejected, 2,492,784 total) [MEASURED by bench/crosscheck.ts].
//
//   node dist/bench/opencode-sim.js [--summary-tokens N] [--steps N] [--limit N] [--max-out N]
//                                   [--cap-bytes N] [--chatty] [--long-continue]
//   (SIM_CAP_BYTES / SIM_CHATTY / SIM_HUGE_AT / SIM_HUGE_CHARS are honoured like scenario.py; flags win)
//
// Modelled (READ from OpenCode source, reference implementation): the trigger `usable = context -
// min(output, 32000)` on the last step's prompt+completion, plus provider overflow errors (up to 3
// attempts per step); the verbatim tail = newest user-turns within preserve_recent_tokens =
// min(15000, max(2000, usable*25//100)) estimated as spaced-JSON chars/4, splitting the newest turn at
// unit granularity; the summarizer input = head serialized with tool results cut to 2000 chars + the
// previous summary + ~2400 template chars; after compaction the model sees [system, "What did we do so
// far?", summary, tail, "Continue..."]. Kept quirks: `keep == 0` summarizes EVERYTHING (the goal is
// never kept verbatim), the fact set is sticky, summ_in concatenates text+prior with no separator, a 3rd
// compaction happens even when the step then fails.
//
// `continueText: 'long'`: real OpenCode appends a longer "Continue" message after a provider overflow
// (compaction.ts:527-531, reference implementation); baseline.py used the short one for all compactions.
// The default stays 'short' so the Python numbers are reproduced; 'long' is reported separately.

import { pathToFileURL } from 'node:url';
import type { ChatMessage } from '../src/types.js';
import { pyDumps, pyLen, pySliceHead, cmpCodePoints } from './lib/pyjson.js';
import { PromptCounter } from './lib/render.js';
import { fmtInt } from './lib/stats.js';
import { benchTokenizer } from './lib/paths.js';
import {
  assistantMessage, FACT_KEYS, FACT_SHORT, GOAL_TEXT, scenarioOptionsFromEnv, systemPrompt, toolOutput,
  tools as scenarioTools, USER_INJECT, pyInt, type ScenarioOptions,
} from './scenarios/reference.js';

export const CONTINUE_SHORT = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
export const CONTINUE_AFTER_OVERFLOW =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was " +
  'compacted and media files were removed from context. If the user was asking about attached images or files, ' +
  'explain that the attachments were too large to process and suggest they try again with smaller or fewer files.' +
  '\n\n' + CONTINUE_SHORT;
const OVERFLOW_REASON = 'provider overflow error';

export interface OpenCodeSimOptions {
  counter: PromptCounter;
  summaryTokens?: number;
  steps?: number;
  limit?: number;
  maxOut?: number;
  scenario?: ScenarioOptions;
  continueText?: 'short' | 'long';
}

export interface CompactionRow {
  n: number;
  step: number;
  reason: string;
  before: number;
  after: number;
  summ_in: number;
  head_units: number;
  tail_units: number;
  goal_verbatim: boolean;
  visible: Record<string, boolean>;
  tail_has: Record<string, boolean>;
}

export interface OpenCodeSimResult {
  /** exactly what baseline.py prints */
  stdout: string;
  totals: {
    main: number; rejected: number; summ_in: number; summ_out: number; compactions: number;
    overflow_errors: number; completion: number; total_prompt_tokens: number; rewrites: Record<string, number>;
  };
  rows: CompactionRow[];
  /** every provider request (prompt tokens), in order: the per-request sequence */
  requests: Array<{ step: number; attempt: number; prompt: number; accepted: boolean }>;
  stepsCompleted: number;
  failedAt: number | null;
}

type Unit = ChatMessage[];

export function runOpenCodeSim(o: OpenCodeSimOptions): OpenCodeSimResult {
  const summaryTokens = o.summaryTokens ?? 1500;
  const steps = o.steps ?? 46;
  const limit = o.limit ?? 100_000;
  const maxOut = o.maxOut ?? 32_000;
  const sc = o.scenario ?? {};
  const counter = o.counter;
  const USABLE = limit - maxOut;
  const PRESERVE = Math.min(15_000, Math.max(2_000, Math.floor((USABLE * 25) / 100)));
  const TEMPLATE_CHARS = 2400; // SUMMARY_TEMPLATE + instructions, approx
  const system: ChatMessage = { role: 'system', content: systemPrompt() };
  const tools = scenarioTools();
  const goal: ChatMessage = { role: 'user', content: GOAL_TEXT };
  const out: string[] = [];

  // est(msgs) = len(json.dumps(msgs, ensure_ascii=False)) // 4, computed from cached per-message dump
  // lengths: "[" + ", ".join(items) + "]" is additive in code points (the separators are ASCII).
  const dumpLen = new WeakMap<object, number>();
  const mlen = (m: ChatMessage): number => {
    let n = dumpLen.get(m);
    if (n === undefined) dumpLen.set(m, (n = pyLen(pyDumps(m, { ensureAscii: false }))));
    return n;
  };
  const est = (msgs: ChatMessage[]): number => Math.floor((msgs.length ? 2 + msgs.reduce((a, m) => a + mlen(m), 0) + 2 * (msgs.length - 1) : 2) / 4);
  const flat = (us: Unit[]): ChatMessage[] => us.flat();

  const serialize = (unit: Unit): string => {
    const lines: string[] = [];
    for (const m of unit) {
      if (m.role === 'user') lines.push(`[User]: ${m.content as string}`);
      else if (m.role === 'assistant') {
        if (m.content) lines.push(`[Assistant]: ${m.content as string}`);
        for (const c of m.tool_calls || []) lines.push(`[Assistant tool call]: ${c.function.name}(${c.function.arguments})`);
      } else if (m.role === 'tool') {
        const t = m.content as string;
        lines.push('[Tool result]: ' + (pyLen(t) <= 2000 ? t : pySliceHead(t, 2000) + '\n[truncated]'));
      }
    }
    return lines.join('\n');
  };

  let units: Unit[] = [[goal]];
  let summary: [string, Set<string>] | null = null;
  const rows: CompactionRow[] = [];
  const totals = { main: 0, rejected: 0, summ_in: 0, summ_out: 0, compactions: 0, overflow_errors: 0, completion: 0 };
  const rewrites = new Map<string, number>(FACT_KEYS.map((f) => [f, 0]));
  const requests: OpenCodeSimResult['requests'] = [];

  const context = (): ChatMessage[] => {
    const msgs = [system];
    if (summary !== null) {
      msgs.push({ role: 'user', content: 'What did we do so far?' });
      msgs.push({ role: 'assistant', content: summary[0] });
    }
    for (const u of units) msgs.push(...u);
    return msgs;
  };

  const compact = (step: number, reason: string, before: number): void => {
    // turns start at user units
    const starts = units.map((u, i) => (u[0]!.role === 'user' ? i : -1)).filter((i) => i >= 0);
    let keep: number | null = null;
    let total = 0;
    for (let t = starts.length - 1; t >= 0; t--) {
      const s = starts[t]!;
      const e = t + 1 < starts.length ? starts[t + 1]! : units.length;
      const size = est(flat(units.slice(s, e)));
      if (total + size <= PRESERVE) {
        total += size;
        keep = s;
        continue;
      }
      for (let s2 = s + 1; s2 < e; s2++) {
        if (est(flat(units.slice(s2, e))) <= PRESERVE - total) {
          keep = s2;
          break;
        }
      }
      break;
    }
    let head: Unit[];
    let tail: Unit[];
    if (keep === null || keep === 0) {
      head = units;
      tail = [];
    } else {
      head = units.slice(0, keep);
      tail = units.slice(keep);
    }
    const text = head.map(serialize).join('\n\n');
    const prior = summary ? summary[0] : '';
    const summIn = counter.countText(text + prior) + Math.floor(TEMPLATE_CHARS / 4);
    const prev = summary;
    const visible = new Set(FACT_KEYS.filter((f) => text.includes(f) || (prev !== null && prev[1].has(f))));
    const tailDumps = tail.map((u) => pyDumps(u));
    for (const f of FACT_KEYS) if (visible.has(f) && !tailDumps.some((d) => d.includes(f))) rewrites.set(f, rewrites.get(f)! + 1);
    const filler = ('- ' + 'summary bullet '.repeat(6) + '\n').repeat(Math.floor(summaryTokens / 14));
    summary = [filler + '\n' + [...visible].sort(cmpCodePoints).join(' '), visible];
    const cont = o.continueText === 'long' && reason === OVERFLOW_REASON ? CONTINUE_AFTER_OVERFLOW : CONTINUE_SHORT;
    units = [...tail, [{ role: 'user', content: cont }]];
    const after = counter.countBody({ messages: context(), tools });
    totals.summ_in += summIn;
    totals.summ_out += summaryTokens;
    totals.compactions += 1;
    rows.push({
      n: totals.compactions, step, reason, before, after, summ_in: summIn, head_units: head.length, tail_units: tail.length,
      goal_verbatim: tail.some((u) => u.some((m) => m === goal)), // object identity, like Python's `is`
      visible: Object.fromEntries(FACT_KEYS.map((f) => [FACT_SHORT.get(f)!, visible.has(f)])),
      tail_has: Object.fromEntries(FACT_KEYS.map((f) => [FACT_SHORT.get(f)!, tailDumps.some((d) => d.includes(f))])),
    });
  };

  let stepsCompleted = 0;
  let failedAt: number | null = null;
  for (let step = 0; step < steps; step++) {
    let prompt = 0;
    let fit = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      prompt = counter.countBody({ messages: context(), tools });
      if (prompt + maxOut > limit) {
        requests.push({ step, attempt, prompt, accepted: false });
        totals.rejected += prompt;
        totals.overflow_errors += 1;
        compact(step, OVERFLOW_REASON, prompt);
        continue;
      }
      requests.push({ step, attempt, prompt, accepted: true });
      fit = true;
      break;
    }
    if (!fit) {
      out.push(`step ${step}: could not fit after compaction`);
      failedAt = step;
      break;
    }
    totals.main += prompt;
    const msg = assistantMessage(step, sc);
    const completion = counter.countText((msg.content || '') + pyDumps(msg.tool_calls));
    totals.completion += completion;
    units.push([msg, { role: 'tool', tool_call_id: msg.tool_calls[0]!.id, content: toolOutput(step, sc) }]);
    const inj = USER_INJECT.get(step);
    if (inj !== undefined) units.push([{ role: 'user', content: inj }]);
    stepsCompleted++;
    if (prompt + completion >= USABLE) compact(step + 1, 'reported tokens >= usable (68k)', prompt + completion);
  }

  out.push(`usable=${USABLE} preserve_recent_tokens=${PRESERVE} summary_tokens=${summaryTokens}`);
  const shorts = FACT_KEYS.map((f) => FACT_SHORT.get(f)!);
  out.push('| # | before next step | reason | before (Qwen) | after (Qwen) | summarizer input (Qwen) | goal msg verbatim | ' + shorts.join(' | ') + ' |');
  out.push('|' + '---|'.repeat(7 + FACT_KEYS.length));
  const plant: Record<string, number> = {
    'GOAL-CHK-7F3A': 0, 'staging-3.override.yaml': 2, 'DECISION-D42': 3, 'TODO-P3-RETRY': 4,
    'src/pages/legacy/PromoBanner.ts': 6, 'USER-RULE-Q7': 10, 'UNFINISHED-9K': 15,
  };
  for (const r of rows) {
    const cells = FACT_KEYS.map((f) => {
      const s = FACT_SHORT.get(f)!;
      return r.step < plant[f]! ? '·' : r.tail_has[s] ? 'tail' : r.visible[s] ? 'sum' : '✗';
    });
    out.push(
      `| ${r.n} | ${r.step} | ${r.reason} | ${fmtInt(r.before)} | ${fmtInt(r.after)} | ${fmtInt(r.summ_in)} | ` +
        `${r.goal_verbatim ? 'yes' : 'no'} | ` + cells.join(' | ') + ' |',
    );
  }
  const tot = totals.main + totals.rejected + totals.summ_in;
  const final = { ...totals, total_prompt_tokens: tot, rewrites: Object.fromEntries(FACT_KEYS.map((f) => [FACT_SHORT.get(f)!, rewrites.get(f)!])) };
  out.push(pyDumps(final));
  return { stdout: out.join('\n') + '\n', totals: final, rows, requests, stepsCompleted, failedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const scenario: ScenarioOptions = scenarioOptionsFromEnv(process.env);
  const opts: Omit<OpenCodeSimOptions, 'counter'> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = (): number => pyInt(args[++i] ?? '');
    if (a === '--summary-tokens') opts.summaryTokens = val();
    else if (a === '--steps') opts.steps = val();
    else if (a === '--limit') opts.limit = val();
    else if (a === '--max-out') opts.maxOut = val();
    else if (a === '--cap-bytes') scenario.capBytes = val();
    else if (a === '--chatty') scenario.chatty = true;
    else if (a === '--long-continue') opts.continueText = 'long';
    else {
      console.error(`unknown argument ${a}`);
      process.exit(2);
    }
  }
  process.stdout.write(runOpenCodeSim({ ...opts, scenario, counter: new PromptCounter(benchTokenizer()) }).stdout);
}
