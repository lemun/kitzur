import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const HEADING = '## My gateway answers 429 or 503';
const doc = read('docs/TROUBLESHOOTING.md');
const section = doc.includes(HEADING) ? doc.slice(doc.indexOf(HEADING)).split(/\n## /)[0]! : '';
const leaves = Object.keys(DEFAULT_CONFIG.upstream.retry).map((k) => `upstream.retry.${k}`);
// GitHub-style heading anchors of a Markdown file.
const anchors = (f: string) => [...read(f).matchAll(/^#+ (.+)$/gm)]
  .map((m) => m[1]!.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-'));

test('TROUBLESHOOTING.md has the 429/503 section', () => {
  assert.ok(doc.includes(`\n${HEADING}\n`));
});

test('the section names only upstream.retry keys that exist', () => {
  const named = [...new Set([...section.matchAll(/`(upstream\.retry\.[A-Za-z]+)`/g)].map((m) => m[1]!))];
  assert.ok(named.length > 0);
  for (const key of named) assert.ok(leaves.includes(key), `unknown key ${key}`);
});

test('the transient_retries fields the section names are documented in JSON-OUTPUT.md', () => {
  const statusLine = section.split('\n').find((l) => l.includes('kitzur status')) ?? '';
  const fields = [...statusLine.matchAll(/`(\w+)` \(/g)].map((m) => m[1]!);
  assert.deepEqual(fields, ['retries', 'by_status', 'delay_ms', 'exhausted']);
  const json = read('docs/JSON-OUTPUT.md');
  for (const f of fields) assert.ok(json.includes(`\`${f}\``), f);
});

test('the section links CONFIG.md and README.md anchors that exist', () => {
  const links = [...section.matchAll(/\]\(\.\.\/(CONFIG|README)\.md#([\w-]+)\)/g)];
  assert.deepEqual(links.map((m) => m[1]).sort(), ['CONFIG', 'README']);
  for (const [, file, anchor] of links) assert.ok(anchors(`${file}.md`).includes(anchor!), `${file}.md#${anchor}`);
});

test('the section says kitzur report shows the transientRetries totals', () => {
  assert.ok(section.includes('`kitzur report`') && section.includes('`transientRetries`'));
  assert.ok(!section.includes('does not show them'));
});

test('DIAGNOSTICS.md describes transientRetries', () => {
  assert.ok(read('docs/DIAGNOSTICS.md').includes('`transientRetries`'));
});
