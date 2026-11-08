import { buildEngine, createLogger } from '../../app.js';
import { counterFromConfig } from '../../tokenize/counter.js';
import { canonicalJSON } from '../../tokenize/canonical.js';
import type { EngineResult } from '../../types.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, MODEL_OPT, checkModelOverride, loadFromArgs, parseArgs, selectProfile } from '../args.js';
import type { Config } from '../../config/schema.js';
import { CHAT_BODY_HINT, collectRequests } from '../requests.js';
import { renderRetention } from '../explain.js';
import { validateConfig } from '../../config/validate.js';

export async function cmdReplay(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, ...MODEL_OPT, json: { type: 'boolean' }, explain: { type: 'boolean' }, 'explain-limit': { type: 'string' }, 'no-fresh': { type: 'boolean' } });
  const explainLimitArg = p.values['explain-limit'] as string | undefined;
  const explainLimit = explainLimitArg === undefined ? 20 : Number(explainLimitArg);
  if (!Number.isInteger(explainLimit) || explainLimit < 0 || (explainLimitArg !== undefined && explainLimitArg.trim() === '')) throw new UsageError('--explain-limit must be a non-negative integer');
  if (!p.positionals.length) throw new UsageError('replay needs a file or directory of captured request bodies');
  const l = loadFromArgs(p, io);
  const cfg = l.config;
  const log = createLogger(cfg.logLevel === 'debug' ? 'debug' : 'warn', io.stderr);
  const reqs = collectRequests(p.positionals, io.cwd);
  if (!reqs.length) throw new UsageError(`no request files found in ${p.positionals.join(' ')}; pass a captured Chat Completions body or a directory of .json/.jsonl captures`);
  // replay still runs, but say so when serve would refuse this config
  for (const e of validateConfig(cfg, { provenance: l.provenance, checkFiles: true }).errors) io.stderr(`kitzur: warn: config would be refused by serve: ${e}\n`);
  const modelArg = p.values['model'] as string | undefined;
  checkModelOverride(l, modelArg);
  const live = await buildEngine(cfg, { log, modules: io.modules, env: io.env });
  // one live engine per profile, built when a request first selects it
  const engines = new Map<string, Promise<typeof live>>([['root', Promise.resolve(live)]]);
  const engineFor = (profile: string, pcfg: Config): Promise<typeof live> => {
    let e = engines.get(profile);
    if (!e) engines.set(profile, (e = buildEngine(pcfg, { log, modules: live.modules, env: io.env })));
    return e;
  };
  const fresh = async (pcfg: Config, of: typeof live) =>
    (await buildEngine(pcfg, {
      modules: live.modules,
      env: io.env,
      counter: { counter: counterFromConfig(pcfg, { tokenizer: of.tokenizer }), tokenizer: of.tokenizer, estimateReason: of.estimateReason },
    })).engine;
  const rows: Array<Record<string, unknown>> = [];
  let mismatches = 0;
  let failures = 0;
  const fingerprint = (r: EngineResult): string => canonicalJSON({ request: r.request, maxTokens: r.maxTokens, error: r.error ?? null });
  for (const [i, { label, req }] of reqs.entries()) {
    if (!req) {
      rows.push({ i: i + 1, file: label, error: `not a chat request; ${CHAT_BODY_HINT}` });
      failures++;
      continue;
    }
    let row: Record<string, unknown>;
    const { profile, config: pcfg } = selectProfile(l, modelArg, req.model);
    try {
      const es = await engineFor(profile, pcfg);
      const r = es.engine.process(req, { attempt: 1 });
      row = {
        i: i + 1, file: label, profile, action: r.action, replan: r.replan ?? null, fit: r.plan?.fit ?? null, compactions: r.plan?.compactions ?? 0,
        ...(p.values['explain'] && r.plan?.retention ? { retention: r.plan.retention } : {}),
        ...(p.values['explain'] && !p.values['json'] && r.plan?.summaryAttribution ? { retentionExplanation: r.plan.summaryAttribution } : {}),
        ...(r.stats.retention ? { retentionCounts: r.stats.retention } : {}),
        messagesIn: r.stats.messagesIn, messagesOut: r.stats.messagesOut, tokensIn: r.stats.tokensIn, tokensOut: r.stats.tokensOut,
        budget: r.stats.budget.budget, trigger: r.stats.budget.trigger, maxTokens: r.maxTokens?.value ?? null, engineMs: Math.round(r.stats.engineMs * 10) / 10,
      };
      if (!p.values['no-fresh']) {
        const f = (await fresh(pcfg, es)).process(req, { attempt: 1 });
        row['deterministic'] = fingerprint(f) === fingerprint(r);
        if (!row['deterministic']) mismatches++;
      }
    } catch (e) {
      row = { i: i + 1, file: label, profile, error: `${(e as Error).name}: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}` };
      failures++;
    }
    rows.push(row);
  }
  if (p.values['json']) {
    io.stdout(JSON.stringify({ counter: live.counter.mode, requests: rows, mismatches, failures }, null, 1) + '\n');
  } else {
    io.stdout(`counter ${live.counter.mode}${live.estimateReason ? ` (${live.estimateReason})` : ''}; ${reqs.length} request(s)\n`);
    io.stdout(`${'#'.padStart(4)}  ${'file'.padEnd(24)} ${'action'.padEnd(14)} ${'msgs'.padStart(9)} ${'tokens in -> out'.padStart(19)} ${'budget'.padStart(7)} ${'trigger'.padStart(7)} ${'fit'.padEnd(11)} cmp ${'max_tok'.padStart(7)}  det  profile\n`);
    for (const r of rows) {
      if (r['error']) {
        io.stdout(`${String(r['i']).padStart(4)}  ${String(r['file']).padEnd(24)} ERROR ${r['error']}${r['profile'] ? `  profile ${r['profile']}` : ''}\n`);
        continue;
      }
      const det = r['deterministic'] === undefined ? '-' : r['deterministic'] ? 'ok' : 'DIFF';
      io.stdout(
        `${String(r['i']).padStart(4)}  ${String(r['file']).slice(0, 24).padEnd(24)} ${String(r['action']).padEnd(14)} ` +
          `${`${r['messagesIn']}->${r['messagesOut']}`.padStart(9)} ${`${r['tokensIn']} -> ${r['tokensOut']}`.padStart(19)} ` +
          `${String(r['budget']).padStart(7)} ${String(r['trigger']).padStart(7)} ${String(r['fit'] ?? '-').padEnd(11)} ${String(r['compactions']).padStart(3)} ` +
          `${String(r['maxTokens'] ?? '-').padStart(7)}  ${det.padEnd(4)}  ${r['profile']}\n`,
      );
      if (p.values['explain'] && Array.isArray(r['retentionExplanation'])) {
        io.stdout(`${renderRetention(r['retentionExplanation'] as import('../../engine/contracts.js').RetentionAttribution[], { limit: explainLimit }).split('\n').map((line) => `      ${line}`).join('\n')}\n`);
      }
    }
    const actions: Record<string, number> = {};
    for (const r of rows) if (r['action']) actions[String(r['action'])] = (actions[String(r['action'])] ?? 0) + 1;
    io.stdout(`actions: ${Object.entries(actions).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}\n`);
    if (!p.values['no-fresh']) io.stdout(`determinism (live == fresh): ${rows.length - failures - mismatches}/${rows.length - failures} ok\n`);
    if (failures) io.stdout(`failures: ${failures}\n`);
  }
  return mismatches || failures ? 1 : 0;
}
