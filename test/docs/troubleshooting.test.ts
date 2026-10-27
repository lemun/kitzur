import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const doc = read('docs/TROUBLESHOOTING.md');

// Every literal in the first argument of add(...)/pathCheck(...) (ternaries included) or assigned to `const code` in doctor
// (`${model}` becomes <model>), the client-config codes doctor returns, plus every TLS diagnosis but 'ok'.
const literals = (src: string) => [...src.matchAll(/(['`])([^'`]+)\1/g)].map((m) => m[2]!.replace(/\$\{[^}]+\}/g, '<model>'));
const doctorSrc = read('src/diagnostics/doctor.ts');
const doctorCodes = [...doctorSrc.matchAll(/\b(?:add|pathCheck)\(([^,]+),|\bconst code = ([^;]+);/g)]
  .flatMap((m) => literals(m[1] ?? m[2]!));
const clientSrc = read('src/diagnostics/client-config.ts');
const clientCodes = [...clientSrc.matchAll(/\bwarn\('(\w+)'|code: '(client\.\w+)'/g)].map((m) => m[2] ?? `client.${m[1]}`);
const tlsCodes = [...(/type TlsDiagnosis = ([^;]+);/.exec(read('src/diagnostics/tls-chain.ts'))?.[1] ?? '').matchAll(/'(\w+)'/g)]
  .map((m) => m[1]!).filter((c) => c !== 'ok');

test('every doctor and TLS check code is documented in TROUBLESHOOTING.md', () => {
  const all = new Set([...doctorCodes, ...clientCodes, ...tlsCodes]);
  const expected = ['instance.responsive', 'model.<model>.budget', 'model.<model>.tokenizer', 'tokenizer.count', 'client.usable', 'client.compatible', 'leaf_only_missing_intermediate'];
  assert.ok(expected.every((c) => all.has(c)), [...all].join(', '));
  assert.deepEqual([...all].filter((c) => !doc.includes(`\`${c}\``)), []);
});

test('relative links in TROUBLESHOOTING.md resolve', () => {
  for (const [, target] of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target!) || target!.startsWith('#')) continue;
    assert.ok(existsSync(join(ROOT, 'docs', target!.split('#')[0]!)), target);
  }
});
