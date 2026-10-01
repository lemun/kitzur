// Config loading (DESIGN.md): built-in defaults -> preset -> config file -> KITZUR_* env -> CLI
// (--set a.b=v and dedicated flags, in argv order). Objects merge key by key; arrays and other leaf
// values replace. Every leaf records the source that set it last (provenance), for `config show` and for
// validation messages. Loading only assembles values; types and ranges are checked by validate.ts.
//
// Paths in a config file (tokenizer.path, upstream.caFile, stateDir, ...) are relative to the file's
// directory; paths from env or CLI are relative to the working directory. A leading '~/' means $HOME.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_CONFIG, type Config } from './schema.js';
import { parseJsonc } from './jsonc.js';
import { loadPreset, presetsDir } from './presets.js';
import {
  DEFAULT_LEAVES, describeSpec, getPath, isInnerNode, isPlainObject, LEAF_SPECS, ownerLeaf, setPath, suggestLeaf, type LeafSpec,
} from './spec.js';

/** leaf path -> source label: 'default', 'preset:<name>', 'file:<path>', 'env:<VAR>', 'cli:--set', 'cli:--<flag>' */
export type Provenance = Record<string, string>;

/** Env vars mapped to one leaf each (applied in this order, before KITZUR_SET). */
export const ENV_MAP: ReadonlyArray<readonly [string, string]> = [
  ['KITZUR_UPSTREAM_ORIGIN', 'upstream.origin'],
  ['KITZUR_HOST', 'listen.host'],
  ['KITZUR_PORT', 'listen.port'],
  ['KITZUR_SERVER_TYPE', 'server.type'],
  ['KITZUR_WINDOW', 'budget.window'],
  ['KITZUR_MAX_TOKENS', 'budget.defaultMaxTokens'],
  ['KITZUR_TOKENIZER_PATH', 'tokenizer.path'],
  ['KITZUR_TEMPLATE', 'tokenizer.template.name'],
  ['KITZUR_STATE_DIR', 'stateDir'],
  ['KITZUR_STATS_PATH', 'stats.path'],
  ['KITZUR_CA_FILE', 'upstream.caFile'],
  ['KITZUR_LOG_LEVEL', 'logLevel'],
  ['KITZUR_SHADOW', 'shadow'],
];

/** Env vars read by the loader itself (not leaves). */
export const LOADER_ENV = ['KITZUR_CONFIG', 'KITZUR_PRESET', 'KITZUR_SET', 'KITZUR_PRESETS_DIR'] as const;

/** Leaves holding file-system paths (resolved relative to the layer's base directory). */
export const PATH_LEAVES: ReadonlySet<string> = new Set([
  'upstream.caFile', 'tokenizer.path', 'tokenizer.cachePath', 'stateDir', 'stats.path', 'ledger.mirrorPath',
]);

/** One CLI/env assignment: `raw` is parsed according to the leaf's spec. */
export interface SetOp {
  path: string;
  raw: string;
  source: string;
}

export interface LoadOptions {
  /** preset name ('32k') or file; overrides KITZUR_PRESET and the config file's "preset" key */
  preset?: string | null;
  /** config file (JSON with comments); overrides KITZUR_CONFIG */
  configPath?: string | null;
  /** an in-memory config-file object, used instead of configPath (source 'object'; paths relative to cwd) */
  object?: Record<string, unknown> | null;
  /** environment (default process.env) */
  env?: Record<string, string | undefined>;
  /** CLI assignments in argv order: "a.b=v" strings (source 'cli:--set') or SetOps */
  sets?: Array<string | SetOp>;
  /** base for relative paths from env/CLI (default process.cwd()) */
  cwd?: string;
  /** presets/ directory (default: presetsDir()) */
  presetsDir?: string | null;
}

export interface LoadedConfig {
  config: Config;
  provenance: Provenance;
  /** the preset applied, if any (name or path) */
  preset: string | null;
  /** absolute path of the config file, if any */
  configPath: string | null;
  /** layer sources in the order applied */
  layers: string[];
  /** non-fatal loader notes (e.g. an unknown KITZUR_* variable) */
  warnings: string[];
}

/** Invalid config input (syntax, unknown key, bad --set). `issues` lists every problem found. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.length === 1 ? issues[0]! : `${issues.length} config errors:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** A deep copy of DEFAULT_CONFIG (callers may mutate it). */
export function defaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

/** Parses "a.b=v" into a SetOp. Throws on a missing '='. */
export function parseSetArg(arg: string, source = 'cli:--set'): SetOp {
  const eq = arg.indexOf('=');
  // `upstream.headers.Authorization:Bearer …` (a typo for '='): the rest of the argument is a credential
  const shown = /^\s*upstream\.headers\b/i.test(arg) ? '"upstream.headers…" (value not shown)' : JSON.stringify(arg);
  if (eq <= 0) throw new ConfigError([`${source}: expected path=value, got ${shown}`]);
  return { path: arg.slice(0, eq).trim(), raw: arg.slice(eq + 1), source };
}

