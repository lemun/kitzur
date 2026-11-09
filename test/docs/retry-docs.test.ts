import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const readme = read('README.md');
const leaves = Object.keys(DEFAULT_CONFIG.upstream.retry).map((k) => `upstream.retry.${k}`).sort();

test('README answers what happens when the gateway answers 429 or 503', () => {
  assert.match(readme, /\*\*What if my gateway answers 429 or 503\?\*\*/);
});

test('README names only upstream.retry keys that exist', () => {
  const named = [...new Set([...readme.matchAll(/`(upstream\.retry\.[A-Za-z]+)`/g)].map((m) => m[1]!))];
  assert.ok(named.length > 0, 'README names no upstream.retry key');
  for (const key of named) assert.ok(leaves.includes(key), `README names unknown key ${key}`);
});

test('CONFIG.md documents exactly the upstream.retry leaves of DEFAULT_CONFIG', () => {
  const documented = [...read('CONFIG.md').matchAll(/^\| `(upstream\.retry\.[A-Za-z]+)` \|/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(documented, leaves);
});

test('the retry proposal exists and README links it', () => {
  assert.ok(existsSync(join(ROOT, 'docs/proposals/upstream-retry.md')));
  assert.ok(readme.includes('](docs/proposals/upstream-retry.md)'));
});
