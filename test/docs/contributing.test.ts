import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const doc = read('CONTRIBUTING.md');
const pkg = JSON.parse(read('package.json')) as { engines: { node: string }; scripts: Record<string, string> };

test('CONTRIBUTING.md names the Node major from engines.node and the CI matrix', () => {
  const major = doc.match(/Node\.js (\d+) or newer/)?.[1];
  assert.equal(major, pkg.engines.node.match(/\d+/)?.[0], pkg.engines.node);
  const matrix = read('.github/workflows/ci.yml').match(/node: \[([^\]]+)\]/)?.[1] ?? '';
  assert.ok(matrix.split(',').map((v) => v.trim()).includes(major!), matrix);
});

test('CONTRIBUTING.md names scripts, npm scripts and symbols that exist', () => {
  for (const [, s] of doc.matchAll(/npm (?:run )?(\w+)/g)) {
    if (s !== 'ci') assert.ok(s! in pkg.scripts, `npm script ${s}`);
  }
  const paths = [...doc.matchAll(/scripts\/[\w.-]+/g)].map((m) => m[0]);
  assert.ok(paths.length >= 2, paths.join());
  for (const p of paths) assert.ok(existsSync(join(ROOT, p)), p);
  assert.match(doc, /ENGINE_ALGO_VERSION/);
  assert.match(read('src/types.ts'), /export const ENGINE_ALGO_VERSION\b/);
  assert.match(doc, /KITZUR_TOKENIZER_OPTIONAL=1/);
  assert.match(read('scripts/fetch-tokenizer.sh'), /KITZUR_TOKENIZER_OPTIONAL/);
  assert.match(doc, /CHANGELOG\.md/);
  assert.match(doc, /\[Unreleased\]/);
});

test('the single-test-file command in CONTRIBUTING.md names a built test file', () => {
  const file = doc.match(/node --test (dist\/test\/\S+\.test\.js)/)?.[1];
  assert.ok(file, 'no node --test dist/test/... command');
  assert.ok(existsSync(join(ROOT, file)), file);
});
