import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

test('external rotation guide is discoverable and preserves the recovery contract', () => {
  for (const file of ['README.md', 'CONFIG.md']) {
    assert.match(readFileSync(join(ROOT, file), 'utf8'), /\]\(docs\/UPSTREAM-ROTATION\.md\)/);
  }
  const guide = readFileSync(join(ROOT, 'docs/UPSTREAM-ROTATION.md'), 'utf8');
  for (const term of ['400', '429', '403', 'listen.token', 'upstream.timeoutMs', 'cooldown_time', 'authorized', 'shared']) assert.ok(guide.includes(term), term);
});
