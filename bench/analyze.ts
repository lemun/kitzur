// Port of reference-harness sim/analyze.py: per-compaction table, fact survival, totals for one run
// directory. The text and the final JSON summary line are byte-identical to analyze.py's stdout for
// the same run directory (checked by bench/crosscheck.ts, which runs both on the same run dirs).
//
//   node dist/bench/analyze.js RUN_DIR
//
// Inputs (reference layout): client.jsonl, ledger.jsonl (gobstopper-compatible, ONE record per client
// request, in order), mock.jsonl, origs/step{N}.json, reqs/{seq:04d}_step{N}.json, proxy.args.
// Definitions (reference implementation):
//  - a compaction row = ledger `compacted` OR more than one upstream attempt for that step (reactive);
//  - b2b = compaction rows exactly one step after the previous compaction row;
//  - sent_total = Σ prompt_tokens of ALL upstream attempts; peak = max accepted prompt;
//  - planted[f] = first client step whose origs messages contain f; a fact survives if every row with
//    step >= planted and an upstream attempt has f in its LAST attempt's messages (rejected ones included).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pyDumps, pyLen, cmpCodePoints } from './lib/pyjson.js';
import { contentText } from './lib/render.js';
import { fmtInt, maxOr, pyCount, pyFixed, pyStrip, sum } from './lib/stats.js';
import { FACTS, FACT_KEYS, FACT_SHORT, pad4, SUMMARY_HEADER } from './scenarios/reference.js';

type Json = Record<string, unknown>;

export function readJsonlFile(path: string): Json[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => JSON.parse(l) as Json);
}

/**
 * Python os.path.basename (posix): everything after the last "/", so "runs/X/" gives "" (Node's
 * path.basename would give "X"). analyze.py prints it in the first line.
 */
export const pyBasename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Python str() of a value inside an f-string. */
function pyS(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** Python f"{v:,}": only ints are valid here (analyze.py crashes on '-'). */
function pyComma(v: unknown): string {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`Cannot specify ',' with ${typeof v === 'string' ? "'s'" : pyS(v)}.`);
  return fmtInt(v);
}

function toolKind(name: string): string {
  if (name.startsWith('browser_')) return 'snapshot';
  if (name === 'read') return 'read';
  if (name === 'bash') return 'test/bash';
  return name;
}

export interface DroppedInfo {
  dropped: Map<string, [number, number]>;
  short_results_in_summary: number;
  kept_tool_results: number;
  sent_messages: number;
  orig_messages: number;
  summary_chars: number;
}

export interface Row {
  step: number;
  orig_qwen: number;
  orig_est: number;
  sent_qwen: number | null;
  attempts: number;
  length_rejections: number;
  pairing_errors: string[];
  client_status: number;
  compacted: boolean;
  reused: boolean;
  rung: unknown;
  over_budget: unknown;
  est_out: unknown;
  summary_est: unknown;
  carry_chars: unknown;
  threshold: unknown;
  ratio: unknown;
  facts: Record<string, boolean>;
  reactive: boolean;
  compaction_no?: number;
  drop?: DroppedInfo | null;
}

export interface AnalyzeSummary {
  compactions: number;
  b2b: number;
  sent_total: number;
  rejections: number;
  client_errors: number;
  steps_ok: number;
  survival: Record<string, boolean>;
  peak: number;
}

export interface Analysis {
  rows: Row[];
  planted: Map<string, number>;
  b2b: number;
  mock: Json[];
  client: Json[];
  ledger: Json[];
}

const loadMessages = (p: string): Json[] => (JSON.parse(readFileSync(p, 'utf8')) as Json)['messages'] as Json[];

function dropped(run: string, step: number, seq: number | null): DroppedInfo | null {
  const origP = join(run, 'origs', `step${step}.json`);
  const sentP = seq ? join(run, 'reqs', `${pad4(seq)}_step${step}.json`) : null;
  if (!existsSync(origP) || !sentP || !existsSync(sentP)) return null;
  const orig = loadMessages(origP);
  const sent = loadMessages(sentP);
  const calls = new Map<string, string>();
  for (const m of orig) {
    for (const tc of (m['tool_calls'] as Json[] | null | undefined) || []) {
      const f = tc['function'] as Json;
      calls.set(tc['id'] as string, toolKind(f['name'] as string));
    }
  }
  const sentIds = new Set(sent.filter((m) => m['role'] === 'tool').map((m) => m['tool_call_id'] ?? null));
  const summaryMsg = sent.find((m) => contentText(m['content']).startsWith(SUMMARY_HEADER));
  const summary = summaryMsg ? contentText(summaryMsg['content']) : '';
  const drop = new Map<string, [number, number]>();
  let inSummary = 0;
  const budget = new Map<string, number>();
  for (const m of orig) {
    if (m['role'] !== 'tool' || sentIds.has(m['tool_call_id'] ?? null)) continue;
    const k = calls.get(m['tool_call_id'] as string) ?? '?';
    const content = m['content'] as string;
    const key = 'result: ' + pyStrip(content);
    if (!budget.has(key)) budget.set(key, pyCount(summary, key));
    if (pyLen(content) <= 500 && budget.get(key)! > 0) {
      budget.set(key, budget.get(key)! - 1);
      inSummary += 1;
      continue;
    }
    let d = drop.get(k);
    if (!d) drop.set(k, (d = [0, 0]));
    d[0] += 1;
    d[1] += pyLen(content);
  }
  return {
    dropped: drop,
    short_results_in_summary: inSummary,
    kept_tool_results: sent.filter((m) => m['role'] === 'tool').length,
    sent_messages: sent.length,
    orig_messages: orig.length,
    summary_chars: pyLen(summary),
  };
}

