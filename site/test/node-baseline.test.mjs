// node --test test/node-baseline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
const parse = (v) => v.split('.').map(Number);
const cmp = (a, b) => a.reduce((d, n, i) => d || n - (b[i] ?? 0), 0);

// Enough of semver for engines.node: `||` of `>=x.y.z`, `^x.y.z` or a bare major.
function satisfies(version, range) {
  const v = parse(version);
  return range.split('||').some((part) => {
    const [, op, want] = /^\s*(>=|\^)?\s*([\d.]+)\s*$/.exec(part);
    const w = parse(want);
    if (op === '>=') return cmp(v, w) >= 0;
    return v[0] === w[0] && cmp(v, w) >= 0;
  });
}

// Astro refuses to start on a Node below its engines range, so the lock must fit the baseline.
// Optional packages are per-platform binaries that npm skips when they do not fit.
test('every required locked package supports the site Node baseline', async () => {
  const { engines } = await json('package.json');
  const baseline = /^>=(\d+\.\d+\.\d+)$/.exec(engines.node)[1];
  const { packages } = await json('package-lock.json');
  const unsupported = Object.entries(packages)
    .filter(([, p]) => !p.optional && p.engines?.node && !satisfies(baseline, p.engines.node))
    .map(([name, p]) => `${name} ${p.engines.node}`);
  assert.deepEqual(unsupported, []);
});
