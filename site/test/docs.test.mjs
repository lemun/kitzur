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

const pages = {
  'docs/': 'docs/README.md',
  'docs/configuration/': 'CONFIG.md',
  'docs/design/': 'DESIGN.md',
  'docs/deployment/': 'deploy/README.md',
  'docs/diagnostics/': 'docs/DIAGNOSTICS.md',
  'docs/troubleshooting/': 'docs/TROUBLESHOOTING.md',
  'docs/upstream-rotation/': 'docs/UPSTREAM-ROTATION.md',
  'docs/gobstopper-interop/': 'docs/GOBSTOPPER-INTEROP.md',
  'docs/security/': 'SECURITY.md',
  'docs/benchmarks/': 'bench/README.md',
  'docs/changelog/': 'CHANGELOG.md',
};

test('troubleshooting, upstream rotation, Gobstopper interop and the changelog are docs pages', async () => {
  assert.match(await page('docs/troubleshooting/'), /<h1[^>]*>Troubleshooting<\/h1>/);
  assert.match(await page('docs/upstream-rotation/'), /<h1[^>]*>Rotating gateway keys<\/h1>/);
  assert.match(await page('docs/gobstopper-interop/'), /<h1[^>]*>Gobstopper legacy stats interop<\/h1>/);
  assert.match(await page('docs/changelog/'), /<h1[^>]*>Changelog<\/h1>/);
  assert.match(await page('docs/'), /href="\/kitzur\/docs\/troubleshooting\/"/);
});

test('no docs page links to GitHub for a file that has a page', async () => {
  for (const route of Object.keys(pages)) {
    const html = await page(route);
    for (const file of Object.values(pages)) {
      assert.ok(!html.includes(`href="https://github.com/lemun/kitzur/blob/main/${file}`), `${route} links to ${file} on GitHub`);
    }
  }
});

test('the troubleshooting page has every section of docs/TROUBLESHOOTING.md', async () => {
  const md = await readFile(new URL('../../docs/TROUBLESHOOTING.md', import.meta.url), 'utf8');
  const html = await page('docs/troubleshooting/');
  const h2s = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.ok(h2s.length > 0);
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const h2 of h2s) assert.ok(html.includes(`>${escape(h2)}</h2>`), `missing section: ${h2}`);
});
