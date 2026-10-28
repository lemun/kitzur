// Run after `npm run build`: node --test test/docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = (route) => readFile(new URL(`../dist/${route}index.html`, import.meta.url), 'utf8');

test('quick start and security are built from the repo markdown', async () => {
  assert.match(await page('docs/quick-start/'), /Point your agent at the proxy/);
  assert.match(await page('docs/security/'), /<h1[^>]*>Security: what kitzur sees, stores and logs<\/h1>/);
});

test('relative repo links are rewritten to site routes or GitHub', async () => {
  const index = await page('docs/');
  assert.match(index, /href="\/kitzur\/docs\/quick-start\/"/);
  assert.match(index, /href="\/kitzur\/docs\/security\/"/);
  assert.match(index, /href="\/kitzur\/docs\/design\/#mechanical-summary"/);
  const quick = await page('docs/quick-start/');
  assert.match(quick, /src="https:\/\/raw\.githubusercontent\.com\/lemun\/kitzur\/main\/docs\/assets\/quickstart\.gif"/);
  assert.match(quick, /href="\/kitzur\/docs\/deployment\/"/);
  assert.doesNotMatch(quick, /href="[^"]*\.md[#"]/);
});
