import type { Config } from './schema.js';

/** The client's own compaction point, shared by reporting and request budgeting. */
export function clientCompactionPoint(cfg: Config, window: number, planMaxTokens: number): number {
  const c = cfg.client;
  if (c.compactionPointTokens !== null) return c.compactionPointTokens;
  const output = Math.min(c.outputLimit ?? planMaxTokens, c.outputTokenMax);
  return c.inputLimit === null
    ? window - output
    : Math.max(0, c.inputLimit - (c.reservedTokens ?? Math.min(20_000, output)));
}
