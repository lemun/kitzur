// Run after `npm run build`: node --test test/home.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);

test('home page carries the hero, diagram, labelled demo and evidence limits', async () => {
  const html = await readFile(new URL('index.html', dist), 'utf8');
  assert.match(html, /<h1[^>]*>Keep coding in the context window your local model actually serves<\/h1>/);
  assert.match(html, /<img[^>]+src="\/kitzur\/_astro\/how-it-works\.[^"]+\.svg"/);
  assert.match(html, /<img[^>]+src="\/kitzur\/_astro\/how-it-works-dark\.[^"]+\.svg"/);
  const video = /<video[^>]+src="\/kitzur\/(_astro\/compaction\.[^"]+\.mp4)"/.exec(html);
  assert.ok(video, 'demo video');
  assert.ok((await stat(new URL(video[1], dist))).size > 0);
  assert.match(html, /stub upstream, not a model/);
  assert.match(html, /not a live model solving a task/);
  assert.match(html, /OpenAI Chat Completions only/);
  assert.match(html, /href="\/kitzur\/docs\/deployment\/"/);
});

test('home page JSON-LD is a SoftwareApplication without ratings', async () => {
  const html = await readFile(new URL('index.html', dist), 'utf8');
  const script = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html);
  assert.ok(script, 'JSON-LD script');
  const data = JSON.parse(script[1]);
  assert.equal(data['@type'], 'SoftwareApplication');
  assert.equal(data.url, 'https://lemun.github.io/kitzur/');
  assert.equal(data.aggregateRating, undefined);
  assert.equal(data.review, undefined);
  assert.equal(data.offers, undefined);
});
