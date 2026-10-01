#!/usr/bin/env node
// The kitzur command line (DESIGN.md, §10):
//   kitzur serve | replay | status | count | config {init,show,validate,import-eval} | state {show,reset} | bench | version
// Arguments are parsed here without dependencies. Exit codes: 0 ok, 1 runtime failure, 2 usage or config
// error; `config import-eval` also returns 10 (a safety-critical knob fell back to a default) and 11
// (conflicting measurements). Nothing here prints message content: replay and count print sizes only.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, buildEngine, createLogger, setupCounter, AppModuleError, type AppModules, type Logger } from './app.js';
import { ConfigError, loadConfig, parseSetArg, type LoadedConfig, type SetOp } from './config/load.js';
import { validateConfig } from './config/validate.js';
import { computeBudget, planMaxTokens, requestMaxTokens, serverFits } from './config/derived.js';
import { DEFAULT_LEAVES, getPath, isPlainObject } from './config/spec.js';
import { renderInitConfig } from './config/init.js';
import { packageInfo, stateDirOf } from './config/paths.js';
import { jsonErrorInfo, lineCol, parseJsonc } from './config/jsonc.js';
import {
  mapEvalResults, mergeImport, readEvalInputs, renderImportReport, sidecarPath, type ImportSidecar, type KnobRecord, type MergeResult,
} from './config/import-eval.js';
import { counterFromConfig } from './tokenize/counter.js';
import { canonicalJSON } from './tokenize/canonical.js';
import type { Config } from './config/schema.js';
import type { ChatRequest, EngineResult, LearnedState } from './types.js';

// ---------------------------------------------------------------- IO and errors

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** registers the graceful-stop handler for SIGTERM/SIGINT (tests inject their own) */
  onSignal(handler: (signal: string) => void): void;
  /** engine/proxy factories instead of the dynamically loaded modules (tests, embedders) */
  modules?: AppModules;
}

export function defaultIO(): CliIO {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    onSignal: (h) => {
      process.on('SIGTERM', () => h('SIGTERM'));
      process.on('SIGINT', () => h('SIGINT'));
    },
  };
}

/** Bad command line (exit 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// ---------------------------------------------------------------- argument parsing

export interface OptDef {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
  /** shortcut for a config leaf: the value becomes a --set of this path */
  set?: string;
}
export type OptSpec = Record<string, OptDef>;

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** options in argv order (config assignments are applied in this order) */
  ordered: Array<{ name: string; value: string | boolean }>;
}

/** Parses `--name value`, `--name=value`, `-s value`, boolean `--flag`, and `--` (end of options). */
export function parseArgs(argv: readonly string[], spec: OptSpec): ParsedArgs {
  const values: ParsedArgs['values'] = {};
  const positionals: string[] = [];
  const ordered: ParsedArgs['ordered'] = [];
  const byShort = new Map(Object.entries(spec).filter(([, d]) => d.short).map(([n, d]) => [d.short!, n]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : undefined;
    } else if (a.length === 2 && a[0] === '-' && a[1] !== '-') {
      name = byShort.get(a[1]!);
      if (!name) throw new UsageError(`unknown option ${a}`);
    } else {
      positionals.push(a);
      continue;
    }
    const def = spec[name];
    if (!def) throw new UsageError(`unknown option --${name}`);
    let value: string | boolean;
    if (def.type === 'boolean') {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      value = true;
    } else {
      if (inline !== undefined) value = inline;
      else if (i + 1 < argv.length) value = argv[++i]!;
      else throw new UsageError(`--${name} needs a value`);
    }
    ordered.push({ name, value });
    if (def.multiple) values[name] = [...((values[name] as string[] | undefined) ?? []), String(value)];
    else values[name] = value;
  }
  return { values, positionals, ordered };
}

