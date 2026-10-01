// A small synthetic run directory in the reference layout, built to hit analyze.py's edge cases:
// a proactive compaction (ledger) followed by a reactive one (two upstream attempts) on the next step
// (b2b), a short tool result whose key only matches after Python's str.strip() (it ends in U+0085, which
// JS trim() keeps), a result of 499 astral characters (999 UTF-16 units, <= 500 code points), a
// calibration ratio of 1125 permille (Python prints 1.12, JS toFixed 1.13), an unknown tool call id
// ("?" kind), a client-visible error and an unplanted fact.
// The expected stdout (test/fixtures/bench/analyze_synthetic.txt.gz) was produced by the unmodified
// Python analyze.py on this directory (bench/tools/make-analyze-golden.ts).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pyDumps, pyFloat } from '../../bench/lib/pyjson.js';
import { FACT_KEYS, SUMMARY_HEADER, pad4 } from '../../bench/scenarios/reference.js';

type Msg = Record<string, unknown>;

export function writeSyntheticRun(dir: string): void {
  mkdirSync(join(dir, 'origs'), { recursive: true });
  mkdirSync(join(dir, 'reqs'), { recursive: true });
  const sys: Msg = { role: 'system', content: 'You are an agent.' };
  const goal: Msg = { role: 'user', content: 'Task GOAL-CHK-7F3A: do things.' };
  const call = (id: string, name: string, args: unknown): Msg => ({
    role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: pyDumps(args) } }],
  });
  const tool = (id: string, content: string): Msg => ({ role: 'tool', tool_call_id: id, content });
  const steps: Msg[][] = [
    [call('c0', 'read', { filePath: '/repo/src/pages/legacy/PromoBanner.ts' }), tool('c0', 'ok\u0085')],
    [{ role: 'assistant', content: 'DECISION-D42: use test ids.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] }, tool('c1', '- button "x" [ref=e1]\n'.repeat(60))],
    [call('c2', 'bash', { command: 'npx playwright test' }), tool('c2', '\u{1F600}'.repeat(499))],
    [call('c3', 'todowrite', { todos: [{ content: 'TODO-P3-RETRY', status: 'pending' }] }), tool('c3', 'x'.repeat(700))],
    [call('c4', 'grep', { pattern: 'a' }), tool('c4', 'match staging-3.override.yaml')],
    [call('c5', 'edit', { filePath: '/a' }), tool('c5', 'done')],
  ];
  const history: Msg[] = [sys, goal];
  const client: unknown[] = [];
  const mock: unknown[] = [];
  const ledger: unknown[] = [];
  let seq = 0;
  const facts = (msgs: Msg[]): Record<string, boolean> => {
    const blob = pyDumps(msgs, { ensureAscii: false });
    return Object.fromEntries(FACT_KEYS.map((f) => [f, blob.includes(f)]));
  };
  const req = (step: number, msgs: Msg[], status: number, prompt: number, extra: Record<string, unknown> = {}): void => {
    seq++;
    writeFileSync(join(dir, 'reqs', `${pad4(seq)}_step${step}.json`), pyDumps({ model: 'm', messages: msgs }, { ensureAscii: false }));
    mock.push({
      seq, step, ts: pyFloat(1790000000.5 + seq), prompt_tokens: prompt, max_tokens: 32000, n_messages: msgs.length,
      has_summary: msgs.some((m) => typeof m['content'] === 'string' && (m['content'] as string).startsWith(SUMMARY_HEADER)),
      facts: facts(msgs), body_chars: 1000 + seq, pairing_error: null, status, ...extra,
    });
  };
  for (let step = 0; step < 6; step++) {
    const orig = [...history];
    writeFileSync(join(dir, 'origs', `step${step}.json`), pyDumps({ model: 'm', messages: orig }, { ensureAscii: false }));
    const origTokens = 1000 * (step + 1) + 7 * step;
    let sent = orig;
    if (step === 3 || step === 4) {
      // summary keeps "result: ok" (only matches after Python strip) and the 499-emoji result once
      const summary = `${SUMMARY_HEADER}\n\nresult: ok\nresult: ${'\u{1F600}'.repeat(499)}\n` + (step === 4 ? 'result: ' + 'x'.repeat(700) : '');
      sent = [sys, goal, { role: 'user', content: summary }, ...orig.slice(-2)];
    }
    if (step === 4) req(step, orig, 400, origTokens, { rejected_for_length: true });
    if (step === 5) req(step, sent, 400, origTokens, { rejected_for_length: true });
    else req(step, sent, 200, step === 3 || step === 4 ? 600 + step : origTokens, { completion_tokens: 10 + step });
    ledger.push({
      ts: '2026-01-01T00:00:00.000Z', est_tokens_in: origTokens, est_tokens_out: step === 3 ? 555 : origTokens,
      est_summary_tokens: step === 3 ? 40 : 0, carry_chars: step >= 3 ? 12 : 0, threshold_tokens: 58000,
      ratio_permille: step < 2 ? 1000 : 1125, compacted: step === 3, reused_prefix: step === 4, over_budget: false, rung: step === 3 ? 1 : 0,
    });
    client.push({ step, orig_messages: orig.length, orig_est_tokens: origTokens - 3, orig_qwen_tokens: origTokens, status: step === 5 ? 400 : 200, secs: pyFloat(0.01) });
    if (step === 5) break;
    for (const m of steps[step]!) history.push(m);
    if (step === 1) history.push({ role: 'user', content: 'USER-RULE-Q7 applies.' });
    if (step === 2) history.push(tool('zz', 'orphan result with no call')); // "?" kind when not sent
  }
  const jl = (rows: unknown[]): string => rows.map((r) => pyDumps(r)).join('\n') + '\n';
  writeFileSync(join(dir, 'client.jsonl'), jl(client));
  writeFileSync(join(dir, 'mock.jsonl'), jl(mock));
  writeFileSync(join(dir, 'ledger.jsonl'), jl(ledger));
  writeFileSync(join(dir, 'proxy.args'), '--threshold 1 --keep-recent 2');
}
