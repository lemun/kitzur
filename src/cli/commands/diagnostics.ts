import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, type LoadedConfig } from '../../config/load.js';
import { doctor, renderDoctor } from '../../diagnostics/doctor.js';
import { inspectTlsChain, renderTlsChain } from '../../diagnostics/tls-chain.js';
import { reportStream, renderReport } from '../../diagnostics/report.js';
import { createSnapshot } from '../../diagnostics/snapshot.js';
import { packageInfo } from '../../config/paths.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  try { url = new URL(origin); } catch { throw new UsageError('tls-probe needs an origin such as https://gateway.example.com'); }
  if (url.protocol !== 'https:') throw new UsageError(`tls-probe only inspects https origins, not ${url.protocol.slice(0, -1)}`);
  if (url.username || url.password) throw new UsageError('tls-probe origin must not contain credentials; remove the user:password@ part');
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
  const p = parseArgs(argv, { ...CONFIG_OPTS, json: { type: 'boolean' }, snapshot: { type: 'string' }, force: { type: 'boolean' }, model: { type: 'string' }, 'client-config': { type: 'string' }, 'check-upstream': { type: 'boolean' }, 'timeout-ms': { type: 'string' } });
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
  if (typeof p.values.snapshot === 'string') {
    const check = (code: string): string | undefined => result.checks.find((c) => c.code === code)?.status;
    let upstreamHost: string | undefined;
    try { upstreamHost = loaded.config.upstream.origin ? new URL(loaded.config.upstream.origin).hostname : undefined; } catch { /* Doctor reports invalid origins. */ }
    const snapshot = createSnapshot(result, loaded.config, loaded.models, {
      version: packageInfo().version, node: process.version, platform: process.platform, arch: process.arch,
      home: io.env.HOME, upstreamHost,
      tokenizerConfigured: Boolean(loaded.config.tokenizer.path), tokenizerLoads: check('tokenizer.load') === 'ok',
    });
    const output = JSON.stringify(snapshot, null, 2) + '\n';
    const file = p.values.snapshot;
    if (file === '-') io.stdout(output);
    else {
      const path = resolve(io.cwd, file);
      if (existsSync(path) && !p.values.force) { io.stderr(`kitzur: ${path} exists (use --force to overwrite)\n`); return 1; }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, output, { flag: p.values.force ? 'w' : 'wx' });
      io.stdout(`wrote ${path}\n`);
    }
    return result.exitCode;
  }
  io.stdout(p.values['json'] ? JSON.stringify(result, null, 2) + '\n' : renderDoctor(result) + '\n');
  return result.exitCode;
}

const READ_ERRORS: Record<string, string> = { ENOENT: 'no such file', EISDIR: 'it is a directory', EACCES: 'permission denied', EPERM: 'permission denied' };

export async function cmdReport(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { json: { type: 'boolean' } });
  if (p.positionals.length !== 1) throw new UsageError('report needs one stats JSONL file');
  let result;
  try { result = await reportStream(createReadStream(resolve(io.cwd, p.positionals[0]!))); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const cause = code ? READ_ERRORS[code] ?? `error ${code}` : 'unknown error';
    io.stderr(`kitzur: report could not read ${p.positionals[0]}: ${cause}; pass the file written by stats.path (see kitzur doctor)\n`);
    return 1;
  }
  io.stdout(p.values['json'] ? JSON.stringify(result, null, 2) + '\n' : renderReport(result) + '\n');
  return result.coverage.malformed ? 1 : 0;
}
