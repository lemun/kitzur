// Wiring (DESIGN.md): tokenizer -> counter -> engine (summarizer, tool rules, plan store) -> proxy
// (learned state, stats) -> listen, startup probe, graceful close.
//
// Counting: the engine always gets a local counter, 'exact' (tokenizer.path loads) or 'estimate'
// (tokenizer.mode 'estimate', no path, or a tokenizer that fails to load). The gateway tokenize client
// (tokenizer.endpoint) is built separately and handed to the proxy as a calibration source only; it is
// never given to the engine's counter (§4, , ADR-14).
//
// The engine and proxy modules are imported dynamically (the imports below are type-only), so the
// config/CLI surface works on a build without them and the error names the missing module:
//   src/engine/engine.js       createEngine(config, { counter, summarizer, rules, store, tokenizerSha256 })
//   src/engine/summary.js      createSummarizer (contracts.ts SummarizerFactory)
//   src/engine/rules/index.js  createToolRules (contracts.ts ToolRulesFactory)
//   src/engine/store.js        MemoryPlanStore({ maxPlans, maxBytes, persistence })
//   src/engine/store-file.js   createFilePersistence({ dir })                  (store.persist only)
//   src/proxy/state.js         StateStore({ dir, configuredWindow, counterId })
//   src/proxy/stats.js         StatsWriter(stats.path)
//   src/proxy/server.js        createProxyServer(config, { engine, counter, remote, state, stats, log })
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config/schema.js';
import { stateDirOf, packageInfo } from './config/paths.js';
import { counterFromConfig, type Counter } from './tokenize/counter.js';
import { loadTokenizerCached, type LoadedTokenizer } from './tokenize/load.js';
import { remoteFromConfig, type RemoteTokenizer } from './tokenize/remote.js';
import type { Engine, PlanStore } from './types.js';
import type { Summarizer, ToolRules } from './engine/contracts.js';
import type { EngineDeps } from './engine/engine.js';
import type { ProxyDeps, ProxyServer } from './proxy/server.js';
import type { StateStore } from './proxy/state.js';
import type { StatsWriter } from './proxy/stats.js';

// ---------------------------------------------------------------- logging

export type LogLevel = Config['logLevel'];
export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** A stderr logger ("kitzur: <level>: msg"). Never pass request content to it. */
export function createLogger(level: LogLevel, write: (s: string) => void = (s) => process.stderr.write(s)): Logger {
  const at = (l: LogLevel) => (msg: string): void => {
    if (RANK[l] <= RANK[level]) write(`kitzur: ${l}: ${msg}\n`);
  };
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

// ---------------------------------------------------------------- module loading

/** A required module or export is missing from this build. */
export class AppModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppModuleError';
  }
}

/** The factories app.ts wires together; tests and embedders may supply them directly. */
export interface AppModules {
  createEngine(config: Config, deps: EngineDeps): Engine;
  createSummarizer(config: Config, counter: Counter): Summarizer;
  createToolRules(config: Config): ToolRules;
  /** the memo store (with the file persistence when store.persist) */
  createStore(config: Config, stateDir: string): PlanStore | Promise<PlanStore>;
  createState(config: Config, stateDir: string, counterId: string): StateStore;
  createStats(config: Config): StatsWriter;
  createProxyServer(config: Config, deps: ProxyDeps): ProxyServer;
}

const srcName = (spec: string): string => spec.replace(/^\.\//, 'src/').replace(/\.js$/, '.ts');

async function importModule(spec: string): Promise<Record<string, unknown>> {
  try {
    return (await import(new URL(spec, import.meta.url).href)) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new AppModuleError(`this build has no ${srcName(spec)} (${(e as Error).message.split('\n')[0]})`);
    }
    throw e;
  }
}

async function importExport<T>(spec: string, name: string): Promise<T> {
  const v = (await importModule(spec))[name];
  if (v === undefined) throw new AppModuleError(`${srcName(spec)} does not export ${name}`);
  return v as T;
}

