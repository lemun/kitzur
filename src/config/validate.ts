// Config validation (DESIGN.md, §10): the type and range of every leaf (spec.ts), regex and glob
// compilation, the  trigger/target rules, the  budget-mode conflict, an unusable budget, and the
// startup warnings ( clamp unreachable,  one snapshot per epoch,  T_plan below the client's
// output, a window that does not match its preset). Pure; file checks are opt-in (`checkFiles`).
import { existsSync, statSync } from 'node:fs';
import type { ErrorRule } from '../types.js';
import type { Config } from './schema.js';
import { budgetModeConflict, clampRange, computeBudget, planMaxTokens, snapshotRoom } from './derived.js';
import { PRESET_TABLE } from './presets.js';
import { DEFAULT_LEAVES, describeSpec, getPath, isPlainObject, LEAF_SPECS, type LeafSpec } from './spec.js';
import type { Provenance } from './load.js';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export interface ValidateOptions {
  /** per-leaf sources (loadConfig); used in messages and in the preset-mismatch warning */
  provenance?: Provenance;
  /** check that configured files exist (tokenizer.path, upstream.caFile) */
  checkFiles?: boolean;
}

const ERROR_KINDS = new Set(['overflow_prompt', 'overflow_total', 'overflow_unknown', 'max_tokens_too_large', 'payload_too_large', 'gateway_error', 'overflow_suspect']);
const NUMBER_GROUPS = new Set(['window', 'prompt', 'completion', 'total', 'maxInput', 'chars', 'atLeast']);
const RULE_KEYS = new Set(['id', 'server', 'status', 'match', 'flags', 'json', 'kind', 'on', 'lowerBound', 'lowerBoundIf', 'note']);

/** Compiles a regex; returns an error message or null. */
export function regexError(source: string, flags = ''): string | null {
  try {
    new RegExp(source, flags);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Tool-name glob ('*' wildcard, everything else literal) as an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('.*') + '$');
}

function checkLeaf(path: string, spec: LeafSpec, v: unknown): string | null {
  // header values are credentials: never echo them
  const bad = (): string => `${path}: expected ${describeSpec(spec)}, got ${spec.t === 'headers' ? typeName(v) : JSON.stringify(v)}`;
  if (v === null) return 'nullable' in spec && spec.nullable ? null : bad();
  switch (spec.t) {
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || (spec.max !== undefined && v > spec.max)) return bad();
      return null;
    case 'num': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad();
      const lo = spec.minExclusive ? v <= spec.min : v < spec.min;
      const hi = spec.max === undefined ? false : spec.maxExclusive ? v >= spec.max : v > spec.max;
      return lo || hi ? bad() : null;
    }
    case 'bool':
      return typeof v === 'boolean' ? null : bad();
    case 'false':
      return v === false ? null : `${path}: must be false (the digest hook is documented but not implemented in v1)`;
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v) ? null : bad();
    case 'str': {
      if (typeof v !== 'string') return bad();
      if (spec.nonEmpty && v.trim() === '') return bad();
      if (spec.format === 'origin') {
        let u: URL;
        try {
          u = new URL(v);
        } catch {
          return `${path}: not a URL: ${JSON.stringify(v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1<credentials>@'))} (expected scheme://host[:port])`;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${path}: scheme must be http or https, got ${u.protocol}`;
        if (u.username || u.password) {
          // never echo the value: it holds a credential
          return `${path}: credentials in the URL (user:password@) are not supported; send them as a header in upstream.headers (for example Authorization), whose values are never shown or logged`;
        }
        if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
          return `${path}: must be an origin only (scheme://host[:port]); the client's request path is appended unchanged, so put the gateway path (e.g. ${u.pathname}) in the client's baseURL`;
        }
        return null;
      }
      if (spec.format === 'urlpath') return v.startsWith('/') ? null : bad();
      if (spec.format === 'regex') {
        const e = regexError(v, spec.flags ?? '');
        return e === null ? null : `${path}: invalid regex: ${e}`;
      }
      return null;
    }
    case 'strs': {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return bad();
      if (spec.format !== 'any' && v.some((x: string) => x.trim() === '')) return `${path}: empty string in the list`;
      return null;
    }
    case 'headers': {
      if (!isPlainObject(v)) return bad();
      for (const [k, x] of Object.entries(v)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) return `${path}: invalid header name ${JSON.stringify(k)}`;
        if (typeof x !== 'string' || /[\r\n]/.test(x)) return `${path}.${k}: header value must be a single-line string`;
      }
      return null;
    }
    case 'errorRules':
    case 'exclusions':
      return Array.isArray(v) ? null : bad();
  }
}