/** Splits KITZUR_SET "a.b=v;c.d=w" (';' inside a value is written '\;'). */
export function splitEnvSet(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\' && value[i + 1] === ';') {
      cur += ';';
      i++;
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Converts a CLI/env string to a value for the leaf spec: numbers (underscores allowed), booleans
 * (true/false/1/0/yes/no/on/off), 'null' for nullable leaves, arrays as JSON or comma-separated,
 * objects as JSON. A JSON-quoted string ("…") is always taken as a string. Throws a message on failure.
 */
export function parseRawValue(spec: LeafSpec, raw: string): unknown {
  const s = raw.trim();
  const nullable = 'nullable' in spec && spec.nullable === true;
  if (nullable && s === 'null') return null;
  const json = (): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      // header values are credentials: never echo them
      throw new Error(`expected ${describeSpec(spec)} as JSON, got ${spec.t === 'headers' ? 'invalid JSON' : JSON.stringify(raw)}`);
    }
  };
  switch (spec.t) {
    case 'int':
    case 'num': {
      const x = Number(s.replace(/_/g, ''));
      if (s === '' || !Number.isFinite(x)) throw new Error(`expected ${describeSpec(spec)}, got ${JSON.stringify(raw)}`);
      return x;
    }
    case 'bool':
    case 'false': {
      const l = s.toLowerCase();
      if (TRUE.has(l)) return true;
      if (FALSE.has(l)) return false;
      throw new Error(`expected ${describeSpec(spec)}, got ${JSON.stringify(raw)}`);
    }
    case 'str':
    case 'enum':
      return s.startsWith('"') ? json() : raw;
    case 'strs':
      if (s.startsWith('[')) return json();
      return s === '' ? [] : s.split(',').map((x) => x.trim());
    case 'headers':
    case 'errorRules':
    case 'exclusions':
      return json();
  }
}

