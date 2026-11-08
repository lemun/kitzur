import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.js';
import { USAGE } from '../../src/cli/usage.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';

const file = join(ROOT, 'docs/CLIENTS.md');
const markdown = readFileSync(file, 'utf8');
const slug = (s: string) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

test('client guide relative links resolve to files and anchors', () => {
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!)) continue;
    const [path, hash] = target!.split('#');
    const resolved = join(dirname(file), decodeURIComponent(path!));
    assert.ok(existsSync(resolved), `CLIENTS.md: ${target}`);
    if (hash) {
      const headings = [...readFileSync(resolved, 'utf8').matchAll(/^#+\s+(.+?)\s*#*$/gm)].map(([, title]) => slug(title!));
      assert.ok(headings.includes(slug(hash)), `CLIENTS.md anchor: ${target}`);
    }
  }
});

test('client guide only names commands in CLI usage', () => {
  for (const [, command] of markdown.matchAll(/\bkitzur\s+([a-z][a-z-]*)/g)) {
    assert.match(USAGE, new RegExp(`^  ${command}(?:\\s|$)`, 'm'), `Unknown command: kitzur ${command}`);
  }
});

test('client guide only names doctor codes from TROUBLESHOOTING.md', () => {
  const troubleshooting = readFileSync(join(ROOT, 'docs/TROUBLESHOOTING.md'), 'utf8');
  const rows = [...markdown.matchAll(/^\|[^|\n]+\|([^|\n]+)\|[^|\n]+\|$/gm)].map(([, codes]) => codes!).filter((c) => c.includes('`'));
  assert.ok(rows.length > 0, 'CLIENTS.md must have a troubleshooting table');
  for (const codes of rows) {
    for (const [code] of codes.matchAll(/`[^`]+`/g)) assert.ok(troubleshooting.includes(code), `Unknown doctor code: ${code}`);
  }
});

test('client guide uses the default listen port', () => {
  assert.ok(markdown.includes(`http://127.0.0.1:${DEFAULT_CONFIG.listen.port}/v1`), `CLIENTS.md must name port ${DEFAULT_CONFIG.listen.port}`);
});
