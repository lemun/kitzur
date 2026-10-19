import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict'; import { test } from 'node:test';
test('first-success path precedes motivation and matches the 32k client budget', () => {
  const readme = readFileSync('README.md', 'utf8');
  const start = readme.indexOf('## Quick start'), motivation = readme.indexOf('## Why Kitzur');
  assert.ok(start > 0 && motivation > start); const setup = readme.slice(start, motivation);
  assert.match(setup, /config init --preset 32k/); assert.match(setup, /"context": 32000, "output": 8000/);
  assert.match(setup, /http:\/\/127\.0\.0\.1:8270\/v1/); assert.match(setup, /status --config/);
});
