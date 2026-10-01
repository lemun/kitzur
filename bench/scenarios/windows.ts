// Bench windows (W/O) and the per-window quantities the suite derives from them (bench/README.md§7.1).
//
// The kitzur preset quantities are recomputed here from the DESIGN.md formulas with the documented defaults
// (safety margin max(512, ceil(0.01·W)), allowance min(7000, floor(T_plan/2)), clientPoint W − min(O, 32000),
// triggerFraction 1.0, targetFraction 0.35). This is a bench-side oracle: it deliberately does not import the proxy's
// config code, and test/bench/scenario-windows.test.ts pins it to the DESIGN.md preset table.

export type WindowId = '32k' | '64k' | '100k' | '128k';

export interface WindowSpec {
  id: WindowId;
  /** the served context window (the mock's limit) */
  W: number;
  /** the client's max_tokens (and the preset's T_plan) */
  O: number;
}

export const WINDOWS: Readonly<Record<WindowId, WindowSpec>> = {
  '32k': { id: '32k', W: 32_000, O: 8_000 },
  '64k': { id: '64k', W: 64_000, O: 16_000 },
  '100k': { id: '100k', W: 100_000, O: 32_000 },
  '128k': { id: '128k', W: 128_000, O: 32_000 },
};
export const WINDOW_IDS: readonly WindowId[] = ['32k', '64k', '100k', '128k'];

/** "100k/32k" style label. */
export const windowLabel = (w: WindowSpec): string => `${w.W / 1000}k/${w.O / 1000}k`;

/** DESIGN.md: every floor(x · fraction) is Math.floor(x * fraction + 1e-9). */
const ffloor = (x: number, f: number): number => Math.floor(x * f + 1e-9);

export interface PresetQuantities {
  tPlan: number;
  margin: number;
  budget: number;
  clientPoint: number;
  allowance: number;
  hard: number;
  trigger: number;
  target: number;
}

/** The DESIGN.md quantities of the kitzur preset for a window (no learned state, no tighten). */
export function presetQuantities(w: WindowSpec): PresetQuantities {
  const tPlan = w.O;
  const margin = Math.max(512, Math.ceil(0.01 * w.W));
  const budget = w.W - tPlan - margin;
  const clientPoint = w.W - Math.min(w.O, 32_000);
  const allowance = Math.min(7_000, Math.floor(tPlan / 2));
  const hard = Math.min(budget, clientPoint - allowance);
  const trigger = Math.min(ffloor(hard, 1.0), hard);
  const target = Math.min(ffloor(trigger, 0.35), trigger - 1);
  return { tPlan, margin, budget, clientPoint, allowance, hard, trigger, target };
}

/** OpenCode's own compaction point `usable` = limit.context − min(limit.output, 32000) (benchmark contract ). */
export const openCodeUsable = (w: WindowSpec): number => w.W - Math.min(w.O, 32_000);

/**
 * gobstopper tuned @ W/O (benchmark contract ): 58000·(W − min(O,32000))/68000 rounded to the nearest 500.
 * 20,500 / 41,000 / 58,000 / 82,000.
 */
export function gobTunedThreshold(w: WindowSpec): number {
  const x = (58_000 * (w.W - Math.min(w.O, 32_000))) / 68_000;
  return Math.round(x / 500) * 500;
}

export type LimitMode = 'strict_total' | 'prompt_only' | 'tgi' | 'silent_truncate';

/** kitzur's forwarding ceiling L_fwd at W/O for a server mode (benchmark contract ). */
export function forwardingCeiling(w: WindowSpec, mode: LimitMode): number {
  const { hard } = presetQuantities(w);
  switch (mode) {
    case 'strict_total':
      return hard + w.O;
    case 'tgi':
      return hard + Math.min(w.O, 1024);
    case 'prompt_only':
    case 'silent_truncate':
      return hard;
  }
}

/** limitSkewTokens = W − L_fwd + ceil(0.04·W): the mock's real limit is L_fwd − ceil(0.04·W) (benchmark contract ). */
export function errorSkew(w: WindowSpec, mode: LimitMode): number {
  return w.W - forwardingCeiling(w, mode) + Math.ceil(0.04 * w.W);
}

/** The mock's real limit under the §7.1 skew. */
export const errorRealLimit = (w: WindowSpec, mode: LimitMode): number => w.W - errorSkew(w, mode);
