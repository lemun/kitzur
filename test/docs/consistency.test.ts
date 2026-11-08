import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { USAGE } from '../../src/cli/usage.js';

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const { engines } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('README Node badge and requirements match package.json engines.node', () => {
  const minimum = /^>=(\d+)$/.exec(engines.node)?.[1];
  assert.ok(minimum, `Unsupported Node engine range: ${engines.node}`);
  const badgeVersion = `≥${minimum}`;
  assert.ok(readme.includes(
    `[![Node.js ${badgeVersion}](https://img.shields.io/badge/node-${encodeURIComponent(badgeVersion)}-brightgreen)](package.json)`,
  ), `README Node badge must match engines.node ${engines.node}`);
  const requirements = [...readme.matchAll(/Node\.js (\d+)\+/g)];
  assert.ok(requirements.length > 0, 'README must state a Node.js requirement');
  for (const [, version] of requirements) {
    assert.equal(version, minimum, `README Node.js ${version}+ must match ${engines.node}`);
  }
});

test('README relative links resolve to existing files', () => {
  for (const [, target] of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!) || target!.startsWith('#')) continue;
    const path = decodeURIComponent(target!.split(/[?#]/)[0]!);
    assert.ok(existsSync(join(ROOT, path)), `README.md: ${target}`);
  }
});

test('README Commands block lists every command in kitzur --help', () => {
  const block = /### Commands[\s\S]*?```text\n([\s\S]*?)```/.exec(readme)?.[1];
  assert.ok(block, 'README must have a Commands text block');
  const commands = USAGE.split('\n\n')[1]!.split('\n').flatMap((l) => {
    const m = /^ {2}(\S+)(?: (init|show|validate|import-eval|export-opencode)\b)?/.exec(l);
    return m ? [m[2] ? `${m[1]} ${m[2]}` : m[1]!] : [];
  });
  for (const cmd of new Set([...commands, 'help'])) {
    const [name, sub] = cmd.split(' ');
    const re = new RegExp(sub ? `^kitzur ${name} \\S*\\b${sub}\\b` : `^kitzur ${name}\\b`, 'm');
    assert.match(block, re, `README Commands block must list kitzur ${cmd}`);
  }
});

test('docs index routes common tasks', () => assert.match(readFileSync(join(ROOT, 'docs/README.md'), 'utf8'), /OpenCode.*offline.*diagnostics.*retention/s));
