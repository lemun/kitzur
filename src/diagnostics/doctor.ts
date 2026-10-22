import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { request } from 'node:http';
import { existsSync, statSync, accessSync, constants, readFileSync } from 'node:fs';
import { dirname, parse } from 'node:path';
import { listenTokenWarning, validateConfig } from '../config/validate.js';
import { computeBudget } from '../config/derived.js';
import type { Config, ModelProfiles } from '../config/schema.js';
import { stateDirOf } from '../config/paths.js';
import { loadTokenizerCached } from '../tokenize/load.js';
import { loadTokenizer } from '../tokenize/tokenizer.js';
import { templateTokenizerWarning } from '../tokenize/template.js';
import { parseJsonc } from '../config/jsonc.js';
import { clientConfigChecks } from './client-config.js';
import { Upstream } from '../proxy/upstream.js';

export interface DoctorCheck { code: string; status: 'ok' | 'warn' | 'error'; message: string; fix?: string }
export interface DoctorResult { checks: DoctorCheck[]; exitCode: number }

/** PowerShell quoting keeps paths containing spaces or apostrophes intact. */
function detachedCommand(configPath?: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const args = `"${fileURLToPath(new URL('../cli.js', import.meta.url))}" serve${configPath ? ` --config "${configPath}"` : ''}`;
  return `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(args)} -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\\kitzur-out.log" -RedirectStandardError "$env:TEMP\\kitzur-err.log"`;
}

/** Distinguish an absent instance from one accepting TCP but unable to serve HTTP. */
export async function probeInstance(host: string, port: number, timeoutMs = 3000, token: string | null = null): Promise<'absent' | 'responsive' | 'hung' | 'other'> {
  const started = Date.now();
  timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 3000)) : 3000;
  const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const listening = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: target, port });
    const finish = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  if (!listening) return 'absent';
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: 'responsive' | 'hung' | 'other'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const failed = (e: NodeJS.ErrnoException): void => {
      finish(e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' ? 'hung' : 'other');
    };
    const req = request({ hostname: target, port, path: '/status', agent: false, headers: token === null ? {} : { authorization: 'Bearer ' + token } }, (res) => {
      res.on('error', failed);
      if (res.statusCode !== 200) { finish('other'); return; }
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1024 * 1024) finish('other');
      });
      res.on('end', () => {
        try { finish(JSON.parse(body)?.name === 'kitzur' ? 'responsive' : 'other'); }
        catch { finish('other'); }
      });
    });
    const timer = setTimeout(() => finish('hung'), Math.max(1, timeoutMs - (Date.now() - started)));
    req.on('error', failed);
    req.end();
  });
}

function nearestExistingDirectory(path: string): { path: string; blocked: boolean } | null {
  let current = path;
  while (true) {
    if (existsSync(current)) return statSync(current).isDirectory() ? { path: current, blocked: false } : { path: current, blocked: true };
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return null;
    current = parent;
  }
}

