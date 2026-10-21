import type { Config } from '../config/schema.js';
import { computeBudget } from '../config/derived.js';
import type { DoctorCheck } from './doctor.js';

const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Read-only OpenCode diagnostics; never echo URLs, credentials or configuration contents. */
export function clientConfigChecks(cfg: Config, input: unknown): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const warn = (code: string, message: string, fix?: string): void => { checks.push({ code: 'client.' + code, status: 'warn', message, ...(fix ? { fix } : {}) }); };
  const local = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);
  const hostMatches = (host: string): boolean => host === cfg.listen.host || local.has(host) && local.has(cfg.listen.host);
  const root = object(input);
  const compaction = object(root.compaction);
  const providers = Object.values(object(root.provider)).map(object);
  const matches = providers.filter((p) => {
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
  const b = computeBudget(cfg);
  for (const p of matches) {
    if (p.npm !== '@ai-sdk/openai-compatible')
      warn('npm', 'Use @ai-sdk/openai-compatible; the OpenAI provider uses /responses, which Kitzur forwards untouched.');
    const models = Object.values(object(p.models)).map(object);
    if (!models.length) warn('context', 'Provider models are missing limit.context.');
    for (const model of models) {
      const limit = object(model.limit);
      if (limit.context === 0) continue;
      if (!positive(limit.context)) {
        warn('context', 'A provider model is missing a positive limit.context.');
        continue;
      }
      if (!positive(limit.output)) {
        warn('output', 'A provider model is missing a positive limit.output; OpenCode usable context cannot be verified.');
        continue;
      }
      if (compaction.auto === false) continue;
      const maxOutputTokens = Math.min(limit.output, cfg.client.outputTokenMax);
      const reserved = typeof compaction.reserved === 'number' && Number.isFinite(compaction.reserved) && compaction.reserved >= 0
        ? compaction.reserved : Math.min(20_000, maxOutputTokens);
      const usable = positive(limit.input)
        ? Math.max(0, limit.input - reserved)
        : Math.max(0, limit.context - maxOutputTokens);
      if (b.trigger > usable - b.allowance)
        warn('usable', `OpenCode compacts at ${usable}, Kitzur triggers at ${b.trigger} (output allowance ${b.allowance}); the client may compact first.`,
          'Mirror the client in kitzur.jsonc: ' + [positive(limit.input) ? `client.inputLimit: ${limit.input}` : null,
            positive(limit.input) && compaction.reserved === reserved ? `client.reservedTokens: ${reserved}` : null,
            limit.output !== (cfg.client.outputLimit ?? b.planMaxTokens) ? `client.outputLimit: ${limit.output}` : null].filter(Boolean).join(', ') + '; align budget.window with limit.context.');
    }
  }
  if (!checks.length) checks.push({ code: 'client.compatible', status: 'ok', message: 'OpenCode provider routing and usable context are compatible.' });
  return checks;
}
