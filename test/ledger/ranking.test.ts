// ledger.ranking: off, the ledger is exactly today's; on, items inside a category are ordered by duplicates,
// error results, later references and recency, with categories (the floor) and call/result pairing unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import { buildLedger, CATEGORY_ORDER, compareItems, FLOOR_CATEGORIES, type Ledger } from '../../src/engine/ledger/index.js';
import { createExtractor, type MessageFacts } from '../../src/engine/ledger/extract.js';
import { supersedeRules } from '../../src/engine/ledger/supersede.js';
import { createToolRulesExt } from '../../src/engine/rules/index.js';
import { call, cfg, resetIds, sys, unit, user } from './fixtures.js';

function ledger(messages: ChatMessage[], ranking: boolean): Ledger {
  const c = cfg();
  c.ledger.ranking = ranking;
  const extractor = createExtractor(c, createToolRulesExt(c));
  const facts = (i: number, tc: ToolCall | null): MessageFacts => {
    const m = messages[i]!;
    if (m.role === 'assistant') return extractor.assistant(m);
    if (m.role === 'user') return extractor.user(m);
    if (m.role === 'system' || m.role === 'developer') return { kind: 'other' };
    return extractor.result(m, tc);
  };
  return buildLedger({ messages, hEnd: 1, cut: messages.length }, c, extractor, supersedeRules(c.ledger), facts);
}

/** Ids of one category in eviction order (kept longest first). */
const order = (L: Ledger, category: string): string[] => L.items.filter((i) => i.category === category).sort(compareItems).map((i) => i.id);

/** sys, user, then one single-call unit per [tool, args, result] (unit k's assistant is message 2 + 2k). */
function session(steps: Array<[string, unknown, string]>): ChatMessage[] {
  resetIds();
  return [sys(), user('Fix the checkout specs.'), ...steps.flatMap(([name, args, out]) => unit('', [[call(name, args), out]]))];
}

const MIXED = (): ChatMessage[] => [
  ...session([
    ['bash', { command: 'npm test' }, 'Error: 3 specs failed'],
    ['read', { filePath: 'src/a.ts' }, 'export const a = 1;'],
    ['read', { filePath: 'src/b.ts' }, 'export const b = 2;'],
    ['edit', { filePath: 'src/a.ts', oldString: '1', newString: '2' }, 'Edit applied successfully.'],
  ]),
  ...unit('DECISION: keep the retry helper.\nNOTE: staging-3 is slow.', [[call('bash', { command: 'ls' }), 'src test']]),
];

test('flag off (the default): ranks as assigned, tool log newest first', () => {
  const msgs = MIXED();
  const off = ledger(msgs, false);
  assert.equal(cfg().ledger.ranking, false);
  assert.deepEqual(order(off, 'toolLog'), ['g:10:0', 'g:8:0', 'g:6:0', 'g:4:0', 'g:2:0']);
  assert.deepEqual(off.items.find((i) => i.id === 'g:2:0')!.rank, [-2, 0]);
  assert.deepEqual(off.items.find((i) => i.id === 'f:src/a.ts')!.rank, [1, -8, 4, 0]);
});

test('flag on: an error result is kept longer than newer clean calls', () => {
  const msgs = session([
    ['bash', { command: 'npm test' }, 'Error: 3 specs failed'],
    ['bash', { command: 'ls' }, 'src test'],
    ['bash', { command: 'pwd' }, '/repo'],
  ]);
  assert.deepEqual(order(ledger(msgs, false), 'toolLog'), ['g:6:0', 'g:4:0', 'g:2:0']);
  assert.deepEqual(order(ledger(msgs, true), 'toolLog'), ['g:2:0', 'g:6:0', 'g:4:0']);
});

test('flag on: a "0 failed" tally is not an error', () => {
  const msgs = session([
    ['bash', { command: 'npm run lint' }, '12 passed, 0 failed'],
    ['bash', { command: 'ls' }, 'src test'],
  ]);
  assert.deepEqual(order(ledger(msgs, true), 'toolLog'), ['g:4:0', 'g:2:0']);
});

