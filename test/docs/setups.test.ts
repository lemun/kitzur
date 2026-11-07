import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.js';
import { USAGE } from '../../src/cli/usage.js';

const file = join(ROOT, 'docs/SETUPS.md');
const markdown = readFileSync(file, 'utf8');

test('setup guide relative links resolve to files and anchors', () => {
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!)) continue;
    const [path, hash] = target!.split('#');
    const resolved = join(dirname(file), decodeURIComponent(path!));
    assert.ok(existsSync(resolved), `SETUPS.md: ${target}`);
    if (hash) {
      const content = readFileSync(resolved, 'utf8');
      const slug = hash.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
      const headings = [...content.matchAll(/^#+\s+(.+?)\s*#*$/gm)].map(([, title]) => title!.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'));
      assert.ok(headings.includes(slug), `SETUPS.md anchor: ${target}`);
    }
  }
});

test('setup guide only names commands in CLI usage', () => {
  for (const [, command] of markdown.matchAll(/\bkitzur\s+([a-z][a-z-]*)/g)) {
    assert.match(USAGE, new RegExp(`^  ${command}(?:\\s|$)`, 'm'), `Unknown command: kitzur ${command}`);
  }
});