/** Options every config-reading command accepts. */
export const CONFIG_OPTS: OptSpec = {
  config: { type: 'string', short: 'c' },
  preset: { type: 'string', short: 'p' },
  set: { type: 'string', multiple: true, short: 's' },
  upstream: { type: 'string', set: 'upstream.origin' },
  host: { type: 'string', set: 'listen.host' },
  port: { type: 'string', set: 'listen.port' },
  tokenizer: { type: 'string', set: 'tokenizer.path' },
  template: { type: 'string', set: 'tokenizer.template.name' },
  'state-dir': { type: 'string', set: 'stateDir' },
  stats: { type: 'string', set: 'stats.path' },
  'log-level': { type: 'string', set: 'logLevel' },
  shadow: { type: 'boolean', set: 'shadow' },
};

/** The config assignments of a parsed command line, in argv order. */
export function setOpsOf(p: ParsedArgs, spec: OptSpec = CONFIG_OPTS): SetOp[] {
  const ops: SetOp[] = [];
  for (const { name, value } of p.ordered) {
    if (name === 'set') ops.push(parseSetArg(String(value)));
    else if (spec[name]?.set) ops.push({ path: spec[name]!.set!, raw: String(value), source: `cli:--${name}` });
  }
  return ops;
}

function loadFromArgs(p: ParsedArgs, io: CliIO): LoadedConfig {
  return loadConfig({
    preset: (p.values['preset'] as string | undefined) ?? null,
    configPath: (p.values['config'] as string | undefined) ?? null,
    env: io.env,
    cwd: io.cwd,
    sets: setOpsOf(p),
  });
}

// ---------------------------------------------------------------- usage

const USAGE = `usage: kitzur <command> [options]

  serve                         run the proxy (prints "listening on http://127.0.0.1:<port>")
  replay <file|dir>...          run captured request bodies through the engine offline; sizes only,
                                plus a live-vs-fresh determinism check
  count <request.json>          exact token count of a request (per message, no content)
  status [--url URL]            GET /status of a running instance
  config init [--preset 100k] [--out FILE|-] [--force]
  config show [--changed] [--json]      effective config with the source of every value
  config validate [--json]              errors and startup warnings
  config import-eval <dir|file>... [--out FILE] [--merge FILE] [--provenance FILE] [--dry-run]
                     [--force-keys a.b,c] [--allow-pack-version N] [--json-report] [--port N] [--force]
  state show [--key K] [--json]         learned entries in the state dir
  state reset [--key K] [--plans]       remove learned entries (and the plan store)
  bench [args...]                       run the benchmark suite (dist/bench/run-all.js)
  version

config options (serve, replay, count, status, config show|validate, state):
  -c, --config FILE      JSON config file (comments allowed)       also KITZUR_CONFIG
  -p, --preset NAME      32k | 64k | 100k | 128k, or a preset file   also KITZUR_PRESET
  -s, --set a.b=v        set any key (repeatable)                    also KITZUR_SET="a.b=v;c.d=w"
  --upstream URL  --host H  --port N  --tokenizer FILE  --template NAME
  --state-dir DIR  --stats FILE  --log-level L  --shadow
Precedence: defaults < preset < config file < KITZUR_* env < command line. Every key: CONFIG.md.
`;

// ---------------------------------------------------------------- helpers

const fmtHost = (h: string): string => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** `https://user:secret@gw` -> `https://<credentials>@gw` (an origin with credentials fails validation, but show prints it). */
function maskUserinfo(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1<credentials>@') : v;
}

/** A config value for display: header values and URL credentials masked, long strings shortened. */
function display(path: string, v: unknown, full = false): string {
  if (path === 'upstream.headers' && isPlainObject(v)) v = Object.fromEntries(Object.keys(v).map((k) => [k, '<set>']));
  if (path === 'upstream.origin') v = maskUserinfo(v);
  const s = JSON.stringify(v) ?? 'undefined';
  return !full && s.length > 100 ? `${s.slice(0, 90)}… (${s.length} chars)` : s;
}

