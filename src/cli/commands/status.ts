import { formatPaths } from '../../proxy/status.js';
import type { CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { fmtHost } from '../format.js';
import { httpGet } from '../http.js';

export async function cmdStatus(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, { ...CONFIG_OPTS, url: { type: 'string' }, json: { type: 'boolean' }, 'timeout-ms': { type: 'string' } });
  let url = p.values['url'] as string | undefined;
  let token: string | null = null;
  if (!url) {
    const cfg = loadFromArgs(p, io).config;
    token = cfg.listen.token;
    const host = cfg.listen.host === '0.0.0.0' || cfg.listen.host === '::' ? '127.0.0.1' : cfg.listen.host;
    url = `http://${fmtHost(host)}:${cfg.listen.port}/status`;
  }
  try {
    const r = await httpGet(url, Number(p.values['timeout-ms'] ?? 5000), token);
    let body = r.body;
    try {
      const s = JSON.parse(r.body);
      body = p.values['json'] || r.status !== 200 ? JSON.stringify(s, null, 1) : [
        `${s.name ?? 'kitzur'} ${s.version ?? ''} — uptime ${s.uptime_s ?? '?'}s`,
        formatPaths(s.paths ?? { config: null, state_dir: '?', log_file: null }),
        `Chat requests: ${s.counters?.chat_requests ?? 0}; actions: ${Object.entries(s.actions ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
        `Budget: ${s.budget?.budget ?? '?'}; trigger: ${s.budget?.trigger ?? '?'}; target: ${s.budget?.target ?? '?'}`,
        s.last_compaction ? `Last compaction: ${s.last_compaction.at} — ${s.last_compaction.in ?? '?'} -> ${s.last_compaction.out ?? '?'} tokens (trigger ${s.last_compaction.trigger ?? '?'})` : 'Last compaction: none since startup',
        `Recent requests: ${s.recent_requests?.length ?? 0}/64 (in memory; reset on restart)`,
        ...(s.recent_requests ?? []).slice(-5).map((r: { action: string; tokens: { in: number | null; out: number | null }; model: string | null; ms: number }) => `  ${r.action} ${r.tokens.in ?? '?'} -> ${r.tokens.out ?? '?'} tokens; model=${JSON.stringify(r.model)}; ${r.ms}ms`),
      ].join('\n');
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
