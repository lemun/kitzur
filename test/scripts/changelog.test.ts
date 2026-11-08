import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

test('the drafted Unreleased section prints as Added, Changed and Fixed bullet lists', () => {
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-notes.mjs'), 'Unreleased', join(ROOT, 'CHANGELOG.md')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  // one chunk per "### " subsection; the notes start with the first heading
  const [before = '', ...sections] = res.stdout.split(/^### /m);
  assert.equal(before, '');
  assert.deepEqual(sections.map((s) => s.slice(0, s.indexOf('\n'))), ['Added', 'Changed', 'Fixed']);
  for (const section of sections) {
    const [name, ...rest] = section.trimEnd().split('\n');
    assert.equal(rest[0], '', name);
    const body = rest.slice(1);
    assert.ok(body.length > 0, `${name} is empty`);
    // a single list: every line opens a bullet or continues one, with no blank lines in between
    for (const line of body) assert.match(line, /^(- |  \S)/, `${name}: ${JSON.stringify(line)}`);
  }
});

test('the Unreleased section mentions the CLI, proxy and docs changes merged after the 0.2.1 tag', () => {
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-notes.mjs'), 'Unreleased', join(ROOT, 'CHANGELOG.md')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  for (const needle of ['kitzur help', 'docs/CLIENTS.md', 'Proxy-Authorization', 'log.directory', '--drain-ms', 'verify-bundle']) {
    assert.ok(res.stdout.includes(needle), `Unreleased does not mention ${needle}`);
  }
});
