import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.js';

const file = join(ROOT, 'docs/RELEASING.md');
const markdown = readFileSync(file, 'utf8');
const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('release checklist relative links resolve', () => {
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!) || target!.startsWith('#')) continue;
    assert.ok(existsSync(join(dirname(file), decodeURIComponent(target!.split('#')[0]!))), `RELEASING.md: ${target}`);
  }
});

test('release checklist names only real npm scripts and repository paths', () => {
  for (const [, name] of markdown.matchAll(/\bnpm run ([\w:-]+)/g)) assert.ok(scripts[name!], `npm run ${name}`);
  for (const [path] of markdown.matchAll(/\b(?:scripts|deploy)\/[\w./-]*\w/g)) assert.ok(existsSync(join(ROOT, path)), path);
});

test('release checklist states the checks the release workflow enforces', () => {
  assert.match(markdown, /tag must equal `v` plus the package\.json version/);
  assert.match(markdown, /node scripts\/release-notes\.mjs v\d/);
  assert.match(markdown, /Nothing in the repository tags, publishes or releases by itself/);
});

test('release checklist runs tag, publish and release commands only as maintainer steps', () => {
  for (const [, before, block] of markdown.matchAll(/([^\n]*)\n```[^\n]*\n([\s\S]*?)```/g)) {
    if (/\b(git tag|npm publish|gh release create)\b/.test(block!)) assert.match(before!, /^Maintainer step:/, block);
  }
});

test('docs index links the release checklist', () => {
  assert.match(readFileSync(join(ROOT, 'docs/README.md'), 'utf8'), /Cut a release: \[[^\]]+\]\(RELEASING\.md\)/);
});
