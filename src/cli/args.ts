import { loadConfig, parseSetArg, type LoadedConfig, type SetOp } from '../config/load.js';
import { defaultConfigPath } from '../config/paths.js';
import { UsageError, type CliIO } from './io.js';

// ---------------------------------------------------------------- argument parsing

export interface OptDef {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
  /** shortcut for a config leaf: the value becomes a --set of this path */
  set?: string;
}
export type OptSpec = Record<string, OptDef>;

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** options in argv order (config assignments are applied in this order) */
  ordered: Array<{ name: string; value: string | boolean }>;
}

/** Parses `--name value`, `--name=value`, `-s value`, boolean `--flag`, and `--` (end of options). */
export function parseArgs(argv: readonly string[], spec: OptSpec): ParsedArgs {
  const values: ParsedArgs['values'] = {};
  const positionals: string[] = [];
  const ordered: ParsedArgs['ordered'] = [];
  const byShort = new Map(Object.entries(spec).filter(([, d]) => d.short).map(([n, d]) => [d.short!, n]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : undefined;
    } else if (a.length === 2 && a[0] === '-' && a[1] !== '-') {
      name = byShort.get(a[1]!);
      if (!name) throw new UsageError(`unknown option ${a}`);
    } else {
      positionals.push(a);
      continue;
    }
    const def = spec[name];
    if (!def) throw new UsageError(`unknown option --${name}`);
    let value: string | boolean;
    if (def.type === 'boolean') {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      value = true;
    } else {
      if (inline !== undefined) value = inline;
      else if (i + 1 < argv.length) value = argv[++i]!;
      else throw new UsageError(`--${name} needs a value`);
    }
    ordered.push({ name, value });
    if (def.multiple) values[name] = [...((values[name] as string[] | undefined) ?? []), String(value)];
    else values[name] = value;
  }
  return { values, positionals, ordered };
}

/** Options every config-reading command accepts. */
export const CONFIG_OPTS: OptSpec = {
  config: { type: 'string', short: 'c' },
  preset: { type: 'string', short: 'p' },
  set: { type: 'string', multiple: true, short: 's' },
  upstream: { type: 'string', set: 'upstream.origin' },
  host: { type: 'string', set: 'listen.host' },
  port: { type: 'string', set: 'listen.port' },
  tokenizer: { type: 'string', set: 'tokenizer.path' },
  template: { type: 'string', set: 'tokenizer.template.name' },
  'state-dir': { type: 'string', set: 'stateDir' },
  stats: { type: 'string', set: 'stats.path' },
  'log-file': { type: 'string', set: 'log.file' },
  foreground: { type: 'boolean', set: 'log.console' },
  'log-level': { type: 'string', set: 'logLevel' },
  shadow: { type: 'boolean', set: 'shadow' },
};

/** The config assignments of a parsed command line, in argv order. */
export function setOpsOf(p: ParsedArgs, spec: OptSpec = CONFIG_OPTS): SetOp[] {
  const ops: SetOp[] = [];
  for (const { name, value } of p.ordered) {
    if (name === 'set') ops.push(parseSetArg(String(value)));
    else if (spec[name]?.set) ops.push({ path: spec[name]!.set!, raw: String(value), source: `cli:--${name}` });
  }
  return ops;
}

export function loadFromArgs(p: ParsedArgs, io: CliIO): LoadedConfig {
  return loadConfig({
    preset: (p.values['preset'] as string | undefined) ?? null,
    configPath: (p.values['config'] as string | undefined) ?? (io.env['KITZUR_CONFIG'] ? null : defaultConfigPath(io.env)),
    env: io.env,
    cwd: io.cwd,
    sets: setOpsOf(p),
  });
}