/** Loads the engine (and, with `proxy`, the proxy) factories. */
export async function loadModules(need: { proxy: boolean }): Promise<AppModules> {
  const createEngine = await importExport<AppModules['createEngine']>('./engine/engine.js', 'createEngine');
  const createSummarizer = await importExport<AppModules['createSummarizer']>('./engine/summary.js', 'createSummarizer');
  const createToolRules = await importExport<AppModules['createToolRules']>('./engine/rules/index.js', 'createToolRules');
  type StoreCtor = new (o: { maxPlans: number; maxBytes: number; persistence?: unknown }) => PlanStore;
  const MemoryPlanStore = await importExport<StoreCtor>('./engine/store.js', 'MemoryPlanStore');
  const createStore = async (config: Config, stateDir: string): Promise<PlanStore> => {
    let persistence: unknown = null;
    if (config.store.persist) {
      const dir = join(stateDir, 'plans');
      // plans hold summaries (user content, SECURITY.md) and the adapter appends with the process umask (0644 from
      // a shell): keep the directory owner-only so other local users cannot read them
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
      } catch {
        /* persistence is best effort (store-file.ts ignores I/O errors too) */
      }
      persistence = (await importExport<(o: { dir: string }) => unknown>('./engine/store-file.js', 'createFilePersistence'))({ dir });
    }
    return new MemoryPlanStore({ maxPlans: config.store.maxPlans, maxBytes: config.store.maxBytes, persistence });
  };
  const missing = (what: string) => (): never => {
    throw new AppModuleError(`${what} not loaded`);
  };
  let createState: AppModules['createState'] = missing('src/proxy/state.ts');
  let createStats: AppModules['createStats'] = missing('src/proxy/stats.ts');
  let createProxyServer: AppModules['createProxyServer'] = missing('src/proxy/server.ts');
  if (need.proxy) {
    const StateStoreCtor = await importExport<new (o: { dir: string | null; configuredWindow: number; counterId: string }) => StateStore>('./proxy/state.js', 'StateStore');
    const StatsWriterCtor = await importExport<new (path: string | null) => StatsWriter>('./proxy/stats.js', 'StatsWriter');
    createProxyServer = await importExport<AppModules['createProxyServer']>('./proxy/server.js', 'createProxyServer');
    createState = (config, stateDir, counterId) => new StateStoreCtor({ dir: stateDir, configuredWindow: config.budget.window, counterId });
    createStats = (config) => new StatsWriterCtor(config.stats.path);
  }
  return { createEngine, createSummarizer, createToolRules, createStore, createState, createStats, createProxyServer };
}

// ---------------------------------------------------------------- counter

export interface CounterSetup {
  /** the engine's counter: 'exact' or 'estimate', never 'remote' */
  counter: Counter;
  tokenizer: LoadedTokenizer | null;
  /** why the counter is an estimate, when it is (null in exact mode) */
  estimateReason: string | null;
}

/**
 * The engine counter the config describes (DESIGN §4 counter modes, ): exact when tokenizer.path
 * loads (through the compiled cache in the state dir), else the per-class estimate with the reason.
 */
export function setupCounter(config: Config, opts: { stateDir?: string | null; log?: Logger } = {}): CounterSetup {
  const t = config.tokenizer;
  let tokenizer: LoadedTokenizer | null = null;
  let estimateReason: string | null = null;
  if (t.mode === 'estimate') estimateReason = "tokenizer.mode is 'estimate'";
  else if (!t.path) estimateReason = 'tokenizer.path is not set';
  else {
    try {
      tokenizer = loadTokenizerCached(t.path, t.cachePath, { stateDir: opts.stateDir ?? null });
      opts.log?.info(`tokenizer ${t.path} loaded in ${tokenizer.loadMs.toFixed(0)} ms (cache: ${tokenizer.cacheStatus})`);
    } catch (e) {
      estimateReason = `tokenizer ${t.path} failed to load: ${(e as Error).message}`;
    }
  }
  if (estimateReason) opts.log?.warn(`counting with the per-class estimate: ${estimateReason}`);
  if (config.upstream.insecureTls) opts.log?.warn('upstream.insecureTls is ON: TLS certificates of the gateway are NOT verified');
  // never pass the remote client here: the engine's counts are local and synchronous (§4)
  const counter = counterFromConfig(config, { tokenizer });
  return { counter, tokenizer, estimateReason };
}