export function analyze(run: string): Analysis {
  const client = readJsonlFile(join(run, 'client.jsonl'));
  const ledger = readJsonlFile(join(run, 'ledger.jsonl'));
  const mock = readJsonlFile(join(run, 'mock.jsonl'));
  const byStepMock = new Map<number, Json[]>();
  for (const m of mock) {
    const s = m['step'] as number;
    if (!byStepMock.has(s)) byStepMock.set(s, []);
    byStepMock.get(s)!.push(m);
  }
  // ledger has one record per client request, in order
  const led = new Map<number, Json>();
  client.forEach((c, i) => {
    if (i < ledger.length) led.set(c['step'] as number, ledger[i]!);
  });
  const planted = new Map<string, number>();
  for (const c of client) {
    const p = join(run, 'origs', `step${c['step'] as number}.json`);
    if (!existsSync(p)) continue;
    const blob = pyDumps(loadMessages(p), { ensureAscii: false });
    for (const f of FACT_KEYS) if (blob.includes(f) && !planted.has(f)) planted.set(f, c['step'] as number);
  }
  const rows: Row[] = [];
  let compI = 0;
  let prev: number | null = null;
  let b2b = 0;
  for (const c of client) {
    const s = c['step'] as number;
    const attempts = byStepMock.get(s) ?? [];
    const last: Json = attempts.length ? attempts[attempts.length - 1]! : {};
    const L = led.get(s) ?? {};
    const row: Row = {
      step: s,
      orig_qwen: c['orig_qwen_tokens'] as number,
      orig_est: c['orig_est_tokens'] as number,
      sent_qwen: (last['prompt_tokens'] as number | undefined) ?? null,
      attempts: attempts.length,
      length_rejections: attempts.filter((a) => a['rejected_for_length']).length,
      pairing_errors: attempts.filter((a) => a['pairing_error']).map((a) => a['pairing_error'] as string),
      client_status: c['status'] as number,
      compacted: (L['compacted'] as boolean | undefined) ?? false,
      reused: (L['reused_prefix'] as boolean | undefined) ?? false,
      rung: L['rung'],
      over_budget: L['over_budget'],
      est_out: L['est_tokens_out'],
      summary_est: L['est_summary_tokens'],
      carry_chars: L['carry_chars'],
      threshold: L['threshold_tokens'],
      ratio: L['ratio_permille'],
      facts: (last['facts'] as Record<string, boolean> | undefined) ?? {},
      reactive: attempts.length > 1, // reactive retries also rewrite the request even when the ledger says not compacted
    };
    if (row.compacted || row.reactive) {
      compI += 1;
      row.compaction_no = compI;
      if (prev !== null && s - prev === 1) b2b += 1;
      prev = s;
      row.drop = dropped(run, s, attempts.length ? (attempts[attempts.length - 1]!['seq'] as number) : null);
    }
    rows.push(row);
  }
  return { rows, planted, b2b, mock, client, ledger };
}

function fmtDrop(d: Map<string, [number, number]> | undefined): string {
  if (!d || !d.size) return '-';
  return [...d.entries()]
    .sort((a, b) => cmpCodePoints(a[0], b[0]))
    .map(([k, v]) => `${v[0]} ${k} (${Math.floor(v[1] / 1000)}k ch)`)
    .join(', ');
}

const missing = (a: Analysis, f: string): number[] => {
  const p = a.planted.get(f)!;
  return a.rows.filter((r) => r.step >= p && r.sent_qwen !== null && !r.facts[f]).map((r) => r.step);
};

export function summarize(a: Analysis): AnalyzeSummary {
  const comps = a.rows.filter((r) => r.compaction_no);
  const survival: Record<string, boolean> = {};
  for (const f of FACT_KEYS) survival[FACT_SHORT.get(f)!] = a.planted.has(f) && missing(a, f).length === 0;
  return {
    compactions: comps.length,
    b2b: a.b2b,
    sent_total: sum(a.mock.map((m) => m['prompt_tokens'] as number)),
    rejections: a.mock.filter((m) => m['rejected_for_length']).length,
    client_errors: a.rows.filter((r) => r.client_status !== 200).length,
    steps_ok: a.rows.filter((r) => r.client_status === 200).length,
    survival,
    peak: maxOr(a.mock.filter((m) => m['status'] === 200).map((m) => m['prompt_tokens'] as number), 0),
  };
}

