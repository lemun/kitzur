import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, type LoadedConfig } from '../../config/load.js';
import { doctor, renderDoctor } from '../../diagnostics/doctor.js';
import { inspectTlsChain, renderTlsChain } from '../../diagnostics/tls-chain.js';
import { reportStream, renderReport } from '../../diagnostics/report.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';

export async function cmdTlsProbe(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, 'ca-file': { type: 'string' }, json: { type: 'boolean' }, 'timeout-ms': { type: 'string' } });
  if (p.positionals.length > 1) throw new UsageError('tls-probe takes at most one origin');
  const timeoutMs = Number(p.values['timeout-ms'] ?? 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new UsageError('--timeout-ms must be an integer from 1 to 10000');
  const config = loadFromArgs(p, io).config;
  const origin = p.positionals[0] ?? config.upstream.origin;
  if (!origin) throw new UsageError('tls-probe needs an origin or upstream.origin in config');
  let url: URL;
  try { url = new URL(origin); } catch { throw new UsageError('tls-probe requires an https origin'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new UsageError('tls-probe requires an https origin without credentials');
  const caFile = p.values['ca-file'] as string | undefined ?? config.upstream.caFile;
  try {
    const result = await inspectTlsChain({ origin, caFile: caFile ? resolve(io.cwd, caFile) : null, timeoutMs });
    io.stdout((p.values['json'] ? JSON.stringify(result, null, 2) : renderTlsChain(result)) + '\n');
    return result.diagnosis === 'ok' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stdout((p.values['json'] ? JSON.stringify({ error: message }) : `TLS probe failed: ${message}`) + '\n');
    return 1;
  }
}

export async function cmdDoctor(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, json: { type: 'boolean' }, model: { type: 'string' }, 'client-config': { type: 'string' }, 'check-upstream': { type: 'boolean' }, 'timeout-ms': { type: 'string' } });
  if (p.positionals.length) throw new UsageError('doctor takes no positional arguments');
  const timeoutMs = p.values['timeout-ms'] === undefined ? 3000 : Number(p.values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new UsageError('--timeout-ms must be an integer from 1 to 10000');
  let loaded: LoadedConfig;
  try { loaded = loadFromArgs(p, io); }
  catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    const result = { checks: [{ code: 'config.load', status: 'error' as const, message: 'Configuration could not be loaded.', fix: 'Check the config file exists and contains valid JSON/JSONC with supported settings.' }], exitCode: 2 };
    io.stdout(p.values['json'] ? JSON.stringify(result, null, 2) + '\n' : renderDoctor(result) + '\n');
    return 2;
  }
  const result = await doctor(loaded.config, { env: io.env, upstreamCheck: p.values['check-upstream'] === true, timeoutMs, configPath: loaded.configPath ?? undefined, clientConfigPath: p.values['client-config'] as string | undefined, models: loaded.models, model: p.values.model as string | undefined });
  io.stdout(p.values['json'] ? JSON.stringify(result, null, 2) + '\n' : renderDoctor(result) + '\n');
  return result.exitCode;
}

export async function cmdReport(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { json: { type: 'boolean' } });
  if (p.positionals.length !== 1) throw new UsageError('report needs one stats JSONL file');
  let result;
  try { result = await reportStream(createReadStream(resolve(io.cwd, p.positionals[0]!))); }
  catch { io.stderr('kitzur: report could not read the stats file\n'); return 1; }
  io.stdout(p.values['json'] ? JSON.stringify(result, null, 2) + '\n' : renderReport(result) + '\n');
  return result.coverage.malformed ? 1 : 0;
}
