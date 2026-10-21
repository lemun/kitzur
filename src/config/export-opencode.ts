import { planMaxTokens } from './derived.js';
import { isAutoWindow } from './window.js';
import type { Config, ModelProfiles } from './schema.js';

export interface OpenCodeExportOptions {
  model: string;
  smallModel?: string;
  provider?: string;
  keyEnv?: string;
}

/** Render a single-provider OpenCode config. The caller owns stdout; this function never writes files. */
export function exportOpenCode(root: Config, profiles: ModelProfiles, options: OpenCodeExportOptions): string {
  const ids = Object.keys(profiles);
  const selected = [...new Set([options.model, options.smallModel ?? options.model])];
  for (const id of selected) if (!Object.hasOwn(profiles, id)) throw new Error(`model ${JSON.stringify(id)} has no configured profile`);
  const provider = options.provider ?? 'kitzur';
  const keyEnv = options.keyEnv ?? 'OPENAI_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('--key-env must be an environment variable name');
  const reservations = [...new Set(ids.map((id) => profiles[id]!.client.reservedTokens).filter((value): value is number => value !== null && value > 0))];
  if (reservations.length > 1) throw new Error('profiles have conflicting explicit output reservations');
  const models: Record<string, unknown> = {};
  for (const id of ids) {
    const cfg = profiles[id]!;
    const context = cfg.budget.window;
    const output = Math.min(cfg.client.outputLimit ?? planMaxTokens(cfg), cfg.client.outputTokenMax);
    if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(output) || output <= 0) {
      throw new Error(`model ${JSON.stringify(id)} has unusable numeric limits`);
    }
    if (cfg.client.reservedTokens !== null && cfg.client.reservedTokens > 0 && cfg.client.outputLimit !== null && cfg.client.reservedTokens >= cfg.client.outputLimit) {
      throw new Error(`model ${JSON.stringify(id)} has conflicting explicit output reservation`);
    }
    models[id] = { limit: { context, output }, ...(isAutoWindow(cfg) ? { description: `Auto window fallback: ${context}` } : {}) };
  }
  const baseURL = `http://${root.listen.host}:${root.listen.port}/v1`;
  const model = `${provider}/${options.model}`;
  const smallModel = `${provider}/${options.smallModel ?? options.model}`;
  // Keep exact wire IDs as provider model keys, including slashes and case.
  const providerModels = Object.fromEntries(ids.map((id) => [id, models[id]]));
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', model, small_model: smallModel,
    provider: { [provider]: { npm: '@ai-sdk/openai-compatible', name: 'Kitzur', options: { baseURL, apiKey: `{env:${keyEnv}}` }, models: providerModels } } }, null, 2) + '\n';
}
