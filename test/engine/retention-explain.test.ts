import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import { createSummarizerExt } from '../../src/engine/summary.js';
import { testConfig, estimateCounter } from './stubs.js';

const call = (id: string, name: string, args: object): ToolCall => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const messages: ChatMessage[] = [
  { role: 'user', content: 'USER-PLAN-R1: Run the private payment tests.' },
  { role: 'assistant', content: 'DECISION: Use the private implementation.\nTODO: Verify the payment.',
    tool_calls: [
      call('secret-read', 'read_file', { path: '/private/secret.ts' }),
      call('secret-todo', 'todowrite', { todos: [{ content: 'Private task', status: 'pending' }] }),
    ] },
  { role: 'tool', tool_call_id: 'secret-todo', content: 'Private todo result.' },
  { role: 'tool', tool_call_id: 'secret-read', content: 'Found /private/config.json' },
  { role: 'assistant', content: 'Some private narrative.' },
  { role: 'user', content: 'Correction USER-PLAN-R1: Cancel the private payment tests.' },
];
const input = { messages, digests: [], hEnd: 0, cut: 5, compaction: 1 };
const opts = { budgetTokens: 100_000, allowFloorEviction: false, userShortenStep: 0 as const };
const make = () => createSummarizerExt(testConfig(), estimateCounter('generic'));

test('typed attribution identifies instructions, decisions, todos and file call versus result sources', () => {
  const summary = make().render(input, opts);
  const a = summary.attribution!;
  assert.ok(a.length > 0);
  assert.deepEqual(a.find((x) => x.category === 'user')?.sources, [{ kind: 'message', messageIndex: 0 }]);
  assert.deepEqual(a.find((x) => x.category === 'decision')?.sources, [{ kind: 'message', messageIndex: 1 }]);
  assert.ok(a.some((x) => x.category === 'todo' && x.sources.some((s) => s.kind === 'tool-call' && s.callIndex === 1)));
  assert.ok(a.some((x) => x.category === 'todo' && x.sources.some((s) => s.kind === 'message')));
  assert.ok(a.some((x) => x.category === 'file' && x.sources.some((s) => s.kind === 'tool-call' && s.callIndex === 0)));
  assert.ok(a.some((x) => x.category === 'file' && x.sources.some((s) =>
    s.kind === 'tool-result' && s.messageIndex === 3 && s.call?.messageIndex === 1 && s.call.callIndex === 0)));
  const logs = a.filter((x) => x.category === 'toolLog');
  assert.deepEqual(logs.map((x) => x.sources), [
    [{ kind: 'tool-call', messageIndex: 1, callIndex: 0 },
      { kind: 'tool-result', messageIndex: 3, call: { messageIndex: 1, callIndex: 0 } }],
    [{ kind: 'tool-call', messageIndex: 1, callIndex: 1 },
      { kind: 'tool-result', messageIndex: 2, call: { messageIndex: 1, callIndex: 1 } }],
  ]);
  assert.equal(a.length, summary.kept + summary.dropped);
  assert.doesNotMatch(JSON.stringify(a), /private|secret|payment|config\.json|read_file|todowrite/i);
});

test('tail correction supersession and floor/budget decisions are explicit without changing sources', () => {
  const s = make();
  const full = s.render(input, opts);
  assert.deepEqual(full.attribution!.find((x) => x.category === 'user')?.supersededBy, [5]);
  assert.match(full.text!, /superseded by #5/);
  assert.ok(full.attribution!.some((x) => x.reason === 'protected-floor'));
  assert.ok(full.attribution!.some((x) => x.reason === 'priority-prefix'));
  const small = s.render(input, { ...opts, budgetTokens: 0, allowFloorEviction: true });
  assert.equal(small.kept, 1);
  assert.equal(small.dropped, full.attribution!.length - 1);
  for (const [i, item] of small.attribution!.entries()) {
    assert.deepEqual(item.sources, full.attribution![i]!.sources);
    assert.equal(item.disposition, item.category === 'user' ? 'summarized' : 'dropped');
    assert.equal(item.reason, item.category === 'user' ? 'user-instruction' : 'budget-eviction');
  }
  // Diagnostics must not let consumers mutate the cached ledger's coordinates.
  small.attribution![0]!.sources[0]!.messageIndex = 999;
  assert.deepEqual(s.render(input, opts).attribution, full.attribution);
  assert.deepEqual(s.render({ ...input, cut: 0 }, opts).attribution, []);
});

test('orphan tool results retain their own index without inventing a call', () => {
  const render = make().render({
    messages: [{ role: 'tool', content: 'Found /private/config.json' }],
    digests: [], hEnd: 0, cut: 1, compaction: 1,
  }, opts);
  assert.deepEqual(render.attribution!.find((x) => x.category === 'file')?.sources,
    [{ kind: 'tool-result', messageIndex: 0 }]);
});

test('a protected floor survives a zero budget while lower priority items are evicted', () => {
  const render = make().render(input, { ...opts, budgetTokens: 0 });
  for (const item of render.attribution!) {
    if (item.category === 'toolLog' || item.category === 'narrative2') {
      assert.equal(item.reason, 'budget-eviction');
      assert.equal(item.disposition, 'dropped');
    } else {
      assert.equal(item.disposition, 'summarized');
      assert.equal(item.reason, item.category === 'user' ? 'user-instruction' : 'protected-floor');
    }
  }
});

test('missing results and repeated file calls preserve the selected call slot', () => {
  const render = make().render({
    messages: [
      { role: 'assistant', content: null, tool_calls: [call('a', 'read_file', { path: '/private/secret.ts' })] },
      { role: 'assistant', content: null, tool_calls: [
        call('b', 'read_file', { path: '/private/other.ts' }),
        call('c', 'read_file', { path: '/private/secret.ts' }),
      ] },
    ], digests: [], hEnd: 0, cut: 2, compaction: 1,
  }, opts);
  assert.ok(render.attribution!.some((x) => x.category === 'file' &&
    x.sources.some((s) => s.kind === 'tool-call' && s.messageIndex === 1 && s.callIndex === 1)));
  for (const log of render.attribution!.filter((x) => x.category === 'toolLog')) {
    assert.equal(log.sources.length, 1);
    assert.equal(log.sources[0]!.kind, 'tool-call');
  }
});
