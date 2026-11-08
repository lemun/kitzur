import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFaults, shouldThrow } from '../../src/engine/faults.js';

test('parseFaults reads engine-throw and its optional seed', () => {
  for (const spec of [null, undefined, '']) assert.equal(parseFaults(spec), null);
  assert.deepEqual(parseFaults('engine-throw:0.5'), { engineThrow: 0.5 });
  assert.ok(!('seed' in parseFaults('engine-throw:0.5')!));
  assert.deepEqual(parseFaults('engine-throw:0.5:abc'), { engineThrow: 0.5, seed: 'abc' });
  assert.deepEqual(parseFaults('engine-throw:3'), { engineThrow: 1 });
  for (const spec of ['engine-throw:0', 'engine-throw:-0.5', 'engine-throw:NaN', 'engine-throw', 'other:1'])
    assert.equal(parseFaults(spec), null, spec);
  assert.deepEqual(parseFaults('other:1,engine-throw:0.25'), { engineThrow: 0.25 });
  assert.deepEqual(parseFaults('  engine-throw :0.25'), { engineThrow: 0.25 });
});

test('shouldThrow is deterministic and follows the probability', () => {
  assert.equal(shouldThrow(null, 'k', 0), false);
  assert.equal(shouldThrow({ engineThrow: 0 }, 'k', 0), false);
  const always = { engineThrow: 1 };
  for (let i = 0; i < 100; i++) assert.equal(shouldThrow(always, `k${i}`, i), true);
  const half = { engineThrow: 0.5, seed: 's' };
  for (let i = 0; i < 20; i++) assert.equal(shouldThrow(half, `k${i}`, 1), shouldThrow(half, `k${i}`, 1));
  const keys = Array.from({ length: 64 }, (_, i) => `k${i}`);
  assert.ok(keys.some((k) => shouldThrow(half, k, 1) !== shouldThrow({ engineThrow: 0.5, seed: 't' }, k, 1)));
  assert.ok(keys.some((k) => shouldThrow(half, k, 1) !== shouldThrow(half, k, 2)));
  const quarter = { engineThrow: 0.25 };
  let thrown = 0;
  for (let i = 0; i < 2000; i++) if (shouldThrow(quarter, `key-${i}`, 0)) thrown++;
  assert.ok(thrown / 2000 >= 0.2 && thrown / 2000 <= 0.3, `fraction ${thrown / 2000}`);
});
