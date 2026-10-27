import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const doc = read('docs/TROUBLESHOOTING.md');

// Codes passed as literals to add(...)/pathCheck(...) in doctor (`${model}` becomes <model>), plus every TLS diagnosis but 'ok'.
const doctorCodes = [...read('src/diagnostics/doctor.ts').matchAll(/\b(?:add|pathCheck)\(\s*(['`])([^'`]+)\1/g)]
  .map((m) => m[2]!.replace(/\$\{[^}]+\}/g, '<model>'));
const tlsCodes = [...(/type TlsDiagnosis = ([^;]+);/.exec(read('src/diagnostics/tls-chain.ts'))?.[1] ?? '').matchAll(/'(\w+)'/g)]
  .map((m) => m[1]!).filter((c) => c !== 'ok');

test('every doctor and TLS check code is documented in TROUBLESHOOTING.md', () => {
  const all = new Set([...doctorCodes, ...tlsCodes]);
  assert.ok(all.has('instance.responsive') && all.has('model.<model>.budget') && all.has('leaf_only_missing_intermediate'), [...all].join(', '));
  assert.deepEqual([...all].filter((c) => !doc.includes(`\`${c}\``)), []);
});

test('relative links in TROUBLESHOOTING.md resolve', () => {
  for (const [, target] of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target!) || target!.startsWith('#')) continue;
    assert.ok(existsSync(join(ROOT, 'docs', target!.split('#')[0]!)), target);
  }
});