/** Read-only local diagnostics. Network access is opt-in and uses the small models endpoint probe. */
export async function doctor(config: Config, opts: { env?: Record<string, string | undefined>; upstreamCheck?: boolean; timeoutMs?: number; configPath?: string; clientConfigPath?: string; models?: ModelProfiles; model?: string } = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const add = (code: string, status: DoctorCheck['status'], message: string, fix?: string): void => { checks.push({ code, status, message, ...(fix ? { fix } : {}) }); };

  try {
    const validation = validateConfig(config, { checkFiles: true, checkTokenizer: false });
    if (!validation.errors.length) add('config.valid', 'ok', 'Configuration is valid.');
    else add('config.valid', 'error', `Configuration has ${validation.errors.length} validation error(s).`, 'Run `kitzur config validate` and correct the reported settings.');
    if (validation.warnings.length) add('config.warnings', 'warn', `Configuration has ${validation.warnings.length} warning(s).`, 'Review `kitzur config validate` output.');
  } catch {
    add('config.valid', 'error', 'Configuration could not be validated safely.', 'Run `kitzur config validate` and correct the reported settings.');
  }
  if (listenTokenWarning(config)) add('listen.token', 'warn', 'upstream.headers is set without listen.token: every local process can use those credentials through the proxy.', 'Set listen.token and give it to the agent as its API key.');

  let b: ReturnType<typeof computeBudget> | null = null;
  try { b = computeBudget(config); } catch { /* malformed config is reported with fixed diagnostics */ }
  if (!b) add('budget.compatible', 'error', 'Configured budget could not be calculated.', 'Run `kitzur config validate` and correct the budget settings.');
  else {
    if (b.budget > 0 && b.target < b.trigger && b.hard > 0) add('budget.compatible', 'ok', `Budget is usable (window ${b.window}, prompt budget ${b.budget}, trigger ${b.trigger}, target ${b.target}).`);
    else add('budget.compatible', 'error', 'Configured context, output, and client limits leave no usable compaction budget.', 'Adjust budget.window, budget.planMaxTokens/defaultMaxTokens, client limits, or safety margins.');
    if (b.hard <= 1) add('budget.client_limits', 'error', `Client compaction point ${b.clientPoint} minus output allowance ${b.allowance} leaves no usable prompt budget.`, 'Adjust client.compactionPointTokens and client.outputAllowanceTokens.');
    else if (config.client.outputLimit !== null && b.planMaxTokens < config.client.outputLimit) add('budget.client_limits', 'warn', `Planned output limit ${b.planMaxTokens} is below the client output limit ${config.client.outputLimit}; long replies may be fitted down.`, 'Align budget.planMaxTokens/defaultMaxTokens with client.outputLimit.');
    else add('budget.client_limits', 'ok', 'Configured plan output and client limits are compatible.');
  }

  const modelEntries = Object.entries(opts.models ?? {}).filter(([model]) => !opts.model || model === opts.model);
  for (const [model, profile] of modelEntries) {
    const budget = computeBudget(profile);
    add(`model.${model}.budget`, budget.budget > 0 && budget.hard > 1 ? 'ok' : 'error', `window=${budget.window}; prompt=${budget.budget}; hard=${budget.hard}`);
    const code = `model.${model}.tokenizer`;
    if (profile.tokenizer.mode === 'estimate' || !profile.tokenizer.path) {
      add(code, 'warn', `counter=estimate; reason=${profile.tokenizer.mode === 'estimate' ? "tokenizer.mode is 'estimate'" : 'tokenizer.path is not set'}; sha256=null; sourceBytes=0; loadMs=0`);
      continue;
    }
    try {
      const sourceBytes = statSync(profile.tokenizer.path).size;
      if (sourceBytes > 64 * 1024 * 1024) {
        add(code, 'warn', `counter=estimate; reason=tokenizer source exceeds 64 MiB; sha256=null; sourceBytes=${sourceBytes}; loadMs=0`);
        continue;
      }
      const started = performance.now();
      const cachePath = profile.tokenizer.path !== config.tokenizer.path && profile.tokenizer.cachePath === config.tokenizer.cachePath ? null : profile.tokenizer.cachePath;
      const tok = loadTokenizerCached(profile.tokenizer.path, cachePath);
      add(code, 'ok', `counter=exact; sha256=${tok.sha256}; sourceBytes=${sourceBytes}; loadMs=${Math.round(performance.now() - started)}`);
      const warning = templateTokenizerWarning(profile.tokenizer.template.name, tok);
      if (warning) add(`model.${model}.template`, 'warn', warning);
    } catch (error) {
      add(code, 'warn', `counter=estimate; reason=${(error as Error).message}; sha256=null; sourceBytes=0; loadMs=0`);
    }
  }

  if (opts.clientConfigPath) {
    try { checks.push(...clientConfigChecks(config, parseJsonc(readFileSync(opts.clientConfigPath, 'utf8')), opts.models)); }
    catch { add('client.config', 'error', 'Client configuration could not be read as JSON/JSONC.'); }
  }

  if (config.tokenizer.mode === 'estimate') add('tokenizer.mode', 'warn', 'Tokenizer mode is estimate; token counts use the configured character ratios.', 'Set tokenizer.mode to auto and configure tokenizer.path for exact local counts.');
  else if (!config.tokenizer.path) add('tokenizer.path', 'warn', 'No tokenizer file is configured; counts fall back to estimates.', 'Set tokenizer.path to a supported tokenizer.json file.');
  else if (!existsSync(config.tokenizer.path)) add('tokenizer.path', 'warn', 'Configured tokenizer file is missing; counts fall back to estimates.', 'Check tokenizer.path or provide a supported tokenizer.json file.');
  else {
    try {
      const tok = loadTokenizer(config.tokenizer.path);
      const warning = templateTokenizerWarning(config.tokenizer.template.name, tok);
      if (warning) add('tokenizer.template', 'warn', warning);
      const n = tok.count('kitzur diagnostic');
      add(n > 0 ? 'tokenizer.load' : 'tokenizer.count', n > 0 ? 'ok' : 'error', n > 0 ? 'Tokenizer loaded and counted a sample locally.' : 'Tokenizer returned an empty count for a non-empty sample.', n > 0 ? undefined : 'Check tokenizer.json and use a supported tokenizer.');
    } catch {
      add('tokenizer.load', 'error', 'Tokenizer file could not be loaded or counted.', 'Check tokenizer.path and use a supported tokenizer.json file.');
    }
  }

  const pathCheck = (code: string, path: string | null, label: string): void => {
    if (path === null) { add(code, 'ok', `${label} path is not configured.`); return; }
    try {
      if (!existsSync(path)) {
        const parent = nearestExistingDirectory(path);
        if (parent?.blocked) { add(code, 'error', `An existing non-directory path blocks the ${label.toLowerCase()} directory.`, 'Choose a path below an accessible directory.'); return; }
        if (!parent) { add(code, 'warn', `${label} path and its parent directories do not exist.`, 'Create the directory or update the configured path.'); return; }
        accessSync(parent.path, constants.R_OK | constants.W_OK);
        add(code, 'ok', `${label} directory does not exist yet; nearest existing parent is accessible.`);
        return;
      }
      const s = statSync(path);
      if (!s.isDirectory()) { add(code, 'error', `${label} path is not a directory.`, 'Set it to a directory path.'); return; }
      accessSync(path, constants.R_OK | constants.W_OK);
      add(code, 'ok', `${label} directory exists and is accessible.`);
    } catch { add(code, 'warn', `${label} directory is not accessible.`, 'Check directory permissions and configured path.'); }
  };
  const statePath = stateDirOf(config, opts.env);
  pathCheck('state.directory', statePath, 'State');
  if (config.stats.path) {
    try {
      const parent = dirname(config.stats.path);
      if (existsSync(config.stats.path)) {
        if (!statSync(config.stats.path).isFile()) add('stats.path', 'error', 'Stats path is not a file.', 'Set stats.path to a JSONL file.');
        else { accessSync(config.stats.path, constants.R_OK | constants.W_OK); add('stats.path', 'ok', 'Stats file exists and is accessible.'); }
      } else {
        const existingParent = nearestExistingDirectory(parent);
        if (existingParent?.blocked) add('stats.path', 'error', 'An existing non-directory path blocks the stats file parent.', 'Choose a stats path below an accessible directory.');
        else if (existingParent) { accessSync(existingParent.path, constants.W_OK); add('stats.path', 'ok', 'Stats file parent does not exist yet; nearest existing parent is writable.'); }
        else add('stats.path', 'error', 'An existing non-directory path blocks the stats file parent.', 'Choose a stats path below an accessible directory.');
      }
    } catch { add('stats.path', 'warn', 'Stats file path is not accessible.', 'Check directory permissions and configured path.'); }
  } else add('stats.path', 'ok', 'Stats output is disabled.');

  const instance = await probeInstance(config.listen.host, config.listen.port, Math.min(opts.timeoutMs ?? 3000, 3000), config.listen.token);
  if (instance === 'hung') {
    add('instance.responsive', 'error', 'Detected: a Kitzur process is listening but not responding. On Windows, a paused console (including QuickEdit selection) can freeze synchronous console writes.',
      `Restart detached with logs to a file. PowerShell: ${detachedCommand(opts.configPath)}`);
  } else if (instance === 'other') {
    add('instance.responsive', 'warn', `Another service (or a Kitzur refusing this probe) answers on ${config.listen.port}.`,
      'Check listen.host, listen.port, and allowed Host settings; inspect the service response before taking action.');
  } else add('instance.responsive', 'ok', instance === 'responsive' ? 'Running instance answered GET /status.' : 'No running instance accepted a local TCP connection.');

  if (opts.upstreamCheck) {
    let upstream: Upstream | undefined;
    try {
      const cfg = structuredClone(config.upstream);
      const requestedTimeout = opts.timeoutMs ?? config.upstream.timeoutMs;
      cfg.timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1, Math.min(10_000, Math.floor(requestedTimeout))) : 3000;
      upstream = new Upstream(cfg);
      const token = (opts.env ?? process.env).KITZUR_PROBE_TOKEN;
      const hasAuth = Object.keys(cfg.headers).some((key) => /authorization|api[-_]?key|token|cookie/i.test(key));
      if (token) for (const key of Object.keys(cfg.headers)) if (key.toLowerCase() === 'authorization') delete cfg.headers[key];
      const result = await upstream.probe('/v1/models', token ? { authorization: 'Bearer ' + token } : {});
      const status = result.status ?? 0;
      if (status >= 200 && status < 300) add('upstream.reachable', 'ok', `Upstream responded to the lightweight models probe (HTTP ${status}).${token ? ' Key accepted.' : ''}`);
      else if (status === 401 || status === 403) add('upstream.reachable', token || hasAuth ? 'warn' : 'ok',
        token ? 'Upstream is reachable; probe key rejected.' : hasAuth ? 'Upstream is reachable; configured key rejected.' : 'Upstream is reachable; gateway requires a key; the client supplies it.',
        token ? 'Check KITZUR_PROBE_TOKEN.' : hasAuth ? 'Check upstream.headers authorization configuration.' : undefined);
      else if (status === 404) add('upstream.reachable', 'warn', 'Upstream is reachable but /v1/models is unavailable (HTTP 404).', 'Check the upstream gateway route.');
      else add('upstream.reachable', 'error', 'Upstream probe failed.', 'Check upstream.origin, TLS settings, and network availability.');
    } catch { add('upstream.reachable', 'error', 'Upstream probe could not be completed.', 'Check upstream.origin and upstream configuration.'); }
    finally { upstream?.close(); }
  } else add('upstream.skipped', 'ok', 'Upstream check skipped; pass --check-upstream to probe it.');

  return { checks, exitCode: checks.some((c) => c.status === 'error') ? 1 : 0 };
}

export function renderDoctor(result: DoctorResult): string {
  return [...result.checks.map((c) => `${c.status.toUpperCase()} ${c.code}: ${c.message}${c.fix ? ` Fix: ${c.fix}` : ''}`), `Exit code: ${result.exitCode}`].join('\n');
}
