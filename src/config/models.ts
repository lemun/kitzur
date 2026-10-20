// Model maps are loader metadata, never leaves of the root Config.
import type { Config, ModelProfiles } from './schema.js';
import { isPlainObject, LEAF_SPECS, setPath } from './spec.js';
import { checkLeaf, validateConfig } from './validate.js';
import { enableAutoWindow, isAutoWindow } from './window.js';

export type ModelOverrides = Map<string, Map<string, unknown>>;
const ALLOWED = new Set([
  'budget.window', 'budget.limitCountsMaxTokens', 'budget.defaultMaxTokens', 'budget.planMaxTokens',
  'budget.safetyMarginTokens', 'budget.safetyMarginFraction', 'budget.maxTokensClamp.enabled',
  'budget.maxTokensClamp.floorTokens', 'budget.maxTokensRestore.enabled', 'budget.maxTokensRestore.toTokens',
  'client.compactionPointTokens', 'client.inputLimit', 'client.reservedTokens', 'client.outputLimit',
  'client.outputTokenMax', 'client.outputAllowanceTokens', 'tokenizer.mode', 'tokenizer.template.name',
]);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function validModelId(id: string): boolean {
  return id.trim().length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(id) && !FORBIDDEN.has(id);
}

/** Strip and merge each JSON layer before the ordinary leaf loader sees it. */
export function takeModelLayer(layer: Record<string, unknown>, overrides: ModelOverrides, source: string, issues: string[]): void {
  if (!Object.hasOwn(layer, 'models')) return;
  const models = layer['models'];
  delete layer['models'];
  if (!isPlainObject(models)) { issues.push(`${source}: models must be an object`); return; }
  for (const [id, value] of Object.entries(models)) {
    const where = `${source}: models[${JSON.stringify(id)}]`;
    if (!validModelId(id)) { issues.push(`${where}: invalid model ID (non-empty, at most 256 characters, no controls or prototype keys)`); continue; }
    const leaves = overrides.get(id) ?? new Map<string, unknown>();
    overrides.set(id, leaves);
    const visit = (node: unknown, prefix: string): void => {
      if (!isPlainObject(node)) { issues.push(`${where}${prefix ? '.' + prefix : ''}: must be an object`); return; }
      for (const [key, v] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        // Literal dotted keys must not bypass the nested schema or prototype checks.
        if (FORBIDDEN.has(key) || key.includes('.')) { issues.push(`${where}.${path}: prohibited key`); continue; }
        if (ALLOWED.has(path)) {
          const error = checkLeaf(path, LEAF_SPECS[path]!, v);
          if (error) issues.push(`${where}: ${error}`);
          else leaves.set(path, v);
        } else if ([...ALLOWED].some((p) => p.startsWith(path + '.'))) visit(v, path);
        else issues.push(`${where}.${path}: model override is not allowed`);
      }
    };
    visit(value, '');
  }
}

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

/** Resolve over the final root, so late root assignments affect only inheriting leaves. */
export function buildModelProfiles(root: Config, overrides: ModelOverrides, issues: string[], warnings: string[]): ModelProfiles {
  const profiles: Record<string, Config> = Object.create(null) as Record<string, Config>;
  for (const [id, leaves] of overrides) {
    const cfg = structuredClone(root);
    for (const [path, value] of leaves) setPath(cfg as unknown as Record<string, unknown>, path, value);
    const explicitWindow = leaves.get('budget.window');
    if (explicitWindow === 'auto' || (!leaves.has('budget.window') && isAutoWindow(root))) {
      enableAutoWindow(cfg, root.budget.window);
      const limits = [cfg.client.inputLimit, cfg.client.compactionPointTokens].filter((n): n is number => n !== null);
      if (limits.some((n) => cfg.budget.window > n)) warnings.push(`models[${JSON.stringify(id)}]: auto fallback window ${cfg.budget.window} exceeds an explicit client limit`);
    }
    const result = validateConfig(cfg);
    const qualify = (m: string): string => `models[${JSON.stringify(id)}]: ${m}`;
    issues.push(...result.errors.map(qualify));
    warnings.push(...result.warnings.map(qualify));
    freezeDeep(cfg);
    profiles[id] = cfg;
  }
  return Object.freeze(profiles);
}

const warned = new WeakSet<ModelProfiles>();

/** Exact wire IDs only. Unknown/missing models, including small_model, use root defaults. */
export function resolveModelConfig(root: Config, profiles: ModelProfiles, model?: string, warn?: (message: string) => void): Config {
  if (model !== undefined && validModelId(model) && Object.hasOwn(profiles, model)) return profiles[model]!;
  // One warning per profile map, with no client-controlled ID storage. Legacy mode stays silent.
  if (warn && Object.keys(profiles).length > 0 && !warned.has(profiles)) {
    warned.add(profiles);
    warn('Unknown or missing model: using root defaults (further fallback warnings suppressed)');
  }
  return root;
}
