import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.js';
import { USAGE } from '../../src/cli/usage.js';

const file = join(ROOT, 'docs/community/RELEASE-NOTES-0.3.0-DRAFT.md');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const { version } = JSON.parse(read('package.json')) as { version: string };
// Once the version moves past 0.2.1 the draft has been published or replaced; its checks no longer apply.
const skip = version === '0.2.1' ? false : `package.json is ${version}, not 0.2.1: the 0.3.0 release notes draft is no longer checked`;
const markdown = existsSync(file) ? readFileSync(file, 'utf8') : '';
// Inline code spans outside fenced blocks.
const spans = [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

test('release notes draft exists and starts with a DRAFT marker line', { skip }, () => {
  assert.ok(existsSync(file), file);
  assert.match(markdown.split('\n')[0]!, /^\*\*DRAFT\*\*/);
});

test('release notes draft has the required headings in order', { skip }, () => {
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
  assert.deepEqual(headings, ['Summary', 'Highlights', 'Upgrade notes', 'Install and verify', 'Known limitations', 'Thanks and links']);
  const highlights = markdown.split('## Highlights')[1]!.split('\n## ')[0]!.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(highlights.length >= 1 && highlights.length <= 6, `${highlights.length} highlights`);
});

test('release notes draft only names kitzur commands and flags that exist', { skip }, () => {
  const config = read('CONFIG.md');
  for (const span of spans.filter((s) => /^(kitzur\s|-)/.test(s))) {
    const command = /^kitzur\s+([a-z][a-z-]*)/.exec(span)?.[1];
    if (command) assert.match(USAGE, new RegExp(`^  ${command}(?:\\s|$)`, 'm'), `Unknown command: ${span}`);
    for (const [flag] of span.matchAll(/--[a-z][a-z-]*/g)) {
      assert.ok(USAGE.includes(flag) || config.includes(flag), `Unknown flag ${flag} in \`${span}\``);
    }
  }
});

test('release notes draft names only files that exist and resolves its links', { skip }, () => {
  if (spans.some((s) => s.includes('verify-bundle.mjs'))) assert.ok(existsSync(join(ROOT, 'deploy/verify-bundle.mjs')));
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!)) continue;
    assert.ok(existsSync(join(dirname(file), target!.split('#')[0]!)), target);
  }
});

test('release notes draft carries no internal hosts, emails, ids or tooling wording', { skip }, () => {
  assert.doesNotMatch(markdown, /\b[a-z0-9-]+\.(?:internal|corp|lan|intranet)\b/i);
  assert.doesNotMatch(markdown, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}\b/);
  assert.doesNotMatch(markdown, /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/);
  assert.doesNotMatch(markdown, /\b(mill|factory|coordinator|worker|unit id|attempt)\b/i);
});

test('the draft is not linked from the docs index', { skip }, () => {
  assert.doesNotMatch(read('docs/README.md'), /RELEASE-NOTES-0\.3\.0/);
});
