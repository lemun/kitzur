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
const make = (ranking = false) => {
  const cfg = testConfig();
  cfg.ledger.ranking = ranking;
  return createSummarizerExt(cfg, estimateCounter('generic'));
};

test('ranking signals are absent when ranking is disabled', () => {
  const render = make().render(input, opts);
  assert.ok(render.attribution!.every((item) => !Object.hasOwn(item, 'signals')));
  const userOnly = make().render({
    messages: [{ role: 'user', content: 'USER-PLAN-R1: Keep this task.' }], digests: [], hEnd: 0, cut: 1, compaction: 1,
  }, opts);
  assert.equal(JSON.stringify(userOnly.attribution), JSON.stringify([{
    category: 'user', sources: [{ kind: 'message', messageIndex: 0 }], supersededBy: [],
    disposition: 'summarized', reason: 'user-instruction',
  }]));
});

test('ranking signals explain errors, references, duplicates and recency without content', () => {
  const msgs: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [call('err', 'bash', { command: 'npm test' })] },
    { role: 'tool', tool_call_id: 'err', content: 'Error: 2 tests failed.' },
    { role: 'assistant', content: null, tool_calls: [call('read', 'read_file', { filePath: 'src/a.ts' })] },
    { role: 'tool', tool_call_id: 'read', content: 'Read source.' },
    { role: 'assistant', content: null, tool_calls: [call('duplicate-1', 'bash', { command: 'npm run lint' })] },
    { role: 'tool', tool_call_id: 'duplicate-1', content: 'Lint finished.' },
    { role: 'assistant', content: null, tool_calls: [call('ref', 'edit', { filePath: './src/a.ts', oldString: 'x', newString: 'y' })] },
    { role: 'tool', tool_call_id: 'ref', content: 'Updated file.' },
    { role: 'assistant', content: null, tool_calls: [call('duplicate-2', 'bash', { command: 'npm run lint' })] },
    { role: 'tool', tool_call_id: 'duplicate-2', content: 'Lint finished.' },
    { role: 'assistant', content: null, tool_calls: [call('recent', 'bash', { command: 'git status' })] },
    { role: 'tool', tool_call_id: 'recent', content: 'Working tree clean.' },
  ];
  const summarizer = make(true);
  const rankedInput = { messages: msgs, digests: [], hEnd: 0, cut: msgs.length, compaction: 1 };
  const ranked = summarizer.render(rankedInput, opts);
  const logs = ranked.attribution!.filter((a) => a.category === 'toolLog');
  const signalItem = (signal: string) => logs.find((a) => a.signals?.includes(signal as never));
  assert.ok(signalItem('error')?.sources.some((s) => s.kind === 'tool-call' && s.messageIndex === 0));
  assert.ok(signalItem('referenced')?.sources.some((s) => s.kind === 'tool-call' && s.messageIndex === 2));
  assert.ok(signalItem('duplicate')?.sources.some((s) => s.kind === 'tool-call' && s.messageIndex === 4));
  assert.ok(signalItem('recent')?.sources.some((s) => s.kind === 'tool-call' && s.messageIndex === 10));
  assert.ok(logs.every((a) => a.signals === undefined || a.signals.every((s) =>
    ['error', 'referenced', 'duplicate', 'recent'].includes(s))));
  assert.doesNotMatch(JSON.stringify(logs.map((a) => a.signals)), /src\/|npm|git|Error|tests/);
  const pristine = JSON.stringify(ranked.attribution);
  const firstSignals = ranked.attribution!.find((a) => a.signals)?.signals;
  if (firstSignals) firstSignals.push('recent');
  assert.equal(JSON.stringify(summarizer.render(rankedInput, opts).attribution), pristine);
});

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

import { createEngine } from '../../src/engine/engine.js';
import { createToolRules } from '../../src/engine/rules/index.js';

test('final retention survives cache reuse and rebuild from original history', () => {
  const cfg = testConfig({ budget: { window: 8000, defaultMaxTokens: 256 },
    compaction: { triggerTokens: 3500, targetTokens: 1500 },
    tokenizer: { template: { name: 'generic' } } });
  const makeEngine = () => {
    const counter = estimateCounter('generic');
    return createEngine(cfg, { counter, summarizer: createSummarizerExt(cfg, counter), rules: createToolRules(cfg) });
  };
  const engine = makeEngine();
  const history: ChatMessage[] = [{ role: 'system', content: 'Coding task.' },
    { role: 'user', content: 'Work on the task.' }];
  for (let i = 0; i < 12; i++) history.push(
    { role: 'assistant', content: `DECISION: Step ${i}.`, tool_calls: [call(`c${i}`, 'read_file', { path: `/private/f${i}.ts` })] },
    { role: 'tool', tool_call_id: `c${i}`, content: 'Diagnostic output. '.repeat(450) });
  const req = { model: 'test', messages: history, max_tokens: 256 };
  const first = engine.process(req, { attempt: 1 });
  assert.ok(first.plan!.compactions > 0);
  const decisions = (first.plan as unknown as { retention?: unknown[] }).retention;
  assert.ok(decisions?.length, 'accepted plans must carry final retention decisions');
  const cached = engine.process(req, { attempt: 1 });
  assert.equal(engine.lastTrace!.summaryRenders, 0);
  const rebuilt = makeEngine().process(req, { attempt: 1 });
  assert.deepEqual(cached.plan!.retention, decisions);
  assert.deepEqual(rebuilt.plan!.retention, decisions);
  assert.deepEqual(rebuilt.request, first.request);
  assert.ok(decisions.some((d: any) => d.disposition === 'summarized'));
  assert.ok(decisions.some((d: any) => d.disposition === 'verbatim'));
  assert.doesNotMatch(JSON.stringify(decisions), /private|Diagnostic|read_file/);
  assert.deepEqual(first.stats.retention, cached.stats.retention);
  first.plan!.retention![0]!.sources[0]!.messageIndex = 999;
  assert.deepEqual(engine.process(req, { attempt: 1 }).plan!.retention, cached.plan!.retention);
});
