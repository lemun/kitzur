import type { Config } from '../config/schema.js';
import { computeBudget } from '../config/derived.js';
import { resolveModelConfig } from '../config/models.js';
import type { ModelProfiles } from '../config/schema.js';
import type { DoctorCheck } from './doctor.js';

const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const safeId = (v: unknown): string => typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, '\uFFFD').slice(0, 80) : 'unknown';

/** Read-only OpenCode diagnostics; never echo URLs, credentials or configuration contents. */
export function clientConfigChecks(cfg: Config, input: unknown, profiles: ModelProfiles = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const warn = (code: string, message: string, fix?: string): void => { checks.push({ code: 'client.' + code, status: 'warn', message, ...(fix ? { fix } : {}) }); };
  const local = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);
  const hostMatches = (host: string): boolean => host === cfg.listen.host || local.has(host) && local.has(cfg.listen.host);
  const root = object(input);
  const compaction = object(root.compaction);
  const providerEntries = Object.entries(object(root.provider)).map(([key, value]) => [key, object(value)] as const);
  const matches = providerEntries.filter(([, p]) => {
    try {
      const u = new URL(String(object(p.options).baseURL));
      return (u.protocol === 'http:' || u.protocol === 'https:') && hostMatches(u.hostname) &&
        Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === cfg.listen.port;
    } catch { return false; }
  });
  if (!matches.length) {
    warn('base_url', 'No provider baseURL points at the Kitzur listen address and port.');
    return checks;
  }
  const routed = (selection: unknown, field: string): void => {
    if (selection === undefined) return;
    if (typeof selection !== 'string' || !selection.includes('/')) {
      warn('routing', `${field} does not resolve to a provider/model selection.`);
      return;
    }
    const [providerId, ...modelParts] = selection.split('/');
    const modelId = modelParts.join('/');
    const providerEntry = providerEntries.find(([key]) => key === providerId);
    const provider = providerEntry?.[1];
    const found = provider && Object.entries(object(provider.models)).some(([key, value]) =>
      key === modelId || object(value).id === modelId);
    if (!found || !matches.some(([key]) => key === providerEntry?.[0]))
      warn('routing', `${field} ${safeId(selection)} does not resolve to a model in a Kitzur-routed OpenCode provider.`);
  };
  routed(root.model, 'model');
  routed(root.small_model, 'small_model');
  for (const [providerKey, p] of matches) {
    if (p.npm !== '@ai-sdk/openai-compatible')
      warn('npm', 'Use @ai-sdk/openai-compatible; the OpenAI provider uses /responses, which Kitzur forwards untouched.');
    const modelEntries = Object.entries(object(p.models)).map(([key, value]) => [key, object(value)] as const);
    const models = modelEntries.map(([key, value]) => ({ key, value, wireId: typeof value.id === 'string' ? value.id : key }));
    if (!models.length) warn('context', 'Provider models are missing limit.context.');
    for (const { key, value: model, wireId } of models) {
      const modelCfg = resolveModelConfig(cfg, profiles, wireId);
      const b = computeBudget(modelCfg);
      const label = `${safeId(providerKey)}/${safeId(key)}`;
      if (!Object.hasOwn(profiles, wireId) && Object.keys(profiles).length)
        warn('profile', `${label}: no Kitzur profile for wire model ${safeId(wireId)}; root defaults apply.`);
      const limit = object(model.limit);
      if (limit.context === 0) continue;
      if (!positive(limit.context)) {
        warn('context', `${label}: missing a positive limit.context.`);
        continue;
      }
      if (!positive(limit.output)) {
        warn('output', `${label}: missing a positive limit.output; OpenCode usable context cannot be verified.`);
        continue;
      }
      if (compaction.auto === false) continue;
      const maxOutputTokens = Math.min(limit.output, modelCfg.client.outputTokenMax);
      const reserved = typeof compaction.reserved === 'number' && Number.isFinite(compaction.reserved) && compaction.reserved >= 0
        ? compaction.reserved : Math.min(20_000, maxOutputTokens);
      const usable = positive(limit.input)
        ? Math.max(0, limit.input - reserved)
        : Math.max(0, limit.context - maxOutputTokens);
      if (b.trigger > usable - b.allowance)
        warn('usable', `${label}: OpenCode compacts at ${usable}, Kitzur triggers at ${b.trigger} (output allowance ${b.allowance})${usable <= 0 ? '; no usable context remains' : '; the client may compact first'}.`,
          'Mirror the client in kitzur.jsonc: ' + [positive(limit.input) ? `client.inputLimit: ${limit.input}` : null,
            positive(limit.input) && compaction.reserved === reserved ? `client.reservedTokens: ${reserved}` : null,
            limit.output !== (modelCfg.client.outputLimit ?? b.planMaxTokens) ? `client.outputLimit: ${limit.output}` : null].filter(Boolean).join(', ') + '; align budget.window with limit.context.');
    }
  }
  if (!checks.length) checks.push({ code: 'client.compatible', status: 'ok', message: 'OpenCode provider routing and usable context are compatible.' });
  return checks;
}
