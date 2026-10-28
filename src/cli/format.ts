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
