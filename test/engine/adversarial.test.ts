// Regression tests for histories the property fuzz cannot generate (adversarial review):
//   - a client message with an own "__proto__" key (JSON.parse keeps it as a data property);
//   - R5 on tool-call arguments holding numbers beyond a double (1e400) or nested thousands deep;
//   - one assistant with thousands of parallel tool calls (result classification was quadratic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatRequest } from '../../src/types.js';
import { createEngine } from '../../src/engine/engine.js';
import { withoutReasoning, toolCallsOf } from '../../src/engine/message.js';
import { cutAssistant, MAX_ARGS_DEPTH, type OpsEnv } from '../../src/engine/oversize.js';
import { callFor, kindOf, type ResultsEnv } from '../../src/engine/results.js';
import { Lru } from '../../src/engine/lru.js';
import { createSummarizer } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import type { ResultKind, ToolRules } from '../../src/engine/contracts.js';
import { estimateCounter, presetConfig } from './stubs.js';
import { MAX_SAVED_PATH_CHARS, savedPathOf, truncateHeadTail } from '../../src/engine/text.js';
import { oracleDefects, subset } from './oracle.js';

const env: OpsEnv = { text: (s) => Math.ceil(s.length / 4), headShare: 0.7, imageTokens: 100 };
const filler = (n: number, s: string): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);

test('withoutReasoning keeps an own "__proto__" key as data and never changes the prototype', () => {
  const m = JSON.parse(
    '{"role":"assistant","content":"x","reasoning_content":"r","__proto__":{"tool_calls":[{"id":"evil","type":"function","function":{"name":"f","arguments":"{}"}}]}}',
  ) as ChatMessage;
  const w = withoutReasoning(m);
  assert.equal(Object.getPrototypeOf(w), Object.prototype);
  assert.deepEqual(Object.keys(w), ['role', 'content', '__proto__']);
  assert.equal(JSON.stringify(w), '{"role":"assistant","content":"x","__proto__":{"tool_calls":[{"id":"evil","type":"function","function":{"name":"f","arguments":"{}"}}]}}');
  assert.equal(toolCallsOf(w).length, 0, 'no inherited tool_calls');
  assert.equal('reasoning_content' in w, false);
});

test('reasoning.tail = drop on assistants carrying a "__proto__" key: compaction, not a pairing guard failure', () => {
  // before the fix, the reasoning-free copy inherited the __proto__ tool_calls: the guard saw an unanswered call
  // (guard:pairing:unanswered) and rejected every compaction, ending in guard_reject 400s
  const cfg = presetConfig('32k', { reasoning: { tail: 'drop' }, tokenizer: { template: { name: 'sim' } } });
  const counter = estimateCounter('sim');
  const engine = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg), faults: null });
  const H: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Do the thing.' }];
  const actions: string[] = [];
  for (let i = 0; i < 14; i++) {
    H.push(JSON.parse(JSON.stringify({ role: 'assistant', content: filler(9000, 'answer text '), reasoning_content: filler(9000, 'thinking hard ') }).replace(
      /}$/, ',"__proto__":{"tool_calls":[{"id":"evil","type":"function","function":{"name":"x","arguments":"{}"}}]}}',
    )) as ChatMessage);
    H.push({ role: 'user', content: `next ${i} ` + filler(3000, 'more words ') });
    const req: ChatRequest = { model: 'q', messages: H.slice() };
    const res = engine.process(req, { attempt: 1 });
    actions.push(res.action);
    assert.ok(!res.action.startsWith('guard'), `request ${i}: ${res.action} ${res.reason}`);
    if (res.request) {
      assert.ok(subset(oracleDefects(res.request.messages), oracleDefects(req.messages)), `I1 request ${i}`);
      // the forwarded copies keep the client's key
      for (const m of res.request.messages) if (m.role === 'assistant') assert.ok(Object.keys(m).includes('__proto__'));
    }
  }
  assert.ok(actions.includes('compact'), actions.join(','));
});

const argsOf = (m: ChatMessage | null): string => (m ? (toolCallsOf(m)[0]!.function.arguments as string) : '');
const callMsg = (args: string, content = ''): ChatMessage => ({
  role: 'assistant', content, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: args } }],
});

