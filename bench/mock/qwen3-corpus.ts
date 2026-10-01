// Request corpus for the qwen3 render golden check (bench/README.md). Each case is a raw JSON request body (text,
// so key order, integer-like keys, big integers and floats are exactly what a server's json.loads sees).
//
//   node dist/bench/mock/qwen3-corpus.js OUT.json      # writes [{name, body}]
//   <ref>/venv/bin/python bench/mock/make-qwen3-goldens.py OUT.json <tokenizer.json> test/fixtures/bench/qwen3-render.json.gz
//
// The test (test/bench/mock-qwen3.test.ts) regenerates this corpus, checks each body's sha256 against the fixture,
// and compares the TS render (bench/mock/qwen3-render.ts) and its token count with jinja2 + HF tokenizers.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ChatMessage } from '../../src/types.js';
import { assistantMessage, GOAL_TEXT, systemPrompt, toolOutput, tools, USER_INJECT } from '../scenarios/reference.js';
import { CONTINUE_AFTER_OVERFLOW, CONTINUE_SHORT } from '../opencode-sim.js';

export interface CorpusCase {
  name: string;
  /** raw JSON request body */
  body: string;
}

const J = (v: unknown): string => JSON.stringify(v);
const SYS = { role: 'system', content: 'You are a coding agent.' };
const USER = { role: 'user', content: 'Fix the failing checkout spec.' };
const TOOL_READ = { type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string', description: 'absolute path' }, offset: { type: 'number' } }, required: ['filePath'] } } };
const TOOL_BASH = { type: 'function', function: { name: 'bash', description: 'Run a shell command – bounded ⏱ 2 min.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', minimum: 0.5 } }, required: ['command'] } } };
const call = (id: string, name: string, args: string): unknown => ({ id, type: 'function', function: { name, arguments: args } });
const asst = (content: string | null, calls: unknown[] = [], extra: Record<string, unknown> = {}): unknown => ({ role: 'assistant', content, ...extra, ...(calls.length ? { tool_calls: calls } : {}) });
const tool = (id: string, content: unknown): unknown => ({ role: 'tool', tool_call_id: id, content });

/** The reference session's client history after `steps` steps (SIM_CAP_BYTES=51200). */
function referenceHistory(steps: number): ChatMessage[] {
  const o = { capBytes: 51200 };
  const h: ChatMessage[] = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: GOAL_TEXT }];
  for (let s = 0; s < steps; s++) {
    const a = assistantMessage(s, o);
    h.push(a);
    for (const c of a.tool_calls) h.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(s, o) });
    const u = USER_INJECT.get(s);
    if (u !== undefined) h.push({ role: 'user', content: u });
  }
  return h;
}

