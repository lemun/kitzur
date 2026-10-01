// A bounded least-recently-used map. The ledger caches per-message extraction results by digest in one
// (DESIGN.md); a cache hit returns exactly what a miss would compute, so output never depends on it.

export class Lru<V> {
  private readonly m = new Map<string, V>();
  constructor(private readonly cap: number) {}

  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }

  set(k: string, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string);
  }

  get size(): number {
    return this.m.size;
  }

  clear(): void {
    this.m.clear();
  }
}
