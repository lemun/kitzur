import { computeBudget, planMaxTokens } from '../config/derived.js';
import { isPlainObject } from '../config/spec.js';
import { isAutoWindow } from '../config/window.js';
import { jsonErrorInfo, lineCol } from '../config/jsonc.js';
import type { Config } from '../config/schema.js';

// ---------------------------------------------------------------- helpers

export const fmtHost = (h: string): string => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** `https://user:secret@gw` -> `https://<credentials>@gw` (an origin with credentials fails validation, but show prints it). */
export function maskUserinfo(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1<credentials>@') : v;
}

/** A config value for display: header values and URL credentials masked, long strings shortened. */
export function display(path: string, v: unknown, full = false): string {
  if (path === 'upstream.headers' && isPlainObject(v)) v = Object.fromEntries(Object.keys(v).map((k) => [k, '<set>']));
  if (path === 'listen.token' && v !== null) v = '<set>';
  if (path === 'upstream.origin') v = maskUserinfo(v);
  const s = JSON.stringify(v) ?? 'undefined';
  return !full && s.length > 100 ? `${s.slice(0, 90)}… (${s.length} chars)` : s;
}

export function maskedConfig(c: Config): Config {
  const m = structuredClone(c);
  if (m.listen.token !== null) m.listen.token = '<set>';
  m.upstream.headers = Object.fromEntries(Object.keys(m.upstream.headers).map((k) => [k, '<set>']));
  m.upstream.origin = maskUserinfo(m.upstream.origin) as string | null;
  if (isAutoWindow(c)) (m.budget as unknown as Record<string, unknown>)['window'] = 'auto';
  return m;
}

export function derivedLines(cfg: Config): string[] {
  const head = cfg.budget.observedFixedPromptTokens;
  const b = computeBudget(cfg, { counterFixedTokens: head });
  const why = cfg.server.budgetMode ? 'server.budgetMode' : cfg.budget.limitCountsMaxTokens !== null ? 'budget.limitCountsMaxTokens' : `server.type ${cfg.server.type}`;
  return [
    `# derived (T_req = budget.defaultMaxTokens, no learned entry)`,
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
export function parseNoEcho(text: string, lineNo?: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const { reason, pos } = jsonErrorInfo((e as Error).message, text);
    const lc = pos === null ? null : lineCol(text, pos);
    const where = lineNo !== undefined ? ` at line ${lineNo}${lc ? ` column ${lc.col}` : ''}` : lc ? ` at line ${lc.line} column ${lc.col}` : '';
    throw new Error(`${reason}${where}`);
  }
}

// ---------------------------------------------------------------- kitzur status

/** `8040` -> `2h 14m`; under a minute stays in seconds. */
export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(s % 60)}s` : `${Math.max(0, Math.floor(s))}s`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRec = (v: unknown): v is Record<string, unknown> => isPlainObject(v);
/** One line of at most 200 characters: control characters (newlines included) become spaces. */
const one = (v: unknown): string => {
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};
/** `label<sep>value` for each key whose value is a finite number or a string; anything else is skipped. */
const pairs = (o: Record<string, unknown>, keys: Array<[string, string]>, sep = ' '): string[] =>
  keys.flatMap(([k, label]) => (isNum(o[k]) || typeof o[k] === 'string' ? [`${label}${sep}${one(o[k])}`] : []));

/** `<in> -> <out> tokens`, or '' unless both counts are numbers. */
const tokens = (o: Record<string, unknown>): string => (isNum(o['in']) && isNum(o['out']) ? `${o['in']} -> ${o['out']} tokens` : '');
/** The Paths line of a /status `paths` record: a null config or log_file reads as before, an absent field is skipped. */
const pathsLine = (p: Record<string, unknown>): string => {
  const shown = (k: string, ifNull?: string): string[] =>
    typeof p[k] === 'string' ? [`${k}=${String(p[k]).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ')}`] : p[k] === null && ifNull ? [`${k}=${ifNull}`] : [];
  return `Paths: ${[...shown('config', 'defaults only'), ...shown('state_dir'), ...shown('log_file', '?')].join('; ') || 'unknown'}`;
};

