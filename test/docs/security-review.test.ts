import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ROOT } from '../helpers.js';

const DOC = 'docs/SECURITY-REVIEW.md';
const doc = readFileSync(join(ROOT, DOC), 'utf8');
const TABLE = '## Modules that can reach the network or start processes';
const MODULES = 'http|https|net|tls|dns|dgram|child_process';
const IMPORT = new RegExp(`^\\s*import\\s+[^;]*?\\bfrom\\s+['"](?:node:)?(${MODULES})['"]|\\b(?:import|require)\\(\\s*['"](?:node:)?(${MODULES})['"]`, 'gm');
const FETCH = /(?<![\w.$])fetch\s*\(|globalThis\.fetch\b/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

/** GitHub heading anchors of a markdown file. */
function anchors(file: string): Set<string> {
  return new Set([...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, h]) =>
    h!.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-')));
}

test('the module table lists exactly the src/ files that can reach the network or start processes', () => {
  const found = new Set<string>();
  for (const file of tsFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    if ([...text.matchAll(IMPORT)].length || FETCH.test(text)) found.add(relative(ROOT, file).replaceAll('\\', '/'));
  }
  const section = doc.slice(doc.indexOf(TABLE));
  const listed = new Set([...section.matchAll(/^\| `(src\/[^`]+\.ts)`/gm)].map(([, f]) => f!));
  for (const f of found) assert.ok(listed.has(f), `${f} can reach the network or start processes: add it to the table in ${DOC}`);
  for (const f of listed) assert.ok(found.has(f), `${f} no longer imports a network or process module: remove it from the table in ${DOC}`);
});

// Calls that open an outbound connection, in files that import a network module (or call fetch).
const NET_IMPORT = /\bfrom\s+['"](?:node:)?(?:http|https|net|tls|dns|dgram)['"]/;
const OUTBOUND = /(?:\b(?:lib|mod|http|https|net|tls|dns|dgram)\.(?:request|get|connect|createConnection|createSocket|lookup|resolve\w*)|(?<![\w.$])(?:request|get|connect|createConnection|fetch))\s*\(/g;

test('the outbound table names every exported entry point that opens a connection', () => {
  const table = doc.slice(doc.indexOf('| Command | Trigger |'), doc.indexOf('\n\n', doc.indexOf('| Command | Trigger |')));
  const entries = new Set([...table.matchAll(/\| `(\w+)` \|$/gm)].map(([, e]) => e!));
  const found = new Map<string, string>();
  for (const file of tsFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    if (!NET_IMPORT.test(text) && !FETCH.test(text)) continue;
    for (const m of text.matchAll(OUTBOUND)) {
      const before = text.slice(0, m.index);
      const name = [...before.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+(\w+)/gm)].pop()?.[1] ?? '(not exported)';
      found.set(name, `${relative(ROOT, file).replaceAll('\\', '/')}:${before.split('\n').length}`);
    }
  }
  assert.ok(found.size > 0, 'no outbound calls found: the scan is broken');
  for (const [name, at] of found) assert.ok(entries.has(name), `${at} opens a connection from ${name}: add the commands that reach it to the outbound table in ${DOC}`);
  for (const e of entries) assert.ok(found.has(e), `${e} no longer opens a connection: update the outbound table in ${DOC}`);
});

test('every repo path and anchor the checklist links to exists', () => {
  for (const [, target] of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!)) continue;
    const [path, anchor] = target!.split('#');
    const file = path ? join(ROOT, dirname(DOC), path) : join(ROOT, DOC);
    assert.ok(existsSync(file), `${DOC}: ${target} does not exist`);
    if (anchor) assert.ok(anchors(file).has(anchor), `${DOC}: no heading for #${anchor} in ${path || DOC}`);
  }
});

test('the checklist has every review section', () => {
  for (const h of ['Provenance and integrity', 'Network behaviour', 'Credentials', 'Data at rest', 'Process behaviour',
    'Windows specifics', 'What Kitzur does not do', TABLE.slice(3)]) {
    assert.match(doc, new RegExp(`^## ${h}$`, 'm'), `${DOC} is missing the "${h}" section`);
  }
});

test('the checklist names no internal hostnames or emails', () => {
  assert.doesNotMatch(doc, /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|lan|intranet)\b/i);
  assert.doesNotMatch(doc, /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/);
});
