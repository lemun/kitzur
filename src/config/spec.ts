// The config's leaves: one spec per leaf of DEFAULT_CONFIG (type, nullability, range, enum). It is the
// single table behind `--set`/env parsing (load.ts), per-leaf validation (validate.ts) and provenance.
// test/config/validate.test.ts asserts that the table and DEFAULT_CONFIG have exactly the same leaves, and
// test/config/config-md.test.ts that CONFIG.md documents each, so a schema change without a spec (and a
// CONFIG.md entry) fails the build's tests.
import { DEFAULT_CONFIG } from './schema.js';

export type LeafSpec =
  | { t: 'int'; min: number; max?: number; nullable?: boolean }
  | { t: 'num'; min: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean; nullable?: boolean }
  | { t: 'bool'; nullable?: boolean }
  | { t: 'str'; nullable?: boolean; nonEmpty?: boolean; format?: 'origin' | 'urlpath' | 'regex'; /** format 'regex': the flags its consumer compiles it with */ flags?: string }
  | { t: 'enum'; values: readonly string[]; nullable?: boolean }
  | { t: 'strs'; format?: 'glob' | 'nonEmpty' | 'any' }
  | { t: 'headers' }
  | { t: 'errorRules' }
  | { t: 'exclusions' }
  | { t: 'false' };

const int = (min: number, max?: number): LeafSpec => (max === undefined ? { t: 'int', min } : { t: 'int', min, max });
const intN = (min: number, max?: number): LeafSpec =>
  max === undefined ? { t: 'int', min, nullable: true } : { t: 'int', min, max, nullable: true };
const num = (min: number, max: number, o: { minExclusive?: boolean; maxExclusive?: boolean } = {}): LeafSpec => ({ t: 'num', min, max, ...o });
const bool: LeafSpec = { t: 'bool' };
const boolN: LeafSpec = { t: 'bool', nullable: true };
const str: LeafSpec = { t: 'str', nonEmpty: true };
const strN: LeafSpec = { t: 'str', nullable: true, nonEmpty: true };
/** A JS regex source, validated with the flags the engine compiles it with (u-mode syntax is stricter). */
const regex = (flags: string): LeafSpec => ({ t: 'str', format: 'regex', flags });
const en = (...values: string[]): LeafSpec => ({ t: 'enum', values });
const enN = (...values: string[]): LeafSpec => ({ t: 'enum', values, nullable: true });
const strs: LeafSpec = { t: 'strs', format: 'nonEmpty' };
const globs: LeafSpec = { t: 'strs', format: 'glob' };
const MAX_TOKENS = 10_000_000;
const MAX_MS = 24 * 3600 * 1000;

/**
 * Every leaf path of the config, in DEFAULT_CONFIG order. A null-prototype object, so that a key such as
 * `toString`, `constructor` or `__proto__` is not a spec (it is an unknown config key).
 */
