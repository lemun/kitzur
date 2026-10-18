import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test('README and the Windows admin guide name the Node versions CI runs', () => {
  const matrix = read('.github/workflows/ci.yml').match(/node: \[([^\]]+)\]/)?.[1] ?? '';
  const versions = matrix.split(',').map((v) => v.trim());
  assert.ok(versions.length >= 2, matrix);
  const phrase = `Node ${versions.slice(0, -1).join(', ')} and ${versions.at(-1)}`;
  assert.ok(read('README.md').includes(phrase), `README.md: ${phrase}`);
  assert.ok(read('deploy/windows/ADMIN.md').includes(phrase), `ADMIN.md: ${phrase}`);
});

test('security documentation discloses the per-request log line', () => {
  const doc = read('SECURITY.md');
  assert.doesNotMatch(doc, /no per-request log/i);
  assert.match(doc, /one content-free line per completed chat request/);
});

test('deployment docs send serving logs to the log file, not the journal', () => {
  for (const f of ['deploy/kitzur.service', 'deploy/README.md']) {
    const doc = read(f);
    assert.doesNotMatch(doc, /journalctl --user -u kitzur -f/, f);
    assert.match(doc, /\.local\/state\/kitzur\/logs\/kitzur-/, f);
  }
});

test('the README Linux unit takes its config the way deploy/kitzur.service does', () => {
  const unit = read('README.md').match(/```ini\n([\s\S]*?)```/)?.[1] ?? '';
  const line = 'Environment=KITZUR_CONFIG=%h/.config/kitzur/kitzur.jsonc';
  assert.ok(unit.includes(line), unit);
  assert.doesNotMatch(unit, /--config/);
  assert.ok(read('deploy/kitzur.service').includes(line));
});

test('the README status hint warns that --url skips the listen token', () => {
  const doc = read('README.md');
  assert.match(doc, /pass `-c FILE`/);
  assert.match(doc, /`--url[^`]*` skips the config, so it\s+sends no `listen\.token`/);
});

test('the README /status curl example carries the listen token', () => {
  const curl = read('README.md').match(/^curl .*\/status.*$/m)?.[0] ?? '';
  assert.match(curl, /-H 'Authorization: Bearer <listen\.token>'/, curl);
});

test('relative links in the public docs resolve', () => {
  for (const f of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'deploy/README.md', 'deploy/windows/ADMIN.md']) {
    for (const [, target] of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target!) || target!.startsWith('#')) continue;
      const path = target!.split('#')[0]!;
      assert.ok(existsSync(join(ROOT, dirname(f), path)), `${f}: ${target}`);
    }
  }
});