test('flag on: a call whose file is referenced later is kept longer', () => {
  const msgs = session([
    ['read', { filePath: 'src/a.ts' }, 'export const a = 1;'],
    ['read', { filePath: 'src/b.ts' }, 'export const b = 2;'],
    ['edit', { filePath: './src/a.ts', oldString: '1', newString: '2' }, 'Edit applied successfully.'],
  ]);
  assert.deepEqual(order(ledger(msgs, false), 'toolLog'), ['g:6:0', 'g:4:0', 'g:2:0']);
  assert.deepEqual(order(ledger(msgs, true), 'toolLog'), ['g:2:0', 'g:6:0', 'g:4:0']);
});

test('flag on: recency orders a category whose assigned ranks are oldest first', () => {
  const msgs = session([
    ['bash', { command: 'cat log' }, 'see docs/first.md for details'],
    ['bash', { command: 'cat log2' }, 'see docs/second.md for details'],
  ]);
  const paths = (L: Ledger): string[] => order(L, 'rest').filter((id) => id.startsWith('p:'));
  assert.deepEqual(paths(ledger(msgs, false)), ['p:docs/first.md', 'p:docs/second.md']);
  assert.deepEqual(paths(ledger(msgs, true)), ['p:docs/second.md', 'p:docs/first.md']);
});

test('flag on: an earlier copy of a repeated call loses its error advantage', () => {
  const steps = (first: string): Array<[string, unknown, string]> => [
    ['bash', { command: first }, 'Error: 3 specs failed'],
    ['bash', { command: 'ls' }, 'src test'],
    ['bash', { command: 'npm test' }, 'Error: 3 specs failed'],
  ];
  // distinct failing commands: both errors outrank the clean call
  assert.deepEqual(order(ledger(session(steps('npm run e2e')), true), 'toolLog'), ['g:6:0', 'g:2:0', 'g:4:0']);
  // the same failing command twice: the earlier copy is a duplicate and goes first
  assert.deepEqual(order(ledger(session(steps('npm test')), true), 'toolLog'), ['g:6:0', 'g:4:0', 'g:2:0']);
});

test('flag on: the earlier of two identical calls in one assistant message is the duplicate', () => {
  resetIds();
  const msgs = [
    sys(),
    user('Fix the checkout specs.'),
    ...unit('', [[call('bash', { command: 'npm test' }), 'Error: 3 specs failed'], [call('bash', { command: 'npm test' }), 'Error: 3 specs failed']]),
  ];
  const on = ledger(msgs, true);
  assert.deepEqual(on.items.filter((i) => i.category === 'toolLog').map((i) => i.rank[0]), [1, 0]);
  assert.deepEqual(order(on, 'toolLog'), ['g:2:1', 'g:2:0']);
});

test('flag on: same items, same categories, floor first, call/result pairs kept, user ranks untouched', () => {
  const msgs = MIXED();
  const off = ledger(msgs, false);
  const on = ledger(msgs, true);
  const strip = (L: Ledger) => L.items.map(({ rank: _rank, ...rest }) => rest);
  assert.deepEqual(strip(on), strip(off));
  const sorted = [...on.items].sort(compareItems);
  const cats = sorted.map((i) => CATEGORY_ORDER.indexOf(i.category));
  assert.deepEqual(cats, [...cats].sort((a, b) => a - b));
  const firstNonFloor = sorted.findIndex((i) => !FLOOR_CATEGORIES.has(i.category));
  assert.ok(sorted.slice(firstNonFloor).every((i) => !FLOOR_CATEGORIES.has(i.category)));
  for (const it of on.items.filter((i) => i.category === 'toolLog')) {
    assert.deepEqual(it.sources.map((s) => s.kind), ['tool-call', 'tool-result']);
  }
  for (const it of on.items.filter((i) => i.category === 'user')) assert.deepEqual(it.rank, off.items.find((o) => o.id === it.id)!.rank);
});
