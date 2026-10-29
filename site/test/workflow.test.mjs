// node --test test/workflow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

// The Pages deploy only runs on pushes touching its path filter, so every repo file the site renders must be in it.
test('the Pages workflow path filter covers every repo markdown the site renders', async () => {
  const workflow = await read('../.github/workflows/site.yml');
  const filters = [...workflow.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
  const covered = (file) => filters.some((f) => (f.endsWith('/**') ? file.startsWith(f.slice(0, -2)) : f === file));
  const docs = await read('src/content/repo-docs.ts');
  const files = [...docs.matchAll(/\bfile: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length > 0, 'repo-docs pages');
  assert.deepEqual(files.filter((f) => !covered(f)), []);
  assert.ok(covered('site/package.json'));
  assert.ok(covered('docs/assets/logo.svg'));
});

test('the Pages workflow builds site/ and deploys its dist', async () => {
  const workflow = await read('../.github/workflows/site.yml');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /working-directory: site/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run build/);
  assert.match(workflow, /actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: site\/dist/);
  assert.match(workflow, /actions\/deploy-pages@v\d+/);
});