/** The human text of `kitzur status` for a /status body. Never content: only names, counts and sizes. */
export function formatStatus(s: Record<string, unknown>, now: number = Date.now()): string {
  const groups: string[][] = [];
  const uptime = isNum(s['uptime_s']) ? `— uptime ${fmtUptime(s['uptime_s'])}` : '';
  groups.push([
    [one(typeof s['name'] === 'string' ? s['name'] : 'kitzur'), typeof s['version'] === 'string' ? one(s['version']) : '', uptime].filter(Boolean).join(' '),
    isRec(s['paths']) ? pathsLine(s['paths']) : 'Paths: config=defaults only; state_dir=?; log_file=?',
  ]);
  const warnings = Array.isArray(s['warnings']) ? s['warnings'].filter(isRec) : [];
  groups.push(warnings.length
    ? ['Warnings:', ...warnings.map((w) => `  ${one(w['key'] ?? '?')}: ${one(w['message'] ?? '')}${isNum(w['count']) && w['count'] > 1 ? ` (x${w['count']})` : ''}`)]
    : ['Warnings: none']);
  const b = isRec(s['budget']) ? s['budget'] : {};
  const budget = [`Budget: ${pairs(b, [['window', 'window'], ['budget', 'budget'], ['trigger', 'trigger'], ['target', 'target']]).join('; ') || 'unknown'}`];
  const profiles = isRec(s['profiles']) ? Object.entries(s['profiles']).filter((e): e is [string, Record<string, unknown>] => isRec(e[1])) : [];
  for (const [id, p] of profiles.slice(0, 8)) budget.push(`  ${JSON.stringify(one(id))}: ${pairs(p, [['W', 'window'], ['trigger', 'trigger'], ['counter_mode', 'counter']]).join('; ')}`);
  if (profiles.length > 8) budget.push(`  +${profiles.length - 8} more`);
  groups.push(budget);
  const c = isRec(s['counters']) ? s['counters'] : {};
  const actions = isRec(s['actions']) ? pairs(s['actions'], Object.keys(s['actions']).map((k) => [k, one(k)]), '=') : [];
  const requests = [`Chat requests: ${isNum(c['chat_requests']) ? c['chat_requests'] : 0}; actions: ${actions.join(', ') || 'none'}`];
  if (isRec(s['outcomes'])) {
    const o = pairs(s['outcomes'], ['ok', 'aborted', 'incomplete', 'upstream_error', 'refused'].map((k) => [k, k]), '=');
    if (o.length) requests.push(`Outcomes: ${o.join(', ')}`);
  }
  const lc = isRec(s['last_compaction']) ? s['last_compaction'] : null;
  const at = lc && typeof lc['at'] === 'string' ? Date.parse(lc['at']) : NaN;
  const ago = Number.isFinite(at) && now >= at ? ` (${fmtUptime((now - at) / 1000)} ago)` : '';
  requests.push(lc
    ? `Last compaction: ${[typeof lc['at'] === 'string' ? `${one(lc['at'])}${ago}` : '', tokens(lc)].filter(Boolean).join(' — ') || 'unknown'}${isNum(lc['trigger']) ? ` (trigger ${lc['trigger']})` : ''}`
    : 'Last compaction: none since startup');
  groups.push(requests);
  const st = isRec(s['stats']) ? s['stats'] : {};
  const stats = [['dropped', 'dropped'], ['write_failures', 'write failures']].flatMap(([k, label]) => (isNum(st[k!]) && st[k!] !== 0 ? [`${label} ${st[k!]}`] : []));
  if (stats.length) groups.push([`Stats writer: ${stats.join('; ')}`]);
  const recent = Array.isArray(s['recent_requests']) ? s['recent_requests'].filter(isRec) : [];
  groups.push([
    `Recent requests: ${recent.length}/64 (in memory; reset on restart)`,
    ...recent.slice(-5).map((r) => {
      const model = typeof r['model'] === 'string' ? `model=${JSON.stringify(one(r['model']))}` : r['model'] === null ? 'model=null' : '';
      const head = [typeof r['action'] === 'string' ? one(r['action']) : '', tokens(isRec(r['tokens']) ? r['tokens'] : {})].filter(Boolean).join(' ');
      return `  ${[head, model, isNum(r['ms']) ? `${r['ms']}ms` : ''].filter(Boolean).join('; ') || '?'}`;
    }),
  ]);
  return groups.map((g) => g.join('\n')).join('\n\n');
}
