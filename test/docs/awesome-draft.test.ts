import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

test('awesome-list draft entries are ready to paste and the file remains unsubmitted', () => {
  const draft = readFileSync(join(ROOT, 'docs/community/AWESOME-LISTS-DRAFT.md'), 'utf8');
  assert.match(draft, /draft/i);
  assert.match(draft, /nothing has been submitted/i);
  const entries = draft.split('\n').filter((line) => line.startsWith('- [Kitzur]'));
  assert.equal(entries.length, 5);
  for (const line of entries) {
    assert.match(line, /^- \[Kitzur\]\(https:\/\/github\.com\/lemun\/kitzur\) - .+\.$/);
    assert.ok(line.length < 120, `${line.length} characters: ${line}`);
    assert.equal(line.match(/https:\/\/github\.com\/lemun\/kitzur/g)?.length, 1);
    assert.doesNotMatch(line, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(line, /\b(revolutionary|blazing|game-changing|seamless|supercharge)\b/i);
  }
});
