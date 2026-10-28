import { buildEngine, createLogger } from '../../app.js';
import { counterFromConfig } from '../../tokenize/counter.js';
import { canonicalJSON } from '../../tokenize/canonical.js';
import type { EngineResult } from '../../types.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { collectRequests } from '../requests.js';

export async function cmdReplay(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, json: { type: 'boolean' }, 'no-fresh': { type: 'boolean' } });
  if (!p.positionals.length) throw new UsageError('replay needs a file or directory of captured request bodies');
  const l = loadFromArgs(p, io);
  const cfg = l.config;
  const log = createLogger(cfg.logLevel === 'debug' ? 'debug' : 'warn', io.stderr);
  const reqs = collectRequests(p.positionals, io.cwd);
  const live = await buildEngine(cfg, { log, modules: io.modules, env: io.env });
  const fresh = async () =>
    (await buildEngine(cfg, {
      modules: live.modules,
      env: io.env,
      counter: { counter: counterFromConfig(cfg, { tokenizer: live.tokenizer }), tokenizer: live.tokenizer, estimateReason: live.estimateReason },
    })).engine;
  const rows: Array<Record<string, unknown>> = [];
  let mismatches = 0;
  let failures = 0;
  const fingerprint = (r: EngineResult): string => canonicalJSON({ request: r.request, maxTokens: r.maxTokens, error: r.error ?? null });
  for (const [i, { label, req }] of reqs.entries()) {
    if (!req) {
      rows.push({ i: i + 1, file: label, error: 'not a chat request' });
      failures++;
      continue;
    }
    let row: Record<string, unknown>;
    try {
      const r = live.engine.process(req, { attempt: 1 });
      row = {
        i: i + 1, file: label, action: r.action, replan: r.replan ?? null, fit: r.plan?.fit ?? null, compactions: r.plan?.compactions ?? 0,
        ...(r.plan?.retention ? { retention: r.plan.retention } : {}),
        ...(r.stats.retention ? { retentionCounts: r.stats.retention } : {}),
        messagesIn: r.stats.messagesIn, messagesOut: r.stats.messagesOut, tokensIn: r.stats.tokensIn, tokensOut: r.stats.tokensOut,
        budget: r.stats.budget.budget, trigger: r.stats.budget.trigger, maxTokens: r.maxTokens?.value ?? null, engineMs: Math.round(r.stats.engineMs * 10) / 10,
      };
      if (!p.values['no-fresh']) {
        const f = (await fresh()).process(req, { attempt: 1 });
        row['deterministic'] = fingerprint(f) === fingerprint(r);
        if (!row['deterministic']) mismatches++;
      }
    } catch (e) {
      row = { i: i + 1, file: label, error: `${(e as Error).name}: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}` };
      failures++;
    }
    rows.push(row);
  }
  if (p.values['json']) {
    io.stdout(JSON.stringify({ counter: live.counter.mode, requests: rows, mismatches, failures }, null, 1) + '\n');
  } else {
    io.stdout(`counter ${live.counter.mode}${live.estimateReason ? ` (${live.estimateReason})` : ''}; ${reqs.length} request(s)\n`);
    io.stdout(`${'#'.padStart(4)}  ${'file'.padEnd(24)} ${'action'.padEnd(14)} ${'msgs'.padStart(9)} ${'tokens in -> out'.padStart(19)} ${'budget'.padStart(7)} ${'trigger'.padStart(7)} ${'fit'.padEnd(11)} cmp ${'max_tok'.padStart(7)}  det\n`);
    for (const r of rows) {
      if (r['error']) {
        io.stdout(`${String(r['i']).padStart(4)}  ${String(r['file']).padEnd(24)} ERROR ${r['error']}\n`);
        continue;
      }
      const det = r['deterministic'] === undefined ? '-' : r['deterministic'] ? 'ok' : 'DIFF';
      io.stdout(
        `${String(r['i']).padStart(4)}  ${String(r['file']).slice(0, 24).padEnd(24)} ${String(r['action']).padEnd(14)} ` +
          `${`${r['messagesIn']}->${r['messagesOut']}`.padStart(9)} ${`${r['tokensIn']} -> ${r['tokensOut']}`.padStart(19)} ` +
          `${String(r['budget']).padStart(7)} ${String(r['trigger']).padStart(7)} ${String(r['fit'] ?? '-').padEnd(11)} ${String(r['compactions']).padStart(3)} ` +
          `${String(r['maxTokens'] ?? '-').padStart(7)}  ${det}\n`,
      );
    }
    const actions: Record<string, number> = {};
    for (const r of rows) if (r['action']) actions[String(r['action'])] = (actions[String(r['action'])] ?? 0) + 1;
    io.stdout(`actions: ${Object.entries(actions).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}\n`);
    if (!p.values['no-fresh']) io.stdout(`determinism (live == fresh): ${rows.length - failures - mismatches}/${rows.length - failures} ok\n`);
    if (failures) io.stdout(`failures: ${failures}\n`);
  }
  return mismatches || failures ? 1 : 0;
}