/** analyze.report(run): [text, summary]. */
export function report(run: string): { text: string; summary: AnalyzeSummary; analysis: Analysis } {
  const a = analyze(run);
  const { rows, planted, mock } = a;
  const comps = rows.filter((r) => r.compaction_no);
  const lines: string[] = [];
  const argsPath = join(run, 'proxy.args');
  const args = existsSync(argsPath) ? readFileSync(argsPath, 'utf8') : '(direct)';
  const sentTotal = sum(mock.map((m) => m['prompt_tokens'] as number));
  const okTotal = sum(mock.filter((m) => m['status'] === 200).map((m) => m['prompt_tokens'] as number));
  const compl = sum(mock.map((m) => (m['completion_tokens'] as number | undefined) ?? 0));
  const origTotal = sum(rows.map((r) => r.orig_qwen));
  lines.push(`### Run \`${pyBasename(run)}\` — proxy args: \`${args}\`\n`);
  lines.push(
    `- steps completed: ${rows.filter((r) => r.client_status === 200).length}/${rows.length}; ` +
      `client-visible errors: ${rows.filter((r) => r.client_status !== 200).length}`,
  );
  lines.push(
    `- upstream requests: ${mock.length}; length rejections upstream: ` +
      `${mock.filter((m) => m['rejected_for_length']).length}; pairing errors: ` +
      `${mock.filter((m) => m['pairing_error']).length}`,
  );
  lines.push(
    `- prompt tokens processed (Qwen count, all upstream attempts): ${fmtInt(sentTotal)} ` +
      `(accepted: ${fmtInt(okTotal)}); completion: ${fmtInt(compl)}; ` +
      `what the agent would have sent without compaction: ${fmtInt(origTotal)}`,
  );
  lines.push(
    `- compactions: ${comps.length}; back-to-back (consecutive steps): ${a.b2b}; ` +
      `peak accepted prompt: ${fmtInt(maxOr(mock.filter((m) => m['status'] === 200).map((m) => m['prompt_tokens'] as number), 0))}`,
  );
  const ratios = rows.filter((r) => r.ratio).map((r) => r.ratio as number);
  if (ratios.length) lines.push(`- calibration ratio applied: first ${pyFixed(ratios[0]! / 1000, 2)}, last ${pyFixed(ratios[ratios.length - 1]! / 1000, 2)}`);
  lines.push('');
  lines.push(
    '| # | step | before (Qwen / est) | after (Qwen / est) | msgs | rung | dropped tool results | short results kept in summary | summary chars | carry chars | pairs valid | ' +
      FACTS.map((f) => FACT_SHORT.get(f[0])!).join(' | ') + ' |',
  );
  lines.push('|' + '---|'.repeat(11 + FACTS.length));
  for (const r of comps) {
    const cells = FACT_KEYS.map((f) => (!planted.has(f) || r.step < planted.get(f)! ? '·' : r.facts[f] ? '✓' : '✗'));
    const d = r.drop ?? null;
    lines.push(
      `| ${r.compaction_no} | ${r.step} | ${fmtInt(r.orig_qwen)} / ${fmtInt(r.orig_est)} | ` +
        `${fmtInt(r.sent_qwen || 0)} / ${fmtInt((r.est_out as number | null | undefined) || 0)} | ${pyS(d?.orig_messages)}→${pyS(d?.sent_messages)} | ` +
        `${pyS(r.rung)}${' R'.repeat(r.length_rejections)} | ${fmtDrop(d?.dropped)} | ${d ? d.short_results_in_summary : '-'} | ` +
        `${pyComma(d ? d.summary_chars : '-')} | ${pyS(r.carry_chars)} | ${r.pairing_errors.length ? 'NO' : 'yes'} | ` +
        cells.join(' | ') + ' |',
    );
  }
  lines.push('');
  // survival: present in every accepted request after planting?
  lines.push('| fact | channel | planted before step | present in every later request | first step missing |');
  lines.push('|---|---|---|---|---|');
  for (const [f, , channel] of FACTS) {
    const short = FACT_SHORT.get(f)!;
    if (!planted.has(f)) {
      lines.push(`| ${short} | ${channel} | never planted | - | - |`);
      continue;
    }
    const miss = missing(a, f);
    lines.push(`| ${short} | ${channel} | ${planted.get(f)} | ${miss.length ? 'no' : 'yes'} | ${miss.length ? miss[0] : '-'} |`);
  }
  return { text: lines.join('\n'), summary: summarize(a), analysis: a };
}

/** The exact stdout of `python analyze.py RUN_DIR`. */
export function analyzeStdout(run: string): string {
  const { text, summary } = report(run);
  return text + '\n' + pyDumps(summary) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = process.argv[2];
  if (!run) {
    console.error('usage: analyze.js RUN_DIR');
    process.exit(2);
  }
  process.stdout.write(analyzeStdout(run));
}
