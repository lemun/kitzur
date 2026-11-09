import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const readme = read('README.md');
const proposal = read('docs/proposals/legacy-completions.md');
const leaves = Object.keys(DEFAULT_CONFIG.legacyCompletions);

test('the legacy completions proposal says option B is implemented', () => {
  const status = proposal.split('\n').find((l) => l.startsWith('Status:'))!;
  assert.match(status, /option B \(count only\) (are|is) implemented/);
});

test('README, CONFIG.md and the proposal name only legacyCompletions keys that exist', () => {
  for (const [name, text] of [['README.md', readme], ['CONFIG.md', read('CONFIG.md')], ['proposal', proposal]] as const) {
    const named = [...new Set([...text.matchAll(/`legacyCompletions\.([A-Za-z]+)`/g)].map((m) => m[1]!))];
    assert.ok(named.length > 0, `${name} names no legacyCompletions key`);
    for (const leaf of named) assert.ok(leaves.includes(leaf), `${name} names unknown key legacyCompletions.${leaf}`);
  }
});

test('JSON-OUTPUT.md lists both legacy completions counters', () => {
  const doc = read('docs/JSON-OUTPUT.md');
  for (const counter of ['legacy_completions', 'legacy_over_budget']) assert.ok(doc.includes(`\`counters.${counter}\``), counter);
});

test('README says legacy completions are counted', () => {
  const row = readme.split('\n').find((l) => l.startsWith('| `POST /v1/completions`'))!;
  assert.equal(row.split('|')[3]!.trim(), 'yes');
  assert.doesNotMatch(readme, /legacy[^.]*not counted/i);
});