/** The JSON type of a value, for messages that must not print it. */
function typeName(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

/**
 * RegExp flags of an error rule or exclusion: valid flags, and not 'g'/'y', which make exec()/test()
 * stateful (lastIndex), so the proxy's shared classifier would miss every other matching body.
 */
function flagsError(flags: unknown): string | null {
  if (flags === undefined) return null;
  if (typeof flags !== 'string' || !/^[dimsuv]*$/.test(flags)) {
    return typeof flags === 'string' && /[gy]/.test(flags)
      ? "'g' and 'y' are not allowed (they make matching stateful)"
      : 'invalid RegExp flags';
  }
  return null;
}

/** Validates one ErrorRule (errors.custom[i]); returns problems. */
export function checkErrorRule(r: unknown, where: string): string[] {
  const out: string[] = [];
  if (!isPlainObject(r)) return [`${where}: an error rule must be an object`];
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) out.push(`${where}: unknown key '${k}' (allowed: ${[...RULE_KEYS].join(', ')})`);
  if (typeof r['id'] !== 'string' || !r['id']) out.push(`${where}.id: a non-empty string is required`);
  if (typeof r['server'] !== 'string') out.push(`${where}.server: a string label is required`);
  if (typeof r['match'] !== 'string') out.push(`${where}.match: a regex source string is required ('' matches any body)`);
  const fe = flagsError(r['flags']);
  if (fe) out.push(`${where}.flags: ${fe}`);
  if (typeof r['match'] === 'string') {
    const e = regexError(r['match'], typeof r['flags'] === 'string' ? r['flags'] : '');
    if (e) out.push(`${where}.match: invalid regex: ${e}`);
    else {
      for (const m of r['match'].matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)) {
        if (!NUMBER_GROUPS.has(m[1]!)) out.push(`${where}.match: unknown named group '${m[1]}' (known: ${[...NUMBER_GROUPS].join(', ')})`);
      }
    }
  }
  if (typeof r['kind'] !== 'string' || !ERROR_KINDS.has(r['kind'])) out.push(`${where}.kind: one of ${[...ERROR_KINDS].join(', ')}`);
  if (r['status'] !== undefined) {
    const s = r['status'];
    if (!Array.isArray(s) || !s.every((x) => x === null || (Number.isInteger(x) && (x as number) >= 100 && (x as number) <= 599))) {
      out.push(`${where}.status: an array of HTTP statuses (100-599) and/or null (in-stream error)`);
    }
  }
  if (r['on'] !== undefined && r['on'] !== 'body' && r['on'] !== 'message') out.push(`${where}.on: 'body' or 'message'`);
  if (r['json'] !== undefined) {
    if (!isPlainObject(r['json']) || !Object.entries(r['json']).every(([k, p]) => NUMBER_GROUPS.has(k) && typeof p === 'string')) {
      out.push(`${where}.json: an object {${[...NUMBER_GROUPS].join('|')}: 'dotted.path'}`);
    }
  }
  if (r['lowerBound'] !== undefined && typeof r['lowerBound'] !== 'boolean') out.push(`${where}.lowerBound: true or false`);
  if (r['lowerBoundIf'] !== undefined && (typeof r['lowerBoundIf'] !== 'string' || !NUMBER_GROUPS.has(r['lowerBoundIf']))) {
    out.push(`${where}.lowerBoundIf: the name of a named group`);
  }
  if (r['note'] !== undefined && typeof r['note'] !== 'string') out.push(`${where}.note: a string`);
  return out;
}

