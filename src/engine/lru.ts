// A small LRU map: a Map's insertion order is its recency order, so get/set are O(1)
// (gobstopper's store touches a VecDeque in O(n); reference implementation "The O(1) LRU idea").

/** Least-recently-used map with an entry cap. Values must not be `undefined`. */
export class Lru<K, V> {
  private readonly m = new Map<K, V>();
  constructor(readonly cap: number) {}

  /** Returns the value and marks it most recently used. */
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }

  /** Returns the value without touching the recency order. */
  peek(k: K): V | undefined {
    return this.m.get(k);
  }

  has(k: K): boolean {
    return this.m.has(k);
  }

  set(k: K, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > Math.max(1, this.cap)) this.m.delete(this.m.keys().next().value as K);
  }

  delete(k: K): boolean {
    return this.m.delete(k);
  }

  get size(): number {
    return this.m.size;
  }

  clear(): void {
    this.m.clear();
  }

  /** Oldest first. */
  keys(): IterableIterator<K> {
    return this.m.keys();
  }
}
