import { setupCounter } from '../../app.js';
import { computeBudget, requestMaxTokens, serverFits } from '../../config/derived.js';
import { stateDirOf } from '../../config/paths.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { collectRequests } from '../requests.js';

export async function cmdCount(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, estimate: { type: 'boolean' }, json: { type: 'boolean' } });
  if (p.positionals.length !== 1) throw new UsageError('count needs one request file (a Chat Completions body)');
  const l = loadFromArgs(p, io);
  const cfg = l.config;
  const reqs = collectRequests(p.positionals, io.cwd);
  const req = reqs[0]?.req;
  if (!req) throw new UsageError(`${p.positionals[0]}: not a chat request (no messages array)`);
  const cs = setupCounter(cfg, { stateDir: stateDirOf(cfg, io.env) });
  if (cs.estimateReason && !p.values['estimate']) {
    io.stderr(`kitzur: no exact count: ${cs.estimateReason}. Pass --tokenizer FILE, or --estimate for the per-class estimate.\n`);
    return 2;
  }
  const m = cs.counter.measure(req);
  const tReq = requestMaxTokens(req, cfg);
  const b = computeBudget(cfg, { tReq });
  const out = {
    file: reqs[0]!.label,
    counter: cs.counter.mode,
    template: cfg.tokenizer.template.name,
    tokenizerSha256: cs.tokenizer?.sha256 ?? null,
    messages: req.messages.length,
    tools: Array.isArray(req.tools) ? req.tools.length : 0,
    total: m.total,
    overhead: m.overhead,
    perMessage: m.perMessage.map((n, i) => ({ i, role: String(req.messages[i]?.role ?? '?'), tokens: n })),
    tReq,
    mode: b.mode,
    budget: b.budget,
    withinBudget: m.total <= b.budget,
    serverFits: serverFits(b, m.total, tReq),
  };
  if (p.values['json']) {
    io.stdout(JSON.stringify(out, null, 1) + '\n');
    return 0;
  }
  io.stdout(`${out.file}: ${out.total} tokens (${out.counter}, template ${out.template}${out.tokenizerSha256 ? `, tokenizer ${out.tokenizerSha256.slice(0, 12)}` : ''})\n`);
  io.stdout(`  ${out.messages} messages, ${out.tools} tools; overhead ${out.overhead} (tools block / generation prompt not attributed to a message)\n`);
  io.stdout(`  T_req ${tReq}; ${b.mode}: budget ${b.budget} ${out.withinBudget ? 'ok' : `exceeded by ${out.total - b.budget}`}; serverFits ${out.serverFits ? 'yes' : 'no'}\n`);
  for (const r of out.perMessage) io.stdout(`  #${String(r.i).padEnd(4)} ${r.role.padEnd(10)} ${String(r.tokens).padStart(8)}\n`);
  return 0;
}