function expandPath(p: unknown, base: string): unknown {
  if (typeof p !== 'string' || p === '') return p;
  if (p === '~' || p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Applies one assignment to `cfg`, recording provenance. Throws a message on an unknown path or bad value. */
function applySet(cfg: Record<string, unknown>, prov: Provenance, op: SetOp, base: string): void {
  const owner = ownerLeaf(op.path);
  if (owner === null) {
    const hint = suggestLeaf(op.path);
    throw new Error(
      isInnerNode(op.path)
        ? `${op.source}: ${op.path} is a section; set one of its keys (e.g. ${DEFAULT_LEAVES.find((l) => l.startsWith(op.path + '.'))})`
        : `${op.source}: unknown config key ${op.path}${hint ? ` (did you mean ${hint}?)` : ''}`,
    );
  }
  const spec = LEAF_SPECS[owner]!;
  let value: unknown;
  if (owner !== op.path) {
    // a key inside a headers record: upstream.headers.X-Api-Key=v
    value = op.raw;
    const rec = getPath(cfg, owner);
    const next = isPlainObject(rec) ? { ...rec } : {};
    next[op.path.slice(owner.length + 1)] = value;
    setPath(cfg, owner, next);
  } else {
    try {
      value = parseRawValue(spec, op.raw);
    } catch (e) {
      throw new Error(`${op.source}: ${op.path}: ${(e as Error).message}`);
    }
    if (spec.t === 'headers' && isPlainObject(value)) {
      const rec = getPath(cfg, owner);
      value = { ...(isPlainObject(rec) ? rec : {}), ...value };
    }
    setPath(cfg, owner, PATH_LEAVES.has(owner) ? expandPath(value, base) : value);
  }
  prov[owner] = op.source;
}

/**
 * Merges a JSON layer (preset or config file) into `cfg`. Keys starting with '$' ($schema, $comment) are
 * ignored at any level. Unknown keys are collected in `issues`.
 */
function applyLayer(
  cfg: Record<string, unknown>, prov: Provenance, layer: Record<string, unknown>, source: string, base: string,
  issues: string[], prefix = '',
): void {
  for (const [k, v] of Object.entries(layer)) {
    if (k.startsWith('$')) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const spec = LEAF_SPECS[path];
    if (spec) {
      let value: unknown = structuredClone(v);
      if (spec.t === 'headers' && isPlainObject(value)) {
        const rec = getPath(cfg, path);
        value = { ...(isPlainObject(rec) ? rec : {}), ...value };
      }
      setPath(cfg, path, PATH_LEAVES.has(path) ? expandPath(value, base) : value);
      prov[path] = source;
    } else if (isInnerNode(path)) {
      if (!isPlainObject(v)) issues.push(`${source}: ${path} must be an object, got ${JSON.stringify(v)}`);
      else applyLayer(cfg, prov, v, source, base, issues, path);
    } else {
      const hint = suggestLeaf(path);
      issues.push(`${source}: unknown config key ${path}${hint ? ` (did you mean ${hint}?)` : ''}`);
    }
  }
}

/**
 * Loads the effective config. Throws ConfigError for unreadable/invalid files, unknown keys and bad
 * --set/env values; the result still needs validateConfig (types, ranges, cross-field rules).
 */
export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const cfg = defaultConfig() as unknown as Record<string, unknown>;
  const prov: Provenance = Object.fromEntries(DEFAULT_LEAVES.map((l) => [l, 'default']));
  const issues: string[] = [];
  const warnings: string[] = [];
  const layers = ['default'];

  // ---- config file (read first: it may name a preset)
  const cfgPathRaw = opts.object ? null : opts.configPath ?? (env['KITZUR_CONFIG'] || null);
  let configPath: string | null = null;
  let fileLayer: Record<string, unknown> | null = null;
  let filePreset: string | null = null;
  let fileSource = '';
  let fileBase = cwd;
  if (opts.object) {
    fileLayer = { ...opts.object };
    fileSource = 'object';
  } else if (cfgPathRaw) {
    configPath = resolve(cwd, cfgPathRaw);
    if (!existsSync(configPath)) throw new ConfigError([`config file not found: ${configPath}`]);
    let parsed: unknown;
    try {
      parsed = parseJsonc(readFileSync(configPath, 'utf8'), configPath);
    } catch (e) {
      throw new ConfigError([(e as Error).message]);
    }
    if (!isPlainObject(parsed)) throw new ConfigError([`${configPath}: the config must be a JSON object`]);
    fileLayer = { ...parsed };
    fileSource = `file:${configPath}`;
    fileBase = dirname(configPath);
  }
  if (fileLayer && 'preset' in fileLayer) {
    const p = fileLayer['preset'];
    if (p !== null && typeof p !== 'string') issues.push(`${fileSource}: "preset" must be a preset name or null`);
    else filePreset = p;
    delete fileLayer['preset'];
  }

  // ---- preset
  const presetName = opts.preset ?? (env['KITZUR_PRESET'] || null) ?? filePreset;
  if (presetName) {
    try {
      const p = loadPreset(presetName, opts.presetsDir === undefined ? presetsDir(env) : opts.presetsDir, cwd);
      const src = `preset:${presetName}`;
      applyLayer(cfg, prov, p.layer, src, dirname(p.file), issues);
      layers.push(src);
    } catch (e) {
      issues.push((e as Error).message);
    }
  }

  // ---- file
  if (fileLayer) {
    applyLayer(cfg, prov, fileLayer, fileSource, fileBase, issues);
    layers.push(fileSource);
  }

  // ---- env
  const envOps: SetOp[] = [];
  for (const [name, path] of ENV_MAP) {
    const v = env[name];
    if (v !== undefined && v !== '') envOps.push({ path, raw: v, source: `env:${name}` });
  }
  const envSet = env['KITZUR_SET'];
  if (envSet) {
    splitEnvSet(envSet).forEach((item, k) => {
      if (item.indexOf('=') <= 0) {
        // most likely the rest of a value cut at an unescaped ';' (`upstream.headers.Authorization=Bearer a;b`):
        // never echo it, it can be part of a credential
        issues.push(`env:KITZUR_SET: assignment ${k + 1} has no path=value form (its text is not shown); write a ';' inside a value as '\\;'`);
        return;
      }
      envOps.push(parseSetArg(item, 'env:KITZUR_SET'));
    });
  }
  const known = new Set<string>([...ENV_MAP.map(([n]) => n), ...LOADER_ENV]);
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith('KITZUR_') && !known.has(name) && !/^KITZUR_(TEST|BENCH)_/.test(name)) {
      warnings.push(`unknown environment variable ${name} ignored (see CONFIG.md "Environment")`);
    }
  }
  for (const op of envOps) {
    try {
      applySet(cfg, prov, op, cwd);
      if (!layers.includes(op.source)) layers.push(op.source);
    } catch (e) {
      issues.push((e as Error).message);
    }
  }

  // ---- CLI
  for (const s of opts.sets ?? []) {
    try {
      const op = typeof s === 'string' ? parseSetArg(s) : s;
      applySet(cfg, prov, op, cwd);
      if (!layers.includes(op.source)) layers.push(op.source);
    } catch (e) {
      issues.push(e instanceof ConfigError ? e.issues.join('; ') : (e as Error).message);
    }
  }

  if (issues.length) throw new ConfigError(issues);
  return { config: cfg as unknown as Config, provenance: prov, preset: presetName, configPath, layers, warnings };
}