function maskedConfig(c: Config): Config {
  const m = structuredClone(c);
  m.upstream.headers = Object.fromEntries(Object.keys(m.upstream.headers).map((k) => [k, '<set>']));
  m.upstream.origin = maskUserinfo(m.upstream.origin) as string | null;
  return m;
}

function derivedLines(cfg: Config): string[] {
  const head = cfg.budget.observedFixedPromptTokens;
  const b = computeBudget(cfg, { counterFixedTokens: head });
  const why = cfg.server.budgetMode ? 'server.budgetMode' : cfg.budget.limitCountsMaxTokens !== null ? 'budget.limitCountsMaxTokens' : `server.type ${cfg.server.type}`;
  return [
    `# derived (DESIGN §3; T_req = budget.defaultMaxTokens, no learned entry)`,
    `mode          ${b.mode}   (from ${why})`,
    `W             ${b.window}`,
    `T_plan        ${planMaxTokens(cfg)}`,
    `margin        ${b.margin}`,
    `budget        ${b.budget}`,
    `clientPoint   ${b.clientPoint}`,
    `allowance     ${b.allowance}`,
    `hard          ${b.hard}`,
    `trigger       ${b.trigger}`,
    `target        ${b.target}`,
    `summaryBudget ${b.summaryBudget}   (without the ledger floor)`,
    `headRoom      ${b.headRoom}`,
    `admitTokens   ${b.admitTokens ?? (cfg.oversize.enabled && cfg.oversize.admission ? 'depends on the head (set budget.observedFixedPromptTokens to see it)' : 'off')}`,
    `byteLimit     ${b.byteLimit ?? 'none'}`,
  ];
}

/** JSON.parse whose error names the line and column but never quotes the text (captured prompts). */
function parseNoEcho(text: string, lineNo?: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const { reason, pos } = jsonErrorInfo((e as Error).message, text);
    const lc = pos === null ? null : lineCol(text, pos);
    const where = lineNo !== undefined ? ` at line ${lineNo}${lc ? ` column ${lc.col}` : ''}` : lc ? ` at line ${lc.line} column ${lc.col}` : '';
    throw new Error(`${reason}${where}`);
  }
}

function readRequestFile(path: string): unknown[] {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return text.split('\n').flatMap((l, i) => (l.trim() ? [parseNoEcho(l, i + 1)] : []));
  }
  const j = parseNoEcho(text);
  return Array.isArray(j) ? j : [j];
}

/** A chat request from a captured record: the body itself, or {body}/{request} holding it (object or JSON text). */
export function asRequest(x: unknown): ChatRequest | null {
  if (isPlainObject(x) && Array.isArray(x['messages'])) return x as unknown as ChatRequest;
  if (isPlainObject(x)) {
    for (const k of ['body', 'request']) {
      const v = x[k];
      const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
      if (isPlainObject(o) && Array.isArray(o['messages'])) return o as unknown as ChatRequest;
    }
  }
  return null;
}

/** Captured request files in replay order: directories sorted by name (numeric-aware), then files as given. */
export function collectRequests(paths: string[], cwd: string): Array<{ label: string; req: ChatRequest | null }> {
  const out: Array<{ label: string; req: ChatRequest | null }> = [];
  const collator = new Intl.Collator('en', { numeric: true });
  for (const p0 of paths) {
    const p = resolve(cwd, p0);
    if (!existsSync(p)) throw new UsageError(`not found: ${p0}`);
    const files = statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).sort(collator.compare).map((f) => join(p, f))
      : [p];
    for (const f of files) {
      let items: unknown[];
      try {
        items = readRequestFile(f);
      } catch (e) {
        throw new UsageError(`${f}: not JSON (${(e as Error).message.split('\n')[0]})`);
      }
      items.forEach((it, i) => out.push({ label: items.length > 1 ? `${basename(f)}:${i + 1}` : basename(f), req: asRequest(it) }));
    }
  }
  return out;
}

