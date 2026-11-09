import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const changelog = read('CHANGELOG.md');
const unreleased = changelog.split('## [Unreleased]')[1]!.split(/^## \[/m)[0]!;
const draft = read('docs/community/RELEASE-NOTES-0.3.0-DRAFT.md');
const config = read('CONFIG.md');

test('the Unreleased section describes the retry of listed paths, the retry totals, legacy completions counting and the status lines', () => {
  for (const needle of ['retry.paths', 'transient_retries', 'legacyCompletions.count', 'x-kitzur-tokens', 'flaky-gateway-retry', 'Legacy completions']) {
    assert.ok(unreleased.includes(needle), `Unreleased does not mention ${needle}`);
  }
});

test('the 0.3.0 release notes draft describes the retry of listed paths, the retry totals and legacy completions', () => {
  for (const needle of ['retry.paths', 'legacyCompletions', 'transient_retries']) {
    assert.ok(draft.includes(needle), `the draft does not mention ${needle}`);
  }
});

test('every retry or legacy completions config key named in the Unreleased section or the draft is in CONFIG.md', () => {
  const keys = [...`${unreleased}\n${draft}`.matchAll(/`((?:upstream\.retry|legacyCompletions)\.[A-Za-z.]+)`/g)].map((m) => m[1]!);
  assert.ok(keys.length >= 4, keys.join(', '));
  for (const key of new Set(keys)) assert.ok(config.includes(`\`${key}\``), `CONFIG.md does not name ${key}`);
});