export const LEAF_SPECS: Readonly<Record<string, LeafSpec>> = Object.assign(Object.create(null) as Record<string, LeafSpec>, {
  'listen.host': str,
  'listen.port': int(0, 65535),
  'listen.allowedHosts': strs,

  'upstream.origin': { t: 'str', nullable: true, format: 'origin' },
  'upstream.timeoutMs': int(1, MAX_MS),
  'upstream.idleTimeoutMs': int(1, MAX_MS),
  'upstream.caFile': strN,
  'upstream.insecureTls': bool,
  'upstream.headers': { t: 'headers' },
  'upstream.maxBodyBytes': intN(1024),
  'upstream.keepAliveIdleMs': int(0, MAX_MS),

  'server.type': en('vllm', 'sglang', 'llamacpp', 'tgi', 'ollama', 'lmstudio', 'litellm', 'unknown'),
  'server.budgetMode': enN('strict_total', 'prompt_only', 'tgi', 'silent_truncate'),

  'budget.window': int(256, MAX_TOKENS),
  'budget.limitCountsMaxTokens': boolN,
  'budget.defaultMaxTokens': int(1, MAX_TOKENS),
  'budget.planMaxTokens': intN(1, MAX_TOKENS),
  'budget.safetyMarginTokens': int(0, MAX_TOKENS),
  'budget.safetyMarginFraction': num(0, 0.5, { maxExclusive: true }),
  'budget.maxTokensClamp.enabled': bool,
  'budget.maxTokensClamp.floorTokens': int(1, MAX_TOKENS),
  'budget.maxTokensRestore.enabled': bool,
  'budget.maxTokensRestore.toTokens': intN(1, MAX_TOKENS),
  'budget.observedFixedPromptTokens': intN(0, MAX_TOKENS),

  'client.compactionPointTokens': intN(1, MAX_TOKENS),
  'client.outputLimit': intN(1, MAX_TOKENS),
  'client.outputTokenMax': int(1, MAX_TOKENS),
  'client.outputAllowanceTokens': intN(0, MAX_TOKENS),
  'client.toolOutputMaxBytes': int(1),
  'client.summaryMarkers': strs,
  'client.compactionMarkers': strs,
  'client.boilerplateUserTexts': strs,

  'compaction.enabled': bool,
  'compaction.triggerTokens': intN(1, MAX_TOKENS),
  'compaction.targetTokens': intN(1, MAX_TOKENS),
  'compaction.triggerFraction': num(0, 1, { minExclusive: true }),
  'compaction.targetFraction': num(0, 1, { minExclusive: true, maxExclusive: true }),
  'compaction.keepRecent': int(1, 1000),
  'compaction.summaryRole': en('user', 'merge-into-first-user'),
  'compaction.summaryFraction': num(0, 1, { maxExclusive: true }),
  'compaction.summaryMaxFraction': num(0, 1, { maxExclusive: true }),
  'compaction.narrativeMaxCharsPerMessage': int(0),
  'compaction.userMaxChars': int(16),

  'oversize.enabled': bool,
  'oversize.headShare': num(0, 1),
  'oversize.headPolicy': en('truncate', 'error'),
  'oversize.admission': bool,
  'oversize.admitTokens': intN(1, MAX_TOKENS),
  'oversize.minTailTokens': intN(0, MAX_TOKENS),

  'reasoning.summary': en('drop', 'cap', 'keep'),
  'reasoning.summaryCapChars': int(0),
  'reasoning.tail': en('keep', 'drop'),
  'reasoning.field': strN,
  'reasoning.serverEmits': boolN,
  'reasoning.sentBackByClient': boolN,

  'ledger.enabled': bool,
  'ledger.tags.decision': strs,
  'ledger.tags.todo': strs,
  'ledger.tags.blocked': strs,
  'ledger.tags.note': strs,
  'ledger.labelPattern': regex('g'), // src/engine/ledger/extract.ts
  'ledger.pathArgKeys': strs,
  'ledger.correctionCues': regex('iu'), // src/engine/ledger/supersede.ts
  'ledger.correctionMinOverlap': num(0, 1, { minExclusive: true }),
  'ledger.additiveCues': regex('iu'),
  'ledger.stopWords': strs,
  'ledger.outputPaths.enabled': bool,
  'ledger.outputPaths.maxPerResult': int(0, 1000),
  'ledger.outputPaths.maxTotal': int(0, 10_000),
  'ledger.mirrorPath': strN,

  'rules.toolNames.snapshot': globs,
  'rules.toolNames.browserNavigate': globs,
  'rules.toolNames.todo': globs,
  'rules.toolNames.read': globs,
  'rules.toolNames.edit': globs,
  'rules.toolNames.write': globs,
  'rules.toolNames.shell': globs,
  'rules.mcpServers': strs,
  'rules.snapshot.stub': en('boundary', 'eager', 'off'),
  'rules.snapshot.slim': bool,
  'rules.snapshot.interactiveRoles': strs,
  'rules.snapshot.p90Tokens': intN(1, MAX_TOKENS),
  'rules.test.commands': regex('i'), // src/engine/rules/testrun.ts
  'rules.test.maxFailureLines': int(0, 10_000),
  'rules.excerpt.headChars': int(0),
  'rules.excerpt.tailChars': int(0),
  'rules.excerpt.shortVerbatimChars': int(0),

  'tokenizer.mode': en('auto', 'estimate'),
  'tokenizer.path': strN,
  'tokenizer.cachePath': strN,
  'tokenizer.template.name': en('sim', 'qwen3', 'chatml', 'generic'),
  'tokenizer.template.enableThinking': boolN,
  'tokenizer.template.preserveThinking': boolN,
  'tokenizer.endpoint.style': enN('vllm', 'sglang', 'llamacpp', 'tgi'),
  'tokenizer.endpoint.path': { t: 'str', nullable: true, format: 'urlpath' },
  'tokenizer.endpoint.timeoutMs': int(1, MAX_MS),
  'tokenizer.fallback.charsPerToken.prose': num(0.1, 100),
  'tokenizer.fallback.charsPerToken.code': num(0.1, 100),
  'tokenizer.fallback.charsPerToken.snapshot': num(0.1, 100),
  'tokenizer.fallback.charsPerToken.testOutput': num(0.1, 100),
  'tokenizer.fallback.charsPerToken.json': num(0.1, 100),
  'tokenizer.fallback.charsPerToken.snapshotNonLatin': num(0.1, 100),
  'tokenizer.fallback.safetyFactor': num(1, 10),
  'tokenizer.fallback.perMessageOverhead': int(0, 10_000),
  'tokenizer.imageTokens': int(0, MAX_TOKENS),
  'tokenizer.cacheEntries': int(16),

  'calibration.enabled': bool,
  'calibration.usageAvailable': boolN,
  'calibration.upwardOnly': bool,
  'calibration.minSamples': int(1, 64),
  'calibration.maxCorrection.exact': num(1, 2),
  'calibration.maxCorrection.estimate': num(1, 10),
  'calibration.minCountedTokens': int(0, MAX_TOKENS),

  'stream.injectIncludeUsage': bool,
  'stream.holdFirstEvent': bool,
  'stream.firstEventTimeoutMs': int(1, MAX_MS),

  'errors.useBuiltin': bool,
  'errors.custom': { t: 'errorRules' },
  'errors.exclusions': { t: 'exclusions' },
  'errors.inStream': bool,
  'errors.maxRetries': int(0, 10),
  'errors.nearBudgetFraction': num(0, 1, { minExclusive: true }),
  'errors.maxTightenFraction': num(0, 1, { maxExclusive: true }),
  'errors.translateForClient': bool,

  'cache.prefixCaching': en('on', 'off', 'unknown'),

  'store.persist': bool,
  'store.maxPlans': int(1),
  'store.maxBytes': int(1024),

  stateDir: strN,
  'stats.path': strN,
  shadow: bool,
  'digestHook.enabled': { t: 'false' },
  logLevel: en('error', 'warn', 'info', 'debug'),
} satisfies Record<string, LeafSpec>);

