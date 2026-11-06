import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RetentionAttribution } from '../../src/engine/contracts.js';
import { renderRetention } from '../../src/cli/explain.js';

const item = (overrides: Partial<RetentionAttribution> = {}): RetentionAttribution => ({
  category: 'user', sources: [{ kind: 'message', messageIndex: 0 }], disposition: 'summarized',
  reason: 'user-instruction', supersededBy: [], ...overrides,
});

test('renderRetention: empty array', () => {
  assert.equal(renderRetention([]), 'retention: 0 summarized, 0 dropped');
});

test('renderRetention: all summarized', () => {
  assert.equal(renderRetention([item()]), [
    'retention: 1 summarized, 0 dropped',
    'category    reason             summarized  dropped',
    'user        user-instruction            1       0',
    '  user | summarized | user-instruction | message[0]',
  ].join('\n'));
});

test('renderRetention: mixed outcomes include supersession and signal labels', () => {
  const rows = [
    item({ category: 'decision', sources: [{ kind: 'tool-call', messageIndex: 2, callIndex: 1 }], supersededBy: [7], signals: ['referenced', 'recent'] }),
    item({ category: 'rest', disposition: 'dropped', reason: 'budget-eviction', sources: [{ kind: 'tool-result', messageIndex: 4, call: { messageIndex: 3, callIndex: 0 } }] }),
  ];
  assert.equal(renderRetention(rows), [
    'retention: 1 summarized, 1 dropped',
    'category    reason             summarized  dropped',
    'decision    user-instruction            1       0',
    'rest        budget-eviction             0       1',
    '  decision | summarized | user-instruction | tool-call[2:1] | superseded by 7 | signals referenced, recent',
    '  rest | dropped | budget-eviction | tool-result[4] from tool-call[3:0]',
  ].join('\n'));
});

test('renderRetention: truncates at the requested limit', () => {
  assert.equal(renderRetention([item(), item({ category: 'todo' })], { limit: 1 }).split('\n').slice(-2).join('\n'), [
    '  user | summarized | user-instruction | message[0]',
    '... and 1 more (use --explain-limit 0)',
  ].join('\n'));
});

test('renderRetention: zero limit shows all details', () => {
  assert.equal(renderRetention([item(), item({ category: 'todo' })], { limit: 0 }).split('\n').slice(-2).join('\n'), [
    '  user | summarized | user-instruction | message[0]',
    '  todo | summarized | user-instruction | message[0]',
  ].join('\n'));
});

test('renderRetention: ignores fields outside the typed attribution contract', () => {
  const withCanary = { ...item(), messageText: 'CANARY_PRIVATE_MESSAGE' } as RetentionAttribution;
  assert.ok(!renderRetention([withCanary]).includes('CANARY_PRIVATE_MESSAGE'));
});