function httpGet(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { agent: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

async function importState(): Promise<{
  showState(dir: string, filter?: string): { path: string; state: LearnedState; error: string | null };
  resetState(dir: string, filter?: string): string[];
}> {
  const spec = './proxy/state.js';
  try {
    return (await import(new URL(spec, import.meta.url).href)) as Awaited<ReturnType<typeof importState>>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') throw new AppModuleError('this build has no src/proxy/state.ts');
    throw e;
  }
}

// ---------------------------------------------------------------- commands

async function cmdServe(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, 'drain-ms': { type: 'string' } });
  if (p.positionals.length) throw new UsageError(`serve takes no arguments (got ${p.positionals.join(' ')})`);
  const l = loadFromArgs(p, io);
  const cfg = l.config;
  const log = createLogger(cfg.logLevel, io.stderr);
  const v = validateConfig(cfg, { provenance: l.provenance, checkFiles: true });
  for (const w of [...l.warnings, ...v.warnings.filter((x) => !/^upstream\.origin is not set/.test(x))]) log.warn(w);
  if (v.errors.length || !cfg.upstream.origin) {
    for (const e of v.errors) io.stderr(`kitzur: config error: ${e}\n`);
    if (!cfg.upstream.origin) io.stderr('kitzur: config error: upstream.origin is required (--upstream http://gateway:8000, KITZUR_UPSTREAM_ORIGIN or the config file)\n');
    return 2;
  }
  const drainMs = p.values['drain-ms'] !== undefined ? Number(p.values['drain-ms']) : 30_000;
  if (!Number.isFinite(drainMs) || drainMs < 0) throw new UsageError('--drain-ms must be a number of milliseconds');
  const app = await buildApp(cfg, { log, modules: io.modules, env: io.env });
  const addr = await app.listen();
  // startup probe (§9 TLS): a certificate failure exits non-zero; an unreachable upstream only logs
  const probe = await app.probe(Math.min(10_000, cfg.upstream.timeoutMs));
  if (probe.tlsError) {
    log.error(`TLS verification of ${cfg.upstream.origin} failed: ${probe.tlsError} (set upstream.caFile or NODE_EXTRA_CA_CERTS; see deploy/README.md)`);
    await app.close(0);
    return 1;
  }
  const b = computeBudget(cfg);
  log.info(`upstream ${cfg.upstream.origin}; counter ${app.counter.mode}; mode ${b.mode}; budget ${b.budget}, trigger ${b.trigger}, target ${b.target}`);
  io.stdout(`listening on http://${fmtHost(addr.host)}:${addr.port}\n`);
  return await new Promise<number>((done) => {
    let stopping = false;
    io.onSignal((sig) => {
      if (stopping) {
        log.warn(`${sig} again: exiting without waiting for the drain`);
        done(130);
        return;
      }
      stopping = true;
      log.info(`${sig}: stopping; draining in-flight requests (up to ${drainMs} ms)`);
      app.close(drainMs).then(
        () => {
          log.info('stopped');
          done(0);
        },
        (e: unknown) => {
          log.error(`shutdown: ${(e as Error).message}`);
          done(1);
        },
      );
    });
  });
}

async function cmdReplay(argv: string[], io: CliIO): Promise<number> {
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

async function cmdCount(argv: string[], io: CliIO): Promise<number> {
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

async function cmdStatus(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, url: { type: 'string' }, 'timeout-ms': { type: 'string' } });
  let url = p.values['url'] as string | undefined;
  if (!url) {
    const cfg = loadFromArgs(p, io).config;
    const host = cfg.listen.host === '0.0.0.0' || cfg.listen.host === '::' ? '127.0.0.1' : cfg.listen.host;
    url = `http://${fmtHost(host)}:${cfg.listen.port}/status`;
  }
  try {
    const r = await httpGet(url, Number(p.values['timeout-ms'] ?? 5000));
    let body = r.body;
    try {
      body = JSON.stringify(JSON.parse(r.body), null, 1);
    } catch {
      /* not JSON: print as is */
    }
    io.stdout(body.endsWith('\n') ? body : body + '\n');
    if (r.status !== 200) io.stderr(`kitzur: ${url} returned HTTP ${r.status}\n`);
    return r.status === 200 ? 0 : 1;
  } catch (e) {
    io.stderr(`kitzur: cannot reach ${url}: ${(e as Error).message}\n`);
    return 1;
  }
}

