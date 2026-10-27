import { join } from 'node:path';
import { buildApp } from '../../app.js';
import { validateConfig } from '../../config/validate.js';
import { computeBudget } from '../../config/derived.js';
import { stateDirOf } from '../../config/paths.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { fmtHost } from '../format.js';

export async function cmdServe(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, 'drain-ms': { type: 'string' } });
  if (p.positionals.length) throw new UsageError(`serve takes no arguments (got ${p.positionals.join(' ')})`);
  const l = loadFromArgs(p, io);
  const cfg = l.config;
  // Routine serving logs stay off the attached console; fatal startup errors also reach stderr.
  const { RuntimeLog } = await import('../../diagnostics/runtime.js');
  const log = new RuntimeLog({ dir: join(stateDirOf(cfg, io.env), 'logs'), file: cfg.log.file, console: cfg.log.console, level: cfg.logLevel });
  const v = validateConfig(cfg, { provenance: l.provenance, checkFiles: true });
  for (const w of [...l.warnings, ...v.warnings.filter((x) => !/^upstream\.origin is not set/.test(x))]) log.warn(w);
  if (v.errors.length || !cfg.upstream.origin) {
    for (const e of v.errors) io.stderr(`kitzur: config error: ${e}\n`);
    if (!cfg.upstream.origin) io.stderr('kitzur: config error: upstream.origin is required (--upstream http://gateway:8000, KITZUR_UPSTREAM_ORIGIN or the config file)\n');
    await log.close();
    return 2;
  }
  const drainMs = p.values['drain-ms'] !== undefined ? Number(p.values['drain-ms']) : 30_000;
  if (!Number.isFinite(drainMs) || drainMs < 0) throw new UsageError('--drain-ms must be a number of milliseconds');
  const app = await buildApp(cfg, { log, modules: io.modules, env: io.env, models: l.models, configPath: l.configPath });
  let addr: { host: string; port: number };
  try { addr = await app.listen(); }
  catch (e) { await app.close(0); throw e; }
  // startup probe (§9 TLS): a certificate failure exits non-zero; an unreachable upstream only logs
  const probe = await app.probe(Math.min(10_000, cfg.upstream.timeoutMs));
  if (probe.tlsError) {
    const message = `TLS verification of ${cfg.upstream.origin} failed: ${probe.tlsError} (set upstream.caFile or NODE_EXTRA_CA_CERTS; see deploy/README.md)`;
    log.error(message);
    io.stderr(`kitzur: error: ${message}\n`);
    await app.close(0);
    return 1;
  }
  const b = computeBudget(cfg);
  log.info(`upstream ${cfg.upstream.origin}; counter ${app.counter.mode}; mode ${b.mode}; budget ${b.budget}, trigger ${b.trigger}, target ${b.target}`);
  // stdout keeps the documented 'listening on' line (help text, bench harness, supervisors); the file log records it too
  io.stdout(`listening on http://${fmtHost(addr.host)}:${addr.port}\n`);
  log.info(`listening on http://${fmtHost(addr.host)}:${addr.port}`);
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
          void log.close().then(() => done(0));
        },
        (e: unknown) => {
          log.error(`shutdown: ${(e as Error).message}`);
          done(1);
        },
      );
    });
  });
}
