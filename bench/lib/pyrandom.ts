// Port of the subset of CPython 3.14 `random.Random` used by the reference harness (scenario.py).
// Verified against reference implementation (test/bench/pyrandom.test.ts).
// Sources: CPython v3.14 Modules/_randommodule.c (genrand_uint32, random, init_genrand, init_by_array,
// random_seed, getrandbits) and Lib/random.py (seed, _randbelow_with_getrandbits, randrange, randint,
// choice, sample).
//
// Draw-order traps the harness depends on (reference implementation):
//  - _randbelow(n) uses k = n.bit_length() (NOT (n-1).bit_length()); choice over 16 items draws 5 bits
//    and rejects 16..31;
//  - randbelow(1) (randint(1,1)) still consumes a 32-bit word;
//  - random() consumes two words (27 + 26 bits).

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;

  constructor(seed: number | bigint) {
    this.seed(seed);
  }

  /** random.Random(int).seed: key = abs(seed) split into 32-bit words, least significant first; 0 -> [0]. */
  seed(a: number | bigint): void {
    let n = BigInt(a);
    if (n < 0n) n = -n;
    const key: number[] = [];
    if (n === 0n) key.push(0);
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const len = key.length;
    for (let k = N > len ? N : len; k; k--) {
      const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(p, 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= len) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(p, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  genrandUint32(): number {
    const mt = this.mt;
    if (this.index >= N) {
      let kk = 0;
      let y: number;
      for (; kk < N - M; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK);
      mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** [0,1) with 53-bit resolution; the multiply by 2**-53 is exact in doubles, so bits equal CPython's. */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864 + b) * (1 / 9007199254740992);
  }

  /** k <= 32: a Number. k > 32: words filled least-significant first, the last word keeps its HIGH bits. */
  getrandbits(k: number): number;
  getrandbits(k: number, big: true): bigint;
  getrandbits(k: number, big?: true): number | bigint {
    if (k < 0) throw new RangeError('number of bits must be non-negative');
    if (k <= 32 && !big) return k === 0 ? 0 : this.genrandUint32() >>> (32 - k);
    let result = 0n;
    let shift = 0n;
    for (let left = k; left > 0; left -= 32) {
      let r = this.genrandUint32();
      if (left < 32) r >>>= 32 - left;
      result |= BigInt(r) << shift;
      shift += 32n;
    }
    if (big) return result;
    if (k > 53) throw new RangeError('getrandbits(k > 53) needs big=true');
    return Number(result);
  }

  /** Lib/random.py _randbelow_with_getrandbits. */
  randbelow(n: number): number {
    if (!(n > 0) || !Number.isSafeInteger(n)) throw new RangeError('randbelow needs a positive safe integer');
    const k = bitLength(n);
    if (k > 53) throw new RangeError('randbelow: n too large');
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(start: number, stop?: number): number {
    if (stop === undefined) {
      if (start > 0) return this.randbelow(start);
      throw new RangeError('empty range for randrange()');
    }
    const width = stop - start;
    if (width > 0) return start + this.randbelow(width);
    throw new RangeError(`empty range in randrange(${start}, ${stop})`);
  }

  randint(a: number, b: number): number {
    if (b < a) throw new RangeError(`empty range in randint(${a}, ${b})`);
    return a + this.randbelow(b - a + 1);
  }

  choice<T>(seq: readonly T[]): T {
    if (!seq.length) throw new RangeError('Cannot choose from an empty sequence');
    return seq[this.randbelow(seq.length)]!;
  }

  /** Lib/random.py sample(): pool branch when n <= setsize, else the "selected set" branch. */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!(k >= 0 && k <= n)) throw new RangeError('Sample larger than population or is negative');
    const result = new Array<T>(k);
    let setsize = 21;
    // log(k*3, 4) is log(x)/log(4) in C; k*3 is never a power of 4, so rounding cannot flip the ceil.
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = Array.from(population);
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j]!;
        pool[j] = pool[n - i - 1]!;
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j]!;
      }
    }
    return result;
  }
}

/** Python int.bit_length() for a non-negative safe integer. */
export function bitLength(n: number): number {
  if (n < 0x100000000) return 32 - Math.clz32(n);
  let k = 0;
  while (n >= 1) {
    n = Math.floor(n / 2);
    k++;
  }
  return k;
}
