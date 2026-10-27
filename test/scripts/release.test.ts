import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const changelog = join(mkdtempSync(join(tmpdir(), 'kitzur-release-notes-')), 'CHANGELOG.md');
writeFileSync(changelog, `# Changelog

## [Unreleased]

## [3.0.0] — 2030-03-01

### Added

- Third release.

## [2.0.0] — 2030-02-01

- Second release.

## [1.5.0] — 2030-01-15

## 1.0.0 - 2030-01-01

Requires nothing.

- First release.
`);
const notes = (version: string) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-notes.mjs'), version, changelog], { encoding: 'utf8' });

test('release-notes.mjs prints the section for the version', () => {
  const cases: [string, string][] = [
    ['v3.0.0', '### Added\n\n- Third release.\n'],
    ['2.0.0', '- Second release.\n'],
    ['v1.0.0', 'Requires nothing.\n\n- First release.\n'],
  ];
  for (const [version, expected] of cases) {
    const res = notes(version);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, expected, version);
  }
});

test('release-notes.mjs exits 1 for a missing or empty section', () => {
  for (const version of ['v9.9.9', 'v1.5.0', 'Unreleased']) {
    const res = notes(version);
    assert.equal(res.status, 1, version);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /release-notes: /);
  }
});

test('release.yml only creates a draft and grants write access only to the draft job', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(!yml.includes('npm publish'), 'the workflow must not run npm publish');
  assert.match(yml, /gh release create [^\n]*--draft/);
  assert.doesNotMatch(yml, /--draft[= ]false|gh release edit/);
  // split into the part before the first job and one chunk per job (two-space indented keys under jobs:)
  const [head = '', body = ''] = yml.split(/^jobs:\n/m);
  const jobs = new Map(body.split(/^(?= {2}[\w-]+:)/m).map((chunk) => [chunk.match(/^ {2}([\w-]+):/)?.[1] ?? '', chunk]));
  assert.deepEqual([...jobs.keys()], ['verify', 'bundles', 'draft']);
  const writes = /:\s*write\b|write-all/;
  assert.doesNotMatch(head, writes, 'workflow-level permissions must be read-only');
  assert.match(head, /^permissions:\n {2}contents: read$/m);
  for (const [name, chunk] of jobs) {
    if (name === 'draft') assert.match(chunk, /permissions:\n\s+contents: write\n/);
    else assert.doesNotMatch(chunk, writes, name);
  }
});