async function cmdConfig(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'init': {
      const p = parseArgs(rest, { preset: { type: 'string', short: 'p' }, out: { type: 'string', short: 'o' }, force: { type: 'boolean' } });
      const text = renderInitConfig((p.values['preset'] as string | undefined) ?? '100k');
      const out = (p.values['out'] as string | undefined) ?? 'kitzur.config.jsonc';
      if (out === '-') {
        io.stdout(text);
        return 0;
      }
      const path = resolve(io.cwd, out);
      if (existsSync(path) && !p.values['force']) {
        io.stderr(`kitzur: ${path} exists (use --force to overwrite)\n`);
        return 1;
      }
      // the README's `--out ~/.config/kitzur/kitzur.jsonc` on a fresh host: the directory does not exist yet
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      io.stdout(`wrote ${path}\nnext: set upstream.origin (and tokenizer.path), then: kitzur config validate --config ${out}\n`);
      return 0;
    }
    case 'show': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, json: { type: 'boolean' }, changed: { type: 'boolean' }, full: { type: 'boolean' } });
      const l = loadFromArgs(p, io);
      const v = validateConfig(l.config, { provenance: l.provenance });
      if (p.values['json']) {
        io.stdout(JSON.stringify({
          preset: l.preset, configPath: l.configPath, layers: l.layers, config: maskedConfig(l.config), provenance: l.provenance,
          derived: computeBudget(l.config, { counterFixedTokens: l.config.budget.observedFixedPromptTokens }),
          errors: v.errors, warnings: [...l.warnings, ...v.warnings],
        }, null, 1) + '\n');
        return v.errors.length ? 2 : 0;
      }
      io.stdout(`# kitzur ${packageInfo().version} effective config: ${l.layers.join(' < ')}\n`);
      const leaves = DEFAULT_LEAVES.filter((k) => !p.values['changed'] || l.provenance[k] !== 'default');
      const w = Math.max(...leaves.map((k) => k.length), 10);
      for (const k of leaves) {
        io.stdout(`${k.padEnd(w)} = ${display(k, getPath(l.config, k), p.values['full'] === true)}   (${l.provenance[k]})\n`);
      }
      io.stdout('\n' + derivedLines(l.config).join('\n') + '\n');
      for (const x of [...l.warnings, ...v.warnings]) io.stdout(`# warning: ${x}\n`);
      for (const x of v.errors) io.stdout(`# ERROR: ${x}\n`);
      return v.errors.length ? 2 : 0;
    }
    case 'validate': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, json: { type: 'boolean' } });
      const l = loadFromArgs(p, io);
      const v = validateConfig(l.config, { provenance: l.provenance, checkFiles: true });
      const warnings = [...l.warnings, ...v.warnings];
      if (p.values['json']) io.stdout(JSON.stringify({ ok: v.errors.length === 0, errors: v.errors, warnings }, null, 1) + '\n');
      else {
        for (const e of v.errors) io.stdout(`error: ${e}\n`);
        for (const x of warnings) io.stdout(`warning: ${x}\n`);
        io.stdout(v.errors.length ? `${v.errors.length} error(s)\n` : `ok (${warnings.length} warning(s))\n`);
      }
      return v.errors.length ? 2 : 0;
    }
    case 'import-eval':
      return cmdImportEval(rest, io);
    default:
      throw new UsageError(sub ? `unknown config command '${sub}' (init, show, validate, import-eval)` : 'config needs a subcommand: init, show, validate, import-eval');
  }
}