/** The value's source, for messages: " (file:/x.json)" or '' for defaults. */
function src(prov: Provenance | undefined, path: string): string {
  const s = prov?.[path];
  return s && s !== 'default' ? ` (${s})` : '';
}

/**
 * Validates a loaded config. `errors` make the config unusable (serve refuses to start); `warnings` are
 * printed at startup and by `config validate`.
 */
export function validateConfig(cfg: Config, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prov = opts.provenance;

  // ---- every leaf: type and range
  let typesOk = true;
  for (const path of DEFAULT_LEAVES) {
    const spec = LEAF_SPECS[path]!;
    const e = checkLeaf(path, spec, getPath(cfg, path));
    if (e) {
      errors.push(e + src(prov, path));
      typesOk = false;
    }
  }

  // ---- structured leaves
  if (Array.isArray(cfg.errors?.custom)) {
    const ids = new Set<string>();
    cfg.errors.custom.forEach((r: ErrorRule, i: number) => {
      errors.push(...checkErrorRule(r, `errors.custom[${i}]`).map((m) => m + src(prov, 'errors.custom')));
      if (isPlainObject(r) && typeof r.id === 'string') {
        if (ids.has(r.id)) errors.push(`errors.custom[${i}].id: duplicate id '${r.id}'`);
        ids.add(r.id);
      }
    });
  }
  if (Array.isArray(cfg.errors?.exclusions)) {
    cfg.errors.exclusions.forEach((x: unknown, i: number) => {
      const w = `errors.exclusions[${i}]`;
      if (!isPlainObject(x) || typeof x['id'] !== 'string' || typeof x['match'] !== 'string') {
        errors.push(`${w}: expected {id, match, flags?}`);
        return;
      }
      for (const k of Object.keys(x)) if (!['id', 'match', 'flags'].includes(k)) errors.push(`${w}: unknown key '${k}'`);
      const fe = flagsError(x['flags']);
      if (fe) {
        errors.push(`${w}.flags: ${fe}`);
        return;
      }
      const e = regexError(x['match'], typeof x['flags'] === 'string' ? x['flags'] : '');
      if (e) errors.push(`${w}.match: invalid regex: ${e}`);
    });
  }
  if (!typesOk) return { errors, warnings };

  // ---- globs and tags
  for (const [role, list] of Object.entries(cfg.rules.toolNames)) {
    for (const g of list) {
      if (g === '*') warnings.push(`rules.toolNames.${role}: the glob '*' matches every tool`);
      else if (/\s/.test(g)) warnings.push(`rules.toolNames.${role}: glob ${JSON.stringify(g)} contains whitespace; tool names never do`);
      globToRegExp(g); // always compiles; kept as the reference translation
    }
  }

  // ---- : trigger / target
  const c = cfg.compaction;
  if (c.triggerTokens !== null && c.targetTokens !== null && c.targetTokens >= c.triggerTokens) {
    errors.push(`compaction.targetTokens (${c.targetTokens}) must be below compaction.triggerTokens (${c.triggerTokens})${src(prov, 'compaction.targetTokens')}`);
  }
  if (c.summaryMaxFraction < c.summaryFraction) {
    warnings.push(`compaction.summaryMaxFraction (${c.summaryMaxFraction}) is below compaction.summaryFraction (${c.summaryFraction}): the cap wins`);
  }

  // ---- : budget mode conflict
  const conflict = budgetModeConflict(cfg);
  if (conflict) errors.push(conflict);

  // ---- the budget itself
  const b = computeBudget(cfg);
  const tPlan = planMaxTokens(cfg);
  if (b.budget <= 0) {
    errors.push(
      `no room for the prompt: budget = window ${b.window} − T_plan ${tPlan} − margin ${b.margin} = ${b.budget}. ` +
        `Lower budget.defaultMaxTokens/planMaxTokens or use the matching preset (e.g. --preset ${nearestPreset(b.window)})`,
    );
  } else if (b.hard <= 1) {
    errors.push(
      `no room below the client's compaction point: clientPoint ${b.clientPoint} − allowance ${b.allowance} = ${b.clientPoint - b.allowance}. ` +
        `Check client.compactionPointTokens / client.outputAllowanceTokens`,
    );
  } else if (b.target < 1) {
    errors.push(`compaction target is ${b.target}: raise compaction.targetFraction or compaction.targetTokens`);
  }
  if (b.budget > 0 && b.budget < b.window / 4) {
    warnings.push(
      `budget ${b.budget} is under a quarter of the window ${b.window}: T_plan ${tPlan} reserves most of it for the reply, ` +
        `so most requests will be compacted hard or refused. Set budget.planMaxTokens (the presets reserve 8,000 at 32k)`,
    );
  }
  if (c.triggerTokens !== null && b.hard > 0 && c.triggerTokens > b.hard) {
    warnings.push(`compaction.triggerTokens ${c.triggerTokens} is above hard ${b.hard}; it is clamped to ${b.hard} ()`);
  }
  if (c.targetTokens !== null && b.trigger > 0 && c.targetTokens >= b.trigger) {
    warnings.push(`compaction.targetTokens ${c.targetTokens} is not below trigger ${b.trigger}; it is clamped to ${b.trigger - 1} ()`);
  }

  // ---- startup warnings (DESIGN §10)
  if (cfg.budget.maxTokensClamp.enabled && b.budget > 0) {
    const r = clampRange(cfg, b);
    if (!r.reachable) warnings.push(`clamp enabled but unreachable: ${r.reason} (; it needs a client point above budget + allowance, see CONFIG.md "Client setup")`);
  }
  if (cfg.client.outputLimit !== null && tPlan < cfg.client.outputLimit) {
    warnings.push(`T_plan ${tPlan} (budget.planMaxTokens ?? defaultMaxTokens) is below the client's output limit ${cfg.client.outputLimit}: long replies get max_tokens fitted down ()`);
  }
  const head = cfg.budget.observedFixedPromptTokens;
  if (head !== null && b.budget > 0) {
    const snap = cfg.rules.snapshot.p90Tokens ?? Math.floor(cfg.client.toolOutputMaxBytes / cfg.tokenizer.fallback.charsPerToken.snapshot);
    const r = snapshotRoom(b, head, snap);
    if (r.warn) {
      warnings.push(
        `at most one snapshot fits per compaction epoch: trigger ${b.trigger} − (head ${head} + summary ${b.summaryBudget}) = ${r.room} < snapshot ${snap}` +
          `${cfg.rules.snapshot.p90Tokens === null ? ' (estimated from client.toolOutputMaxBytes)' : ''} ()`,
      );
    }
    if (head >= b.headRoom) {
      warnings.push(`the fixed prompt (${head}) exceeds the head room ${b.headRoom}: the first user message will be truncated (oversize.headPolicy ${cfg.oversize.headPolicy})`);
    }
  }
  warnings.push(...presetMismatch(cfg, prov));

  // ---- operational warnings
  if (cfg.upstream.origin === null) warnings.push('upstream.origin is not set: serve refuses to start without it');
  if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.listen.host)) {
    warnings.push(`listen.host ${cfg.listen.host} is not loopback: the proxy forwards credentials; keep it on 127.0.0.1 unless you know why`);
  }
  if (cfg.listen.allowedHosts.includes('*')) warnings.push("listen.allowedHosts ['*'] disables the DNS-rebinding guard");
  else if (cfg.listen.allowedHosts.length === 0) warnings.push('listen.allowedHosts is empty: every request with a Host header is refused');
  if (cfg.upstream.insecureTls) warnings.push('upstream.insecureTls is on: the gateway certificate is not verified');
  if (!cfg.compaction.enabled) warnings.push('compaction.enabled is false: requests over the budget get the documented error instead of a compaction');
  if (cfg.tokenizer.mode === 'auto' && cfg.tokenizer.path === null) {
    warnings.push('tokenizer.path is not set: counting uses the per-class estimate (set it to the model\'s tokenizer.json for exact counts)');
  }
  if (cfg.tokenizer.endpoint.style !== null && cfg.upstream.origin === null) {
    warnings.push('tokenizer.endpoint.style is set but upstream.origin is not: the tokenize endpoint is unused');
  }
  if (cfg.shadow) warnings.push('shadow mode: requests are forwarded unchanged (the engine only records what it would do)');
  if (cfg.ledger.mirrorPath !== null) warnings.push('ledger.mirrorPath is not implemented in v1: no facts file is written');

  if (opts.checkFiles) {
    const missing = (p: string | null): p is string => typeof p === 'string' && !(existsSync(p) && statSync(p).isFile());
    // a missing CA file would fail every TLS connection: fatal. A missing tokenizer falls back to the
    // estimate (tokenizer.mode 'auto', §4), so it is a warning.
    if (missing(cfg.upstream.caFile)) errors.push(`upstream.caFile: file not found: ${cfg.upstream.caFile}${src(prov, 'upstream.caFile')}`);
    if (cfg.tokenizer.mode === 'auto' && missing(cfg.tokenizer.path)) {
      warnings.push(`tokenizer.path: file not found: ${cfg.tokenizer.path}${src(prov, 'tokenizer.path')}; counting falls back to the estimate`);
    }
  }
  return { errors, warnings };
}

