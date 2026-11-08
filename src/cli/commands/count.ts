import { setupCounter } from '../../app.js';
import { validateConfig } from '../../config/validate.js';
import { computeBudget, requestMaxTokens, serverFits } from '../../config/derived.js';
import { stateDirOf } from '../../config/paths.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, MODEL_OPT, checkModelOverride, loadFromArgs, parseArgs, selectProfile } from '../args.js';
import { CHAT_BODY_HINT, collectRequests } from '../requests.js';
import { TemplateError } from '../../tokenize/template.js';

export async function cmdCount(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, ...MODEL_OPT, estimate: { type: 'boolean' }, json: { type: 'boolean' } });
  if (p.positionals.length !== 1) throw new UsageError('count needs one request file (a Chat Completions body)');
  const l = loadFromArgs(p, io);
  const modelArg = p.values['model'] as string | undefined;
  checkModelOverride(l, modelArg);
  const reqs = collectRequests(p.positionals, io.cwd);
  const req = reqs[0]?.req;
  if (!req) throw new UsageError(`${p.positionals[0]}: not a chat request (no messages array); ${CHAT_BODY_HINT}`);
  if (!req.messages.length) throw new UsageError(`${p.positionals[0]}: the request has no messages; pass a captured Chat Completions body with at least one message`);
  const bad = req.messages.findIndex((x: unknown) => typeof x !== 'object' || x === null || typeof (x as { role?: unknown }).role !== 'string');
  if (bad >= 0) throw new UsageError(`${p.positionals[0]}: messages[${bad}] is not a message object (expected {role, content}); fix or remove it`);
  const { profile, config: cfg } = selectProfile(l, modelArg, req.model);
  // a warning only: what-if windows still get their numbers
  for (const e of validateConfig(cfg, { provenance: l.provenance, checkFiles: true }).errors) io.stderr(`kitzur: warn: config would be refused by serve: ${e}\n`);
  const cs = setupCounter(cfg, { stateDir: stateDirOf(cfg, io.env) });
  if (cs.estimateReason && !p.values['estimate']) {
    io.stderr(`kitzur: no exact count: ${cs.estimateReason}. Pass --tokenizer FILE, or --estimate for the per-class estimate.\n`);
    return 2;
  }
  let m: ReturnType<typeof cs.counter.measure>;
  try {
    m = cs.counter.measure(req);
  } catch (e) {
    if (!(e instanceof TemplateError)) throw e;
    const at = e.index === null ? '' : `messages[${e.index}]: `;
    throw new UsageError(`${p.positionals[0]}: ${at}${e.message} The model's chat template rejects this request, so a server running it would answer 400 and Kitzur would forward the original unchanged; fix that message's role or content.`);
  }
  const tReq = requestMaxTokens(req, cfg);
  const b = computeBudget(cfg, { tReq });
  const out = {
    file: reqs[0]!.label,
    profile,
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
  io.stdout(`${out.file}: ${out.total} tokens (${out.counter}, template ${out.template}, profile ${profile}${out.tokenizerSha256 ? `, tokenizer ${out.tokenizerSha256.slice(0, 12)}` : ''})\n`);
  io.stdout(`  ${out.messages} messages, ${out.tools} tools; overhead ${out.overhead} (tools block / generation prompt not attributed to a message)\n`);
  io.stdout(`  T_req ${tReq}; ${b.mode}: budget ${b.budget} ${out.withinBudget ? 'ok' : `exceeded by ${out.total - b.budget}`}; serverFits ${out.serverFits ? 'yes' : 'no'}\n`);
  for (const r of out.perMessage) io.stdout(`  #${String(r.i).padEnd(4)} ${r.role.padEnd(10)} ${String(r.tokens).padStart(8)}\n`);
  return 0;
}