async function cmdImportEval(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, {
    out: { type: 'string', short: 'o' }, merge: { type: 'string' }, provenance: { type: 'string' }, 'dry-run': { type: 'boolean' },
    'force-keys': { type: 'string', multiple: true }, 'allow-pack-version': { type: 'string', multiple: true }, 'json-report': { type: 'boolean' },
    port: { type: 'string' }, tokenizer: { type: 'string' }, template: { type: 'string' }, force: { type: 'boolean' },
  });
  if (!p.positionals.length) throw new UsageError('import-eval needs gateway-probes result directories or files');
  const inputs = readEvalInputs(p.positionals.map((x) => resolve(io.cwd, x)), { allowPackVersions: (p.values['allow-pack-version'] as string[] | undefined) ?? [] });
  for (const x of inputs.invalid) io.stderr(`kitzur: invalid input: ${x}\n`);
  if (inputs.invalid.length) return 1;
  if (inputs.candidates > 0 && Object.keys(inputs.results).length === 0) {
    io.stderr('kitzur: no usable gateway-probes result in the inputs (see the warnings)\n');
    for (const w of inputs.warnings) io.stderr(`  - ${w}\n`);
    return 1;
  }
  const port = p.values['port'] !== undefined ? Number(p.values['port']) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new UsageError('--port must be a port number');
  // optional template check: our exact count of the probe's tiny request
  let tinyCount: number | null = null;
  if (p.values['tokenizer']) {
    const l = loadConfig({ env: {}, sets: [
      { path: 'tokenizer.path', raw: String(p.values['tokenizer']), source: 'cli:--tokenizer' },
      ...(p.values['template'] ? [{ path: 'tokenizer.template.name', raw: String(p.values['template']), source: 'cli:--template' }] : []),
    ], cwd: io.cwd });
    const cs = setupCounter(l.config, {});
    if (cs.estimateReason) {
      io.stderr(`kitzur: --tokenizer: ${cs.estimateReason}\n`);
      return 1;
    }
    tinyCount = cs.counter.countRequest({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
  }
  const res = mapEvalResults(inputs.results, { port, capture: inputs.capture, tinyCount });
  const mergePath = p.values['merge'] ? resolve(io.cwd, String(p.values['merge'])) : null;
  const out = resolve(io.cwd, (p.values['out'] as string | undefined) ?? mergePath ?? 'kitzur.config.json');
  const provPath = p.values['provenance'] ? resolve(io.cwd, String(p.values['provenance'])) : sidecarPath(out);
  const forceKeys = ((p.values['force-keys'] as string[] | undefined) ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  let config: Record<string, unknown>;
  let knobs: Record<string, KnobRecord>;
  let merge: MergeResult | null = null;
  const notes: string[] = [];
  if (mergePath) {
    if (!existsSync(mergePath)) {
      io.stderr(`kitzur: --merge ${mergePath}: not found\n`);
      return 1;
    }
    const text = readFileSync(mergePath, 'utf8');
    let existing: unknown;
    try {
      existing = parseJsonc(text, mergePath);
    } catch (e) {
      io.stderr(`kitzur: ${(e as Error).message}\n`);
      return 1;
    }
    if (!isPlainObject(existing)) {
      io.stderr(`kitzur: ${mergePath}: not a JSON object\n`);
      return 1;
    }
    let prev: Record<string, KnobRecord> | null = null;
    const prevPath = sidecarPath(mergePath);
    if (existsSync(prevPath)) {
      try {
        const s = JSON.parse(readFileSync(prevPath, 'utf8')) as Partial<ImportSidecar>;
        prev = isPlainObject(s.knobs) ? (s.knobs as Record<string, KnobRecord>) : null;
      } catch {
        notes.push(`${prevPath}: unreadable; every existing value is treated as hand-set`);
      }
    }
    merge = mergeImport(existing, prev, res, forceKeys);
    config = merge.config;
    knobs = merge.sidecarKnobs;
    if (/\/\/|\/\*/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) notes.push(`comments in ${mergePath} are not preserved (a copy is kept as ${out}.bak)`);
  } else {
    if (existsSync(out) && !p.values['force'] && !p.values['dry-run']) {
      io.stderr(`kitzur: ${out} exists: use --merge ${out} to update it (hand-set values survive) or --force to replace it\n`);
      return 1;
    }
    config = { $comment: 'written by kitzur config import-eval; provenance of every value in the .provenance.json next to this file', ...res.config };
    knobs = Object.fromEntries(Object.entries(res.provenance).filter(([k]) => getPath(res.config, k) !== undefined));
  }
  // the result must load and validate like any config (with --merge: the merged file, its preset included)
  let unusable = false;
  try {
    const check = validateConfig(loadConfig({ env: {}, cwd: dirname(out), object: config }).config, {});
    for (const e of check.errors) notes.push(`the written config does not validate: ${e}`);
    unusable = check.errors.length > 0;
  } catch (e) {
    notes.push(`the written config does not load: ${(e as Error).message}`);
    unusable = true;
  }
  // a config serve would refuse is never "exit 0": report it like conflicting measurements
  const exitCode: 0 | 10 | 11 = unusable ? 11 : res.exitCode;
  const sidecar: ImportSidecar = {
    $comment: 'kitzur config import-eval provenance: the knobs listed under "knobs" were written by the importer and may be updated by a later import; values edited by hand are kept',
    generatedBy: 'kitzur config import-eval',
    inputs: inputs.sources,
    knobs,
    info: res.info,
    warnings: [...inputs.warnings, ...res.warnings, ...(merge?.warnings ?? []), ...notes],
    todos: res.todos,
  };
  if (p.values['json-report']) {
    io.stdout(JSON.stringify({
      inputs: inputs.sources, ignored: inputs.ignored, config, provenance: res.provenance, info: res.info,
      warnings: sidecar.warnings, conflicts: res.conflicts, unsafe: res.unsafe, todos: res.todos, questions: res.questions,
      clientBaseUrl: res.clientBaseUrl, written: merge?.written ?? Object.keys(knobs), kept: merge?.kept ?? [], exitCode,
      out: p.values['dry-run'] ? null : out, provenancePath: p.values['dry-run'] ? null : provPath,
    }, null, 1) + '\n');
  } else {
    const loaderNotes = [...inputs.warnings, ...notes];
    if (inputs.ignored.length) loaderNotes.push(`ignored (not gateway-probes results): ${inputs.ignored.join(', ')}`);
    io.stdout(renderImportReport({ ...res, warnings: [...loaderNotes, ...res.warnings], exitCode }, { inputs: inputs.sources, merge }) + '\n');
  }
  if (!p.values['dry-run']) {
    if (existsSync(out) && mergePath) copyFileSync(out, `${out}.bak`);
    mkdirSync(dirname(out), { recursive: true });
    mkdirSync(dirname(provPath), { recursive: true });
    writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(provPath, JSON.stringify(sidecar, null, 2) + '\n');
    io.stderr(`kitzur: wrote ${out} and ${provPath}\n`);
  }
  return exitCode;
}

async function cmdState(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'show' && sub !== 'reset') throw new UsageError('state needs a subcommand: show, reset');
  const p = parseArgs(rest, { ...CONFIG_OPTS, key: { type: 'string' }, json: { type: 'boolean' }, plans: { type: 'boolean' } });
  const cfg = loadFromArgs(p, io).config;
  const dir = stateDirOf(cfg, io.env);
  const st = await importState();
  const key = p.values['key'] as string | undefined;
  if (sub === 'show') {
    const r = st.showState(dir, key);
    if (r.error) io.stderr(`kitzur: ${r.path}: ${r.error}\n`);
    if (p.values['json']) {
      io.stdout(JSON.stringify({ path: r.path, ...r.state }, null, 1) + '\n');
      return r.error ? 1 : 0;
    }
    const entries = Object.entries(r.state.entries);
    io.stdout(`${r.path}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${key ? ` matching ${key}` : ''}\n`);
    for (const [k, e] of entries) {
      io.stdout(
        `${k}\n  window ${e.window ?? '-'} (configured ${e.configuredWindow}), maxPrompt ${e.maxPrompt ?? '-'}, maxBodyBytes ${e.maxBodyBytes ?? '-'}, ` +
          `tighten ${e.tighten}, correction ${e.correction} (${e.samples} samples), includeUsageRejected ${e.includeUsageRejected}, updated ${e.updatedAt ?? '-'}\n`,
      );
      for (const t of e.tightenLog ?? []) io.stdout(`  tighten: ${t.at} ${t.rule} rejected raw ${t.rejectedRaw}\n`);
    }
    return r.error ? 1 : 0;
  }
  const gone = st.resetState(dir, key);
  io.stdout(gone.length ? `removed ${gone.length} entr${gone.length === 1 ? 'y' : 'ies'}: ${gone.join(', ')}\n` : 'no matching entries\n');
  if (p.values['plans']) {
    const plans = join(dir, 'plans');
    if (existsSync(plans)) {
      rmSync(plans, { recursive: true, force: true });
      io.stdout(`removed ${plans}\n`);
    }
  }
  io.stdout('restart a running proxy: it keeps its entries in memory and writes them back\n');
  return 0;
}

function cmdBench(argv: string[], io: CliIO): number {
  const runAll = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'run-all.js');
  if (!existsSync(runAll)) {
    io.stderr(`kitzur: the benchmark suite is not in this build (${runAll}); run it from a source checkout: npm run bench\n`);
    return 1;
  }
  const r = spawnSync(process.execPath, [runAll, ...argv], { stdio: 'inherit', env: io.env as NodeJS.ProcessEnv, cwd: io.cwd });
  return r.status ?? 1;
}