/** Plain (non-array, non-null) object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Leaf paths of a config-shaped object: arrays, primitives and empty objects are leaves; non-empty
 * plain objects are recursed into. On DEFAULT_CONFIG this is exactly the key set of LEAF_SPECS.
 */
export function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length > 0) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

/** Leaf paths of DEFAULT_CONFIG, in order. */
export const DEFAULT_LEAVES: readonly string[] = leafPaths(DEFAULT_CONFIG as unknown as Record<string, unknown>);

/** Value at a dotted path, or undefined. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Sets a dotted path, creating intermediate objects. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!isPlainObject(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/**
 * The spec leaf that owns `path`: the path itself, or its nearest ancestor that is a 'headers' leaf
 * (e.g. upstream.headers.Authorization -> upstream.headers). null when the path is not in the schema.
 */
export function ownerLeaf(path: string): string | null {
  if (LEAF_SPECS[path]) return path;
  const keys = path.split('.');
  for (let i = keys.length - 1; i > 0; i--) {
    const p = keys.slice(0, i).join('.');
    const s = LEAF_SPECS[p];
    if (s) return s.t === 'headers' ? p : null;
  }
  return null;
}

/** True when `path` is an inner (object) node of the schema, e.g. 'budget' or 'budget.maxTokensClamp'. */
export function isInnerNode(path: string): boolean {
  const pre = path + '.';
  return !LEAF_SPECS[path] && DEFAULT_LEAVES.some((l) => l.startsWith(pre));
}

/** Closest known leaf by edit distance (for "did you mean" hints), or null if none is close. */
export function suggestLeaf(path: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  const last = (p: string): string => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  for (const leaf of DEFAULT_LEAVES) {
    const d = Math.min(editDistance(path.toLowerCase(), leaf.toLowerCase()), editDistance(last(path), last(leaf)) + 1);
    if (d < bestD) {
      bestD = d;
      best = leaf;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(path.length / 4)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Human description of a spec, for error messages ("an integer in [1, 65535] or null"). */
export function describeSpec(s: LeafSpec): string {
  const n = 'nullable' in s && s.nullable ? ' or null' : '';
  switch (s.t) {
    case 'int':
      return `an integer ${s.max === undefined ? `>= ${s.min}` : `in [${s.min}, ${s.max}]`}${n}`;
    case 'num':
      return `a number in ${s.minExclusive ? '(' : '['}${s.min}, ${s.max ?? 'inf'}${s.maxExclusive ? ')' : ']'}${n}`;
    case 'bool':
      return `true or false${n}`;
    case 'str':
      return `${s.format === 'origin' ? 'an origin scheme://host[:port]' : s.format === 'urlpath' ? 'a path starting with /' : s.format === 'regex' ? 'a JS regex source' : 'a non-empty string'}${n}`;
    case 'enum':
      return `one of ${s.values.map((v) => JSON.stringify(v)).join(', ')}${n}`;
    case 'strs':
      return s.format === 'glob' ? 'an array of tool-name globs' : 'an array of strings';
    case 'headers':
      return 'an object of header name -> string value';
    case 'errorRules':
      return 'an array of ErrorRule objects';
    case 'exclusions':
      return 'an array of {id, match, flags?} objects';
    case 'false':
      return 'false (not implemented in v1)';
  }
}
