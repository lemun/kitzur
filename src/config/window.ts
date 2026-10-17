// Runtime discovery stays separate from persisted overflow learning and configuration.
import type { Config } from './schema.js';

const automatic = new WeakSet<Config>();
const discovered = new WeakMap<Config, Readonly<Record<string, number>>>();

export function enableAutoWindow(cfg: Config, window: number): void {
  cfg.budget.window = window;
  automatic.add(cfg);
}

export function setDiscoveredWindows(cfg: Config, windows: Readonly<Record<string, number>>): void {
  discovered.set(cfg, windows);
}

export function modelWindow(cfg: Config, model?: string): number {
  const windows = discovered.get(cfg);
  return isAutoWindow(cfg) && model !== undefined && windows && Object.hasOwn(windows, model)
    ? windows[model]!
    : cfg.budget.window;
}

export function isAutoWindow(cfg: Config): boolean {
  return automatic.has(cfg);
}
