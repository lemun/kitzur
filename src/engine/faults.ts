// Test fault injection (DESIGN.md "How the invariants are tested", ):
// KITZUR_TEST_FAULTS=engine-throw:<p> makes engine.process throw inside its pipeline with probability p,
// so the fuzz suite can check the I7 fallback. The decision is a deterministic function of the request
// (its chain key and attempt), so a failing case reproduces. Unset or unparsable = no faults.
import { sha256Hex } from './canonical.js';

export interface Faults {
  /** probability that the pipeline throws */
  engineThrow: number;
}

/** Parses `engine-throw:0.01[,other:…]`. */
export function parseFaults(spec: string | null | undefined): Faults | null {
  if (!spec) return null;
  let engineThrow = 0;
  for (const item of spec.split(',')) {
    const [name, value] = item.split(':');
    if (name?.trim() === 'engine-throw') {
      const p = Number(value);
      if (Number.isFinite(p) && p > 0) engineThrow = Math.min(1, p);
    }
  }
  return engineThrow > 0 ? { engineThrow } : null;
}

/** True when this request should throw: sha256(key ‖ attempt) mapped to [0, 1) is below p. */
export function shouldThrow(f: Faults | null, key: string, attempt: number): boolean {
  if (!f || f.engineThrow <= 0) return false;
  const h = sha256Hex(`fault|${key}|${attempt}`);
  return parseInt(h.slice(0, 12), 16) / 2 ** 48 < f.engineThrow;
}

export class InjectedFault extends Error {
  constructor() {
    super('kitzur test fault: engine-throw');
    this.name = 'InjectedFault';
  }
}
