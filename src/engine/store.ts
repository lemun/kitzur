// The memo store (DESIGN.md): planKey -> plan after a boundary, in memory with LRU order and caps
// on entries and bytes (store.maxPlans, store.maxBytes). Persistence is optional and injected (the
// engine does no I/O itself; see store-file.ts for the JSONL adapter). The store only saves CPU: the
// fold recomputes the same plans without it (I5), so eviction and restarts never change results.
//
// As in gobstopper v0.7.2 (crates/gobstopper-adapters/src/request/store.rs:86-97) eviction never
// empties the store: an oversized newest entry stays.
import type { Plan, PlanStore } from '../types.js';

/** Injected persistence: a lazy lookup and an append. Implementations must never throw. */
export interface PlanPersistence {
  /** plan stored under `key`, if any (the first call may load the files lazily) */
  load(key: string): Plan | undefined;
  append(key: string, plan: Plan): void;
}

export interface MemoryStoreOptions {
  maxPlans: number;
  maxBytes: number;
  persistence?: PlanPersistence | null;
}

export interface StoreStats {
  hits: number;
  misses: number;
  persistedHits: number;
  evictions: number;
  bytes: number;
}

// Plans are shared by many keys (a reuse step stores the same object again); their size is computed once.
const planBytes = new WeakMap<Plan, number>();
function sizeOf(p: Plan): number {
  let n = planBytes.get(p);
  if (n === undefined) {
    n = Buffer.byteLength(JSON.stringify(p), 'utf8');
    planBytes.set(p, n);
  }
  return n;
}

/** In-memory LRU plan store with optional persistence. Plans are treated as immutable. */
export class MemoryPlanStore implements PlanStore {
  private readonly m = new Map<string, Plan>();
  private bytes = 0;
  private readonly st: StoreStats = { hits: 0, misses: 0, persistedHits: 0, evictions: 0, bytes: 0 };
  constructor(private readonly o: MemoryStoreOptions) {}

  get(key: string): Plan | undefined {
    const p = this.m.get(key);
    if (p) {
      this.m.delete(key);
      this.m.set(key, p);
      this.st.hits++;
      return p;
    }
    const q = this.o.persistence?.load(key);
    if (q) {
      this.st.persistedHits++;
      this.put(key, q);
      return q;
    }
    this.st.misses++;
    return undefined;
  }

  set(key: string, plan: Plan): void {
    if (this.m.get(key) === plan) return;
    this.put(key, plan);
    this.o.persistence?.append(key, plan);
  }

  size(): number {
    return this.m.size;
  }

  stats(): StoreStats {
    return { ...this.st, bytes: this.bytes };
  }

  private put(key: string, plan: Plan): void {
    const old = this.m.get(key);
    if (old) {
      this.bytes -= sizeOf(old);
      this.m.delete(key);
    }
    this.m.set(key, plan);
    this.bytes += sizeOf(plan);
    const maxPlans = Math.max(1, this.o.maxPlans);
    while (this.m.size > 1 && (this.m.size > maxPlans || this.bytes > this.o.maxBytes)) {
      const k = this.m.keys().next().value as string;
      this.bytes -= sizeOf(this.m.get(k)!);
      this.m.delete(k);
      this.st.evictions++;
    }
  }
}
