import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { fmtHost, formatStatus } from '../format.js';
import { httpGet } from '../http.js';

export async function cmdStatus(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, url: { type: 'string' }, json: { type: 'boolean' }, 'timeout-ms': { type: 'string' } });
  const timeoutMs = Number(p.values['timeout-ms'] ?? 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new UsageError('--timeout-ms must be an integer from 1 to 10000');
  let url = p.values['url'] as string | undefined;
  if (url !== undefined) {
    let protocol = '';
    try { protocol = new URL(url).protocol; } catch { /* not a URL: rejected below */ }
    if (protocol !== 'http:' && protocol !== 'https:') throw new UsageError('--url must be an http(s) URL such as http://127.0.0.1:8270/status');
  }
  let token: string | null = null;
  let configPath: string | null = null;
  if (!url) {
    const loaded = loadFromArgs(p, io);
    const cfg = loaded.config;
    configPath = loaded.configPath;
    token = cfg.listen.token;
    const host = cfg.listen.host === '0.0.0.0' || cfg.listen.host === '::' ? '127.0.0.1' : cfg.listen.host;
    url = `http://${fmtHost(host)}:${cfg.listen.port}/status`;
  }
  try {
    const r = await httpGet(url, timeoutMs, token);
    let body = r.body;
    try {
      const s = JSON.parse(r.body);
      body = p.values['json'] || r.status !== 200 ? JSON.stringify(s, null, 1) : formatStatus(s ?? {});
    } catch {
      /* not JSON: print as is */
    }
    io.stdout(body.endsWith('\n') ? body : body + '\n');
    if (r.status !== 200) io.stderr(`kitzur: ${url} returned HTTP ${r.status}\n`);
    return r.status === 200 ? 0 : 1;
  } catch (e) {
    io.stderr(`kitzur: cannot reach ${url}: ${(e as Error).message}\n${unreachableHint(url, configPath)}\n`);
    return 1;
  }
}

/** The next step after a failed connection: the host:port tried and how to start the server. */
export function unreachableHint(url: string, configPath: string | null): string {
  let where = url;
  try {
    where = new URL(url).host || url;
  } catch {
    /* not a URL: name it as given */
  }
  return `kitzur: nothing answered at ${where}; is it running? start it with: kitzur serve --config ${configPath ?? '<path>'} (or kitzur autostart status on Windows)`;
}