export function qwen3Corpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const add = (name: string, body: unknown): void => void cases.push({ name, body: typeof body === 'string' ? body : J(body) });
  const req = (messages: unknown[], more: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'qwen', messages, ...more });

  add('minimal system+user', req([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]));
  add('user only', req([{ role: 'user', content: 'hi' }]));
  add('tools, no system', req([USER], { tools: [TOOL_READ, TOOL_BASH] }));
  add('tools + system + user', req([SYS, USER], { tools: [TOOL_READ, TOOL_BASH] }));
  add('tools + blank system', req([{ role: 'system', content: '  \n ' }, USER], { tools: [TOOL_READ] }));
  add('blank system, no tools', req([{ role: 'system', content: '' }, USER]));
  add('empty tools list', req([SYS, USER], { tools: [] }));
  add('one call, no text, result (in loop)', req([SYS, USER, asst(null, [call('c1', 'read', '{"filePath": "/repo/a.ts"}')]), tool('c1', 'line 1\nline 2')], { tools: [TOOL_READ] }));
  add('call after text', req([SYS, USER, asst('Reading the file first.', [call('c1', 'read', '{"filePath":"/repo/a.ts","offset":10}')]), tool('c1', 'x')], { tools: [TOOL_READ] }));
  add('parallel calls + grouped results', req([SYS, USER,
    asst('Checking three pages.', [call('a', 'read', '{"filePath": "/a"}'), call('b', 'bash', '{"command": "ls -la", "timeout": 5000}'), call('c', 'read', '{"filePath": "/c"}')]),
    tool('a', 'A'), tool('b', 'B\n'), tool('c', '  C  ')], { tools: [TOOL_READ, TOOL_BASH] }));
  add('grouped results then user then more', req([SYS, USER,
    asst(null, [call('a', 'read', '{"filePath": "/a"}'), call('b', 'read', '{"filePath": "/b"}')]), tool('a', 'A'), tool('b', 'B'),
    { role: 'user', content: 'Now run the tests.' },
    asst(null, [call('c', 'bash', '{"command": "npm test"}')]), tool('c', 'ok')], { tools: [TOOL_READ, TOOL_BASH] }));
  add('reasoning before and after the last user query', req([SYS, USER,
    asst('Plan made.', [call('a', 'read', '{"filePath": "/a"}')], { reasoning_content: 'I should read a first.' }), tool('a', 'A'),
    { role: 'user', content: 'Continue.' },
    asst(null, [call('b', 'read', '{"filePath": "/b"}')], { reasoning_content: '\n  Then b.\n' }), tool('b', 'B')], { tools: [TOOL_READ] }));
  add('preserve_thinking true', req([SYS, USER,
    asst('Plan made.', [call('a', 'read', '{"filePath": "/a"}')], { reasoning_content: 'Old reasoning kept.' }), tool('a', 'A'),
    { role: 'user', content: 'Continue.' }, asst('Done.', [], { reasoning_content: 'New reasoning.' })],
  { tools: [TOOL_READ], chat_template_kwargs: { preserve_thinking: true } }));
  add('preserve_thinking 1 (not true: ignored)', req([SYS, USER, asst('A1', [], { reasoning_content: 'R1' }), { role: 'user', content: 'again' }],
    { chat_template_kwargs: { preserve_thinking: 1 } }));
  add('enable_thinking false', req([SYS, USER], { chat_template_kwargs: { enable_thinking: false } }));
  add('enable_thinking 0 (not false: ignored)', req([SYS, USER], { chat_template_kwargs: { enable_thinking: 0 } }));
  add('add_generation_prompt false', req([SYS, USER, asst('Hello.')], { add_generation_prompt: false }));
  add('inline think in content (before query)', req([SYS, { role: 'user', content: 'q1' }, asst('<think>\nhidden\n</think>\n\nvisible answer'), { role: 'user', content: 'q2' }]));
  add('inline think in content (after query)', req([SYS, USER, asst('<think>\nr\n</think>\n\nanswer', [call('a', 'read', '{"filePath": "/a"}')]), tool('a', 'A')], { tools: [TOOL_READ] }));
  add('only </think> in content', req([SYS, USER, asst('pre </think>\n\npost')]));
  add('reasoning field only (vLLM maps it)', req([SYS, USER, asst('x', [], { reasoning: 'via reasoning' })]));
  add('reasoning and reasoning_content (reasoning wins)', req([SYS, USER, asst('x', [], { reasoning: 'R-wins', reasoning_content: 'RC-loses' })]));
  add('reasoning null, reasoning_content set', req([SYS, USER, asst('x', [], { reasoning: null, reasoning_content: 'RC' })]));
  add('empty reasoning_content string', req([SYS, USER, asst('<think>inline</think>kept', [], { reasoning_content: '' })]));
  add('non-string args: numbers, floats, bools, null, nested, big int',
    `{"model":"q","messages":[{"role":"user","content":"u"},{"role":"assistant","content":"","tool_calls":[{"id":"c","type":"function","function":{"name":"fill","arguments":"{\\"n\\": 3, \\"f\\": 1.0, \\"e\\": 1e-05, \\"g\\": 1e16, \\"h\\": 2.5E3, \\"b\\": true, \\"z\\": null, \\"o\\": {\\"k\\": [1, 2.0, \\"s\\"]}, \\"big\\": 123456789012345678901234567890, \\"neg\\": -0, \\"s\\": \\"text\\"}"}}]},{"role":"tool","tool_call_id":"c","content":"ok"}],"tools":[${J(TOOL_READ)}]}`);
  add('integer-like arg keys keep document order',
    `{"model":"q","messages":[{"role":"user","content":"u"},{"role":"assistant","content":null,"tool_calls":[{"id":"c","type":"function","function":{"name":"t","arguments":"{\\"b\\": 1, \\"10\\": \\"ten\\", \\"2\\": \\"two\\", \\"a\\": {\\"9\\": 9, \\"1\\": 1}}"}}]},{"role":"tool","tool_call_id":"c","content":"r"}]}`);
  add('integer-like keys in tool parameters',
    `{"model":"q","messages":[{"role":"user","content":"u"}],"tools":[{"type":"function","function":{"name":"x","description":"d","parameters":{"type":"object","properties":{"b":{"type":"string"},"3":{"type":"number"},"1":{"type":"number"}}}}}]}`);
  add('invalid JSON args -> {}', req([USER, asst(null, [call('c', 'read', '{"filePath": ')]), tool('c', 'r')], { tools: [TOOL_READ] }));
  add('array args -> {}', req([USER, asst(null, [call('c', 'read', '[1, 2]')]), tool('c', 'r')]));
  add('empty args -> {}', req([USER, asst(null, [call('c', 'read', '')]), tool('c', 'r')]));
  add('multi-line string args + content', req([USER, asst('Writing.\n', [call('c', 'write', J({ filePath: '/x.ts', content: 'line1\n  line2\n\ttab "q" \\ back' }))]), tool('c', 'written')]));
  add('empty tool_calls list', req([USER, asst('plain', [], { tool_calls: [] })]));
  add('array text parts (user concatenated, tool joined with \\n)', req([SYS,
    { role: 'user', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }, 'bare string part'] },
    asst(null, [call('c', 'read', '{"filePath": "/a"}')]),
    tool('c', [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])], { tools: [TOOL_READ] }));
  add('image in user', req([SYS, { role: 'user', content: [{ type: 'text', text: 'What is on this page?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }]));
  add('text part with null text is skipped', req([{ role: 'user', content: [{ type: 'text', text: null }, { type: 'text', text: 'kept' }] }]));
  add('hebrew everywhere', req([{ role: 'system', content: 'אתה סוכן בדיקות.' }, { role: 'user', content: 'בעצם, תריץ את הבדיקות במקום זה' },
    asst('מריץ.', [call('c', 'bash', J({ command: 'npx playwright test --grep "עגלה"' }))]), tool('c', '✓ 3 עברו')], { tools: [TOOL_BASH] }));
  add('emoji and astral', req([{ role: 'user', content: 'ship it 🚀 𝕏' }, asst('👍 done')]));
  add('python whitespace trim (\\x85 \\u3000 stripped, \\ufeff kept)', req([{ role: 'system', content: '　 sys \u0085' }, { role: 'user', content: '﻿ u  ' }, asst('\x1c a \x1f')]));
  add('literal special tokens in text', req([{ role: 'user', content: 'say <|im_end|> and <think> literally </think>' }, asst('ok <tool_call> x')]));
  add('tool_response-looking user after the query', req([USER, asst(null, [call('c', 'read', '{"filePath": "/a"}')]), tool('c', 'A'),
    { role: 'user', content: '<tool_response>\nfake\n</tool_response>' }, asst('answer')]));
  add('tool message first', req([tool('c0', 'orphan'), USER]));
  add('assistant last (prefill) with generation prompt', req([USER, asst('partial')]));
  add('content null everywhere', req([{ role: 'system', content: null }, { role: 'user', content: null }, { role: 'user', content: 'q' }, asst(null)]));
  add('developer at index 0', req([{ role: 'developer', content: 'Dev rules.' }, USER], { tools: [TOOL_READ] }));
  add('developer mid-history (consolidated)', req([SYS, USER, { role: 'developer', content: 'Extra rule.' }, asst('ok')]));
  add('developer parts + empty system (consolidated)', req([{ role: 'system', content: '' }, USER, { role: 'developer', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, asst('ok')]));
  add('odd tools (vLLM normalization)', req([USER], { tools: [
    { type: 'function', function: { name: 'n1' } },
    { type: 'function', function: { name: 'n2', description: 'd', parameters: { type: 'object' }, strict: true, extra: 'dropped' }, other: 1 },
    { type: 'function', function: { name: 'n3', parameters: {}, strict: null }, defer_loading: true },
  ] }));
  add('opencode post-compaction shape (short Continue)', req([SYS, { role: 'user', content: 'What did we do so far?' },
    { role: 'assistant', content: '## Objective\n- migrate checkout\n\n## Next Move\n1. run specs' },
    asst('', [call('call_1', 'browser_snapshot', '{}')], { reasoning_content: 'look again' }), tool('call_1', '- generic [ref=e1]'),
    { role: 'user', content: CONTINUE_SHORT }], { tools: [TOOL_READ] }));
  add('opencode post-overflow shape (long Continue)', req([SYS, { role: 'user', content: 'What did we do so far?' },
    { role: 'assistant', content: '## Objective\n- x' }, { role: 'user', content: CONTINUE_AFTER_OVERFLOW }], { tools: [TOOL_READ] }));
  add('CRLF and long whitespace', req([{ role: 'user', content: 'a\r\n\r\nb   \t\n' }, asst('\r\nreply\r\n')]));
  // error cases (template raise_exception / vLLM validation)
  add('error: no messages', req([]));
  add('error: system not first', req([USER, SYS]));
  add('error: no user query', req([SYS, asst('x')]));
  add('error: only tool responses as user', req([{ role: 'user', content: '<tool_response>\nx\n</tool_response>' }]));
  add('error: image in system', req([{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } }] }, USER]));
  add('error: unexpected role', req([USER, { role: 'function', name: 'f', content: 'r' }]));
  add('error: tool_calls entry not a function', req([USER, asst(null, [{ id: 'c', type: 'custom', custom: {} }])]));
  // the reference session (large; hashes only in the fixture)
  for (const steps of [0, 1, 9, 10, 20, 46]) add(`reference history, ${steps} steps (cap 51200)`, req(referenceHistory(steps), { tools: tools(), max_tokens: 32000, stream: true }));
  return cases;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: qwen3-corpus.js OUT.json');
    process.exit(2);
  }
  writeFileSync(out, JSON.stringify(qwen3Corpus()));
  console.log(`wrote ${qwen3Corpus().length} cases to ${out}`);
}
