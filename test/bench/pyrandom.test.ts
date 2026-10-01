import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyRandom, bitLength } from '../../bench/lib/pyrandom.js';
import { pyFloatRepr } from '../../bench/lib/pyjson.js';
import { benchFixture, Checker } from './fixtures.js';

interface SeedVectors {
  random_repr: string[];
  random_num53: string[];
  getrandbits32: number[];
  randint_1_999: number[];
  choice_list16: string[];
  sample_range8_4: number[][];
  sample_ABCDEFGH_4: string[][];
  sample_range100_5_setbranch: number[][];
  sample_range80_6_poolbranch: number[][];
  sample_range90_6_setbranch: number[][];
  getrandbits_k: Record<string, string[]>;
  mixed: Array<[string, string | number]>;
  randint_misc: Record<string, number[]>;
}

const V = benchFixture<{ list16: string[]; seeds: Record<string, SeedVectors> }>('pyrandom.json.gz');
const rep = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

test('PyRandom reproduces CPython 3.14 random for every vector seed', () => {
  const c = new Checker();
  const L = V.list16;
  assert.ok(Object.keys(V.seeds).length >= 20);
  for (const [s, v] of Object.entries(V.seeds)) {
    const seed = BigInt(s);
    let r = new PyRandom(seed);
    const rnd = rep(20, () => r.random());
    c.eq(rnd.map(pyFloatRepr), v.random_repr, `${s} random repr`);
    c.eq(rnd.map((x) => String(BigInt(x * 2 ** 53))), v.random_num53, `${s} random num53`);
    r = new PyRandom(seed);
    c.eq(rep(20, () => r.getrandbits(32)), v.getrandbits32, `${s} u32`);
    r = new PyRandom(seed);
    c.eq(rep(20, () => r.randint(1, 999)), v.randint_1_999, `${s} randint`);
    r = new PyRandom(seed);
    c.eq(rep(20, () => r.choice(L)), v.choice_list16, `${s} choice`);
    r = new PyRandom(seed);
    c.eq(rep(20, () => r.sample(range(8), 4)), v.sample_range8_4, `${s} sample8`);
    r = new PyRandom(seed);
    c.eq(rep(5, () => r.sample([...'ABCDEFGH'], 4)), v.sample_ABCDEFGH_4, `${s} sampleAB`);
    r = new PyRandom(seed);
    c.eq(rep(5, () => r.sample(range(100), 5)), v.sample_range100_5_setbranch, `${s} sample set`);
    r = new PyRandom(seed);
    c.eq(rep(3, () => r.sample(range(80), 6)), v.sample_range80_6_poolbranch, `${s} sample k6 pool`);
    r = new PyRandom(seed);
    c.eq(rep(3, () => r.sample(range(90), 6)), v.sample_range90_6_setbranch, `${s} sample k6 set`);
    r = new PyRandom(seed);
    const gb: Record<string, string[]> = {};
    for (const k of [1, 2, 3, 4, 5, 7, 10, 31, 32, 33, 53, 64, 65]) gb[k] = rep(3, () => String(r.getrandbits(k, true)));
    c.eq(gb, v.getrandbits_k, `${s} getrandbits_k`);
    r = new PyRandom(seed);
    const mixed: Array<[string, string | number]> = [];
    for (let i = 0; i < 20; i++) {
      mixed.push(['choice16', r.choice(L)]);
      mixed.push(['randint(1,4)', r.randint(1, 4)]);
      mixed.push(['randint(100,9999)', r.randint(100, 9999)]);
      mixed.push(['random', pyFloatRepr(r.random())]);
      mixed.push(['randint(10,99)', r.randint(10, 99)]);
    }
    c.eq(mixed, v.mixed, `${s} mixed`);
    const m: Record<string, number[]> = {};
    r = new PyRandom(seed);
    m['randint(1,4)'] = rep(20, () => r.randint(1, 4));
    r = new PyRandom(seed);
    m['randint(10,900)'] = rep(20, () => r.randint(10, 900));
    r = new PyRandom(seed);
    m['randint(1,1)'] = rep(5, () => r.randint(1, 1));
    r = new PyRandom(seed);
    m['randint(300,9000)'] = rep(20, () => r.randint(300, 9000));
    c.eq(m, v.randint_misc, `${s} randint_misc`);
  }
  assert.equal(c.fails.length, 0, c.summary());
  assert.ok(c.checks >= 260, c.summary());
});

test('spot values and small helpers', () => {
  const r = new PyRandom(1);
  assert.equal(r.random(), 0.13436424411240122);
  assert.equal(r.random(), 0.8474337369372327);
  const r2 = new PyRandom(1000);
  assert.deepEqual(rep(5, () => r2.randint(1, 999)), [797, 440, 686, 779, 102]);
  // randint(1,1) consumes a word (never shortcut)
  const a = new PyRandom(7);
  a.randint(1, 1);
  const b = new PyRandom(7);
  b.genrandUint32();
  assert.equal(a.random(), b.random());
  assert.equal(bitLength(16), 5);
  assert.equal(bitLength(2 ** 40), 41);
  assert.throws(() => new PyRandom(1).choice([]));
});