// ---------------------------------------------------------------- engine

export interface EngineSetup extends CounterSetup {
  engine: Engine;
  store: PlanStore;
  stateDir: string;
  modules: AppModules;
}

/** Builds counter + engine (no proxy): `replay`, `serve` and embedders. */
export async function buildEngine(
  config: Config,
  opts: { log?: Logger; modules?: AppModules; counter?: CounterSetup; env?: Record<string, string | undefined> } = {},
): Promise<EngineSetup> {
  const modules = opts.modules ?? (await loadModules({ proxy: false }));
  const stateDir = stateDirOf(config, opts.env);
  const cs = opts.counter ?? setupCounter(config, { stateDir, log: opts.log });
  const store = await modules.createStore(config, stateDir);
  const summarizer = modules.createSummarizer(config, cs.counter);
  const rules = modules.createToolRules(config);
  const engine = modules.createEngine(config, { counter: cs.counter, summarizer, rules, store, tokenizerSha256: cs.tokenizer?.sha256 ?? null });
  return { ...cs, engine, store, stateDir, modules };
}

// ---------------------------------------------------------------- app

export interface ProbeOutcome {
  ok: boolean;
  status?: number;
  /** a TLS verification failure: serve exits non-zero (§9 TLS) */
  tlsError?: string;
  error?: string;
  timedOut?: boolean;
}

export interface App extends EngineSetup {
  config: Config;
  remote: RemoteTokenizer | null;
  state: StateStore;
  stats: StatsWriter;
  server: ProxyServer;
  version: string;
  /** listen on config.listen; resolves with the bound address */
  listen(): Promise<{ host: string; port: number }>;
  /**
   * Startup probe GET <origin>/v1/models (§9): a TLS verification failure is `tlsError`; a connection
   * failure is logged and shown in /status, and the proxy keeps running. Resolves by `timeoutMs`.
   */
  probe(timeoutMs?: number): Promise<ProbeOutcome>;
  /** graceful stop: stop accepting, drain in-flight requests (up to drainMs), flush state and stats */
  close(drainMs?: number): Promise<void>;
}

/**
 * Builds the whole proxy: counter, engine, learned state, stats, calibration client and server. Throws
 * AppModuleError when an engine or proxy module is missing from the build.
 */
export async function buildApp(
  config: Config,
  opts: { log?: Logger; modules?: AppModules; env?: Record<string, string | undefined> } = {},
): Promise<App> {
  const log = opts.log ?? createLogger(config.logLevel);
  const modules = opts.modules ?? (await loadModules({ proxy: true }));
  const es = await buildEngine(config, { log, modules, env: opts.env });
  const remote = remoteFromConfig(config); // calibration source only (§4)
  const state = modules.createState(config, es.stateDir, es.counter.id);
  const stats = modules.createStats(config);
  const server = modules.createProxyServer(config, {
    engine: es.engine,
    counter: es.counter,
    remote,
    state,
    stats,
    log: (level, msg) => log[level](msg),
  });
  return {
    ...es,
    config,
    remote,
    state,
    stats,
    server,
    version: packageInfo().version,
    listen: () => server.listen(),
    async probe(timeoutMs = 10_000) {
      const up = server.upstream as { probe?: () => Promise<ProbeOutcome> } | undefined;
      if (!up || typeof up.probe !== 'function') return { ok: true };
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<ProbeOutcome>((r) => {
        timer = setTimeout(() => r({ ok: false, timedOut: true, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
        timer.unref();
      });
      const r = await Promise.race([up.probe(), late]);
      clearTimeout(timer);
      if (!r.ok && !r.tlsError) {
        log.error(`startup probe GET ${config.upstream.origin}/v1/models: ${r.error ?? `HTTP ${r.status}`}; the proxy keeps running`);
        (server.status as { warn?: (k: string, m: string) => void } | undefined)?.warn?.('upstream_probe', r.error ?? `HTTP ${r.status}`);
      }
      return r;
    },
    close: (drainMs = 30_000) => server.close(drainMs),
  };
}
