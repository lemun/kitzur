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
  assert.match(html, /Reviewed October 28, 2026/);
  assert.match(html, /Native client compaction/);
  assert.match(html, /Gobstopper v0\.8\.10 \(snapshot 2026-10-19\)/);
  assert.doesNotMatch(html, /not compared yet/);
  assert.equal((html.match(/Native client compaction \(OpenCode\): only the rows its configuration docs state are filled \(when it compacts, large tool output, what is configurable; page as read on 2026-10-28\)/g) ?? []).length, 1);
  const cited = new Set([...html.matchAll(/\[(\d+)\]/g)].map((m) => m[1]));
  const listed = new Set([...html.matchAll(/<li id="source-(\d+)"><a href="https:\/\//g)].map((m) => m[1]));
  assert.ok(cited.size > 0);
  assert.deepEqual([...cited].filter((n) => !listed.has(n)), []);
  assert.deepEqual([...listed].filter((n) => !cited.has(n)), []);
});

test('compare page marks uncompared cells, pins Gobstopper sources and labels Terminal-Bench as Gobstopper’s own', async () => {
  const html = await page('compare/');
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [
    m[1].match(/<th scope="row">([\s\S]*?)<\/th>/)?.[1].trim(),
    [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1].trim()),
  ]);
  const body = rows.filter(([, cells]) => cells.length);
  assert.ok(body.length > 0);
  // OpenCode cells come only from its config docs, source 12; every other row stays uncompared.
  const filled = {
    'When it compacts': /<code>auto<\/code>.*default <code>true<\/code>/,
    'Large tool output': /<code>prune<\/code>.*default <code>false<\/code>/,
    'What is configurable': /<code>reserved<\/code>/,
  };
  for (const [name, cells] of body) {
    if (filled[name]) {
      assert.match(cells[1], filled[name], name);
      assert.match(cells[1], /<sup>\[12\]<\/sup>$/, name);
    } else assert.equal(cells[1], 'Not compared', name);
  }
  assert.deepEqual(Object.keys(filled).filter((name) => !body.some(([n]) => n === name)), []);
  assert.match(html, /<li id="source-12"><a href="https:\/\/opencode\.ai\/docs\/config\/#compaction">OpenCode config docs, Compaction \(page as read on 2026-10-28\)<\/a><\/li>/);
  assert.equal(html.match(/\[12\]/g).length, 3);
  assert.doesNotMatch(html, /<td>—<\/td>/);
  const gobstopper = [...html.matchAll(/href="(https:\/\/github\.com\/hraness\/gobstopper\/blob\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(gobstopper.length > 0);
  assert.deepEqual(gobstopper.filter((href) => !href.includes('/blob/1aa71294f35d07ff81c82a7e133d0c2a3a220939/')), []);
  assert.match(html, /Gobstopper’s own Terminal-Bench 2\.1 result for v0\.7\.2/);
  assert.match(html, /Kitzur has no Terminal-Bench run/);
  assert.match(html, /61 tasks solved with Gobstopper vs 60 without, and 84\.3M input tokens with Gobstopper vs 118\.6M without/);
});