test('R5 leaves arguments with non-finite numbers unchanged: valid JSON stays valid JSON', () => {
  const long = 'x'.repeat(4000);
  for (const args of [`{"a":1e400,"s":"${long}"}`, `{"a":[-1e999],"s":"${long}"}`]) {
    const out = cutAssistant(callMsg(args, 'y'.repeat(4000)), 500, env);
    assert.ok(out, 'the content is still cut');
    assert.equal(argsOf(out), args, 'arguments untouched (they would have become {"a":Infinity,...})');
    JSON.parse(argsOf(out));
  }
  // finite numbers, -0 and big integers are cut and re-serialized as JSON
  const ok = `{"a":-0,"b":12345678901234567890123,"c":1.5e300,"s":"${long}"}`;
  const out = cutAssistant(callMsg(ok), 500, env)!;
  assert.ok(argsOf(out).length < ok.length);
  assert.match(argsOf(out), /^\{"a":0,"b":12345678901234567890123,"c":1\.5e\+300,"s":"x+/);
  JSON.parse(argsOf(out));
});

test('R5 on arguments nested thousands deep: no stack overflow, arguments left unchanged', () => {
  for (const d of [MAX_ARGS_DEPTH + 1, 3000, 5000, 8000, 50_000]) {
    for (const args of ['['.repeat(d) + `"${'x'.repeat(4000)}"` + ']'.repeat(d), '{"a":'.repeat(d) + `"${'x'.repeat(4000)}"` + '}'.repeat(d)]) {
      const out = cutAssistant(callMsg(args, 'y'.repeat(4000)), 500, env);
      assert.ok(out, `depth ${d}: the content is still cut`);
      assert.equal(argsOf(out), args, `depth ${d}`);
    }
  }
  // at the cap, still cut
  const d = MAX_ARGS_DEPTH - 1;
  const args = '['.repeat(d) + `"${'x'.repeat(4000)}"` + ']'.repeat(d);
  assert.ok(argsOf(cutAssistant(callMsg(args), 500, env)).length < args.length);
});

class Rng {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s * 1103515245 + 12345) % 2147483648;
    return this.s / 2147483648;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

test('result classification sees the same call as callFor (random histories with reused and duplicate ids)', () => {
  const r = new Rng(7);
  const roles = ['assistant', 'assistant', 'tool', 'tool', 'tool', 'function', 'user', 'system', 'Assistant'];
  for (let t = 0; t < 300; t++) {
    const msgs: ChatMessage[] = [];
    const n = 1 + r.int(40);
    for (let i = 0; i < n; i++) {
      const role = roles[r.int(roles.length)]!;
      const id = (): unknown => (r.int(10) === 0 ? r.int(3) : 'id' + r.int(4));
      if (role === 'assistant') {
        const k = r.int(4);
        const calls = Array.from({ length: k }, () => ({ id: id(), type: 'function', function: { name: 'f' + r.int(3), arguments: '{}' } }));
        msgs.push(r.int(8) === 0 ? { role, content: 'x', tool_calls: [null, 'junk', ...calls] as never } : { role, content: 'x', tool_calls: calls as never });
      } else msgs.push({ role, content: 'r', ...(r.int(5) ? { tool_call_id: id() } : {}) } as ChatMessage);
    }
    const seen: Array<unknown> = [];
    const rules = { classify: (_text: string, call: unknown): ResultKind => (seen.push(call), 'other') } as unknown as ToolRules;
    const renv: ResultsEnv = { msgs, digests: msgs.map((_, i) => `d${t}-${i}`), rules, classify: new Lru(10_000), size: () => 0 };
    for (let i = 0; i < n; i++) {
      seen.length = 0;
      kindOf(renv, i);
      assert.equal(seen[0], callFor(msgs, i), `history ${t} index ${i}`);
    }
  }
});

test('classifying 20,000 parallel results of one assistant is linear (was quadratic: 10,000 took 9 s)', () => {
  const N = 20_000;
  const calls = Array.from({ length: N }, (_, i) => ({ id: 't' + i, type: 'function' as const, function: { name: 'read', arguments: '{}' } }));
  const msgs: ChatMessage[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: calls }];
  for (let i = 0; i < N; i++) msgs.push({ role: 'tool', tool_call_id: 't' + i, content: 'ok' });
  const rules = { classify: (): ResultKind => 'other' } as unknown as ToolRules;
  const renv: ResultsEnv = { msgs, digests: msgs.map((_, i) => 'd' + i), rules, classify: new Lru(100_000), size: () => 0 };
  const t0 = performance.now();
  for (let i = 2; i < msgs.length; i++) kindOf(renv, i);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

test('a saved-output "path" longer than PATH_MAX is ignored: the output can still be truncated to fit', () => {
  const huge = 'Full output saved to: /tmp/' + 'p'.repeat(200_000) + '\n' + filler(100_000, 'output line text;\n');
  assert.equal(savedPathOf(huge), null);
  assert.equal(savedPathOf('Full output saved to: /tmp/' + 'p'.repeat(MAX_SAVED_PATH_CHARS - 5) + '\nx'), '/tmp/' + 'p'.repeat(MAX_SAVED_PATH_CHARS - 5));
  const r = truncateHeadTail(huge, 2000, env.text, { headShare: 0.7 })!;
  assert.ok(r.tokens <= 2000, `${r.tokens}`);
  // end to end: before, the 200k-character marker made this request impossible (400) at 32k
  const cfg = presetConfig('32k', { tokenizer: { template: { name: 'sim' } } });
  const counter = estimateCounter('sim');
  const engine = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg), faults: null });
  const res = engine.process({
    model: 'q',
    messages: [
      { role: 'system', content: 'sys' }, { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{"command":"cat x"}' } }] },
      { role: 'tool', tool_call_id: 'c', content: huge },
    ],
  }, { attempt: 1 });
  assert.ok(res.request !== null, `${res.action} ${res.reason}`);
  assert.ok(res.stats.tokensOut <= res.stats.budget.budget);
});
