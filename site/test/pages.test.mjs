// Run after `npm run build`: node --test test/pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = (route) => readFile(new URL(`../dist/${route}index.html`, import.meta.url), 'utf8');

test('benchmarks page separates demo, replay and coding harness and says live validation is pending', async () => {
  const html = await page('benchmarks/');
  assert.match(html, /<h1[^>]*>Benchmarks<\/h1>/);
  assert.match(html, /pending live validation/);
  assert.match(html, /Demo recording/);
  assert.match(html, /kitzur replay/);
  assert.match(html, /Coding harness/);
  assert.match(html, /<h2[^>]*id="limits"/);
  assert.match(html, /href="https:\/\/github\.com\/lemun\/kitzur\/blob\/main\/bench\/examples\/readme-qa46\.json"/);
});

test('compare page is dated and every citation resolves to a listed source', async () => {
  const html = await page('compare/');
  assert.match(html, /<h1[^>]*>Compare<\/h1>/);
  assert.match(html, /Reviewed October 27, 2026/);
  assert.match(html, /Native client compaction/);
  assert.match(html, /Gobstopper v0\.8\.10 \(snapshot 2026-10-19\)/);
  assert.match(html, /Native client compaction \(OpenCode\): not compared yet \(2026-10-27\)/);
  assert.equal((html.match(/Native client compaction \(OpenCode\): not compared yet \(2026-10-27\)/g) ?? []).length, 1);
  const cited = new Set([...html.matchAll(/\[(\d+)\]/g)].map((m) => m[1]));
  const listed = new Set([...html.matchAll(/<li id="source-(\d+)"><a href="https:\/\/github\.com\//g)].map((m) => m[1]));
  assert.ok(cited.size > 0);
  assert.deepEqual([...cited].filter((n) => !listed.has(n)), []);
  assert.deepEqual([...listed].filter((n) => !cited.has(n)), []);
});