// ---------------------------------------------------------------- main

/** Runs one command; resolves with the exit code. Never calls process.exit. */
export async function main(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
        io.stderr(USAGE);
        return 2;
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return 0;
      case 'version':
      case '--version':
      case '-V':
        io.stdout(`kitzur ${packageInfo().version} (node ${process.version})\n`);
        return 0;
      case 'serve':
        return await cmdServe(rest, io);
      case 'replay':
        return await cmdReplay(rest, io);
      case 'count':
        return await cmdCount(rest, io);
      case 'status':
        return await cmdStatus(rest, io);
      case 'config':
        return await cmdConfig(rest, io);
      case 'state':
        return await cmdState(rest, io);
      case 'bench':
        return cmdBench(rest, io);
      default:
        throw new UsageError(`unknown command '${cmd}'`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`kitzur: ${e.message}\nrun 'kitzur help' for usage\n`);
      return 2;
    }
    if (e instanceof ConfigError) {
      for (const i of e.issues) io.stderr(`kitzur: config error: ${i}\n`);
      return 2;
    }
    if (e instanceof AppModuleError) {
      io.stderr(`kitzur: ${e.message}\n`);
      return 1;
    }
    io.stderr(`kitzur: error: ${(e as Error)?.message ?? String(e)}\n`);
    return 1;
  }
}

/** True when this module is the process entry point (also through an npm bin symlink). */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `kitzur config show | head`: a closed pipe ends the command quietly
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw e;
    });
  }
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // serve: open keep-alive sockets or timers must not hold the process after a drain
      setTimeout(() => process.exit(code), 2000).unref();
    },
    (e: unknown) => {
      process.stderr.write(`kitzur: fatal: ${(e as Error)?.stack ?? String(e)}\n`);
      process.exit(1);
    },
  );
}

export type { Logger };