function nearestPreset(window: number): string {
  let best = '100k';
  let d = Infinity;
  for (const [name, p] of Object.entries(PRESET_TABLE)) {
    if (Math.abs(p.window - window) < d) {
      d = Math.abs(p.window - window);
      best = name;
    }
  }
  return best;
}

/**
 * Window/preset mismatch warnings: (a) a later layer overrode a preset's window or defaultMaxTokens;
 * (b) budget.window was set to a preset window while budget.defaultMaxTokens kept the built-in default
 * of another window (the classic KITZUR_WINDOW=32000 alone).
 */
function presetMismatch(cfg: Config, prov: Provenance | undefined): string[] {
  if (!prov) return [];
  const out: string[] = [];
  const presetSrc = Object.values(prov).find((s) => s.startsWith('preset:'));
  const presetName = presetSrc?.slice('preset:'.length);
  const table = presetName ? PRESET_TABLE[presetName] : undefined;
  if (table) {
    for (const k of ['window', 'defaultMaxTokens'] as const) {
      const s = prov[`budget.${k}`];
      if (s && s !== presetSrc && cfg.budget[k] !== table[k]) {
        out.push(`preset ${presetName} sets budget.${k}=${table[k]} but the effective value is ${cfg.budget[k]} (${s})`);
      }
    }
  }
  const wSrc = prov['budget.window'];
  if (wSrc && wSrc !== 'default' && !wSrc.startsWith('preset:') && prov['budget.defaultMaxTokens'] === 'default' && prov['budget.planMaxTokens'] === 'default') {
    const match = Object.entries(PRESET_TABLE).find(([, p]) => p.window === cfg.budget.window);
    if (match && match[1].defaultMaxTokens !== cfg.budget.defaultMaxTokens) {
      out.push(
        `budget.window=${cfg.budget.window} (${wSrc}) with the built-in budget.defaultMaxTokens ${cfg.budget.defaultMaxTokens}; ` +
          `preset ${match[0]} uses ${match[1].defaultMaxTokens}. Use --preset ${match[0]} or set budget.defaultMaxTokens`,
      );
    }
  }
  return out;
}
