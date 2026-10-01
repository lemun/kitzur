import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '../../bench/scenarios/reference.js';
import { pyDumps, pyLen } from '../../bench/lib/pyjson.js';
import { benchFixture, Checker, sha256 } from './fixtures.js';

interface StepGolden {
  step: number;
  kind: string;
  tool_output_sha256: string;
  tool_output_pylen: number;
  tool_output_utf8: number;
  tool_output_head: string;
  tool_output_tail: string;
  assistant_json_sha256: string;
  assistant_content: string | null;
  tool_name: string;
  arguments: string;
}
interface Golden {
  system_prompt: { sha256: string; pylen: number; head: string; tail: string };
  tools: { count: number; render_lines_sha256: string; render_lines_len: number; dumps_default_sha256: string; first_tool_dumps: string };
  goal_text: string;
  user_inject: Record<string, string>;
  variants: Record<string, { env: Record<string, string>; steps: StepGolden[] }>;
}
const G = benchFixture<Golden>('scenario.json.gz');

test('fixed fields: system prompt, tools, goal, user inject', () => {
  const sp = sc.systemPrompt();
  assert.equal(sha256(sp), G.system_prompt.sha256);
  assert.equal(pyLen(sp), G.system_prompt.pylen);
  const tools = sc.tools();
  assert.equal(tools.length, G.tools.count);
  const tj = tools.map((t) => pyDumps(t, { ensureAscii: false })).join('\n');
  assert.equal(sha256(tj), G.tools.render_lines_sha256);
  assert.equal(pyLen(tj), G.tools.render_lines_len);
  assert.equal(sha256(pyDumps(tools)), G.tools.dumps_default_sha256);
  assert.equal(pyDumps(tools[0], { ensureAscii: false }), G.tools.first_tool_dumps);
  assert.equal(sc.GOAL_TEXT, G.goal_text);
  assert.equal(sc.USER_INJECT.get(9), G.user_inject['9']);
});

test('every env variant x 200 steps is byte-identical to scenario.py', () => {
  const c = new Checker();
  const names = Object.keys(G.variants);
  assert.deepEqual(names, ['uncapped', 'cap51200', 'cap50000', 'chatty', 'chatty_cap51200', 'huge150k_at20', 'huge180k_at20', 'huge400k_at20_cap51200']);
  for (const [name, v] of Object.entries(G.variants)) {
    // Python's own env parsing, so the variants are reproduced from the same env strings.
    const opts = sc.scenarioOptionsFromEnv(v.env);
    assert.equal(v.steps.length, 200);
    for (const r of v.steps) {
      const s = r.step;
      const out = sc.toolOutput(s, opts);
      c.eq(sc.kind(s), r.kind, `${name} ${s} kind`);
      c.eq(sha256(out), r.tool_output_sha256, `${name} ${s} tool_output sha`);
      c.eq(pyLen(out), r.tool_output_pylen, `${name} ${s} pylen`);
      c.eq(Buffer.byteLength(out, 'utf8'), r.tool_output_utf8, `${name} ${s} utf8`);
      c.eq(out.slice(0, r.tool_output_head.length), r.tool_output_head, `${name} ${s} head`);
      c.eq(out.slice(out.length - r.tool_output_tail.length), r.tool_output_tail, `${name} ${s} tail`);
      const msg = sc.assistantMessage(s, opts);
      c.eq(sha256(pyDumps(msg)), r.assistant_json_sha256, `${name} ${s} assistant sha`);
      c.eq(msg.content, r.assistant_content, `${name} ${s} content`);
      c.eq(msg.tool_calls[0]!.function.name, r.tool_name, `${name} ${s} tool name`);
      c.eq(msg.tool_calls[0]!.function.arguments, r.arguments, `${name} ${s} arguments`);
    }
  }
  assert.equal(c.fails.length, 0, c.summary());
  assert.equal(c.checks, 8 * 200 * 10);
});

test('pyjson scenario vectors and env parsing quirks', () => {
  const V = benchFixture<{ scenario: Record<string, string> }>('pyjson.json.gz').scenario;
  assert.equal(pyDumps(sc.assistantMessage(3).tool_calls), V['assistant_message_3_tool_calls_dumps']);
  assert.equal(sc.toolOutput(3), V['todo_output_step3']);
  const call = sc.assistantMessage(16).tool_calls[0]!.function;
  assert.equal(pyDumps(new Map([['name', call.name], ['arguments', call.arguments]]), { ensureAscii: false }), V['render_toolcall_step16']);
  assert.equal(pyDumps(sc.stepPlan(12)[2]), V['grep_args_step12_dumps']);
  // step -1 (no x-sim-step header): a snapshot call with id call_-001_0
  assert.equal(sc.assistantMessage(-1).tool_calls[0]!.id, 'call_-001_0');
  assert.equal(sc.kind(-1), 'snapshot');
  // Python env semantics
  assert.equal(sc.scenarioOptionsFromEnv({ SIM_CHATTY: '0' }).chatty, true);
  assert.equal(sc.scenarioOptionsFromEnv({ SIM_CAP_BYTES: ' +51_200\n' }).capBytes, 51200);
  assert.throws(() => sc.scenarioOptionsFromEnv({ SIM_CAP_BYTES: '' }));
  assert.equal(sc.scenarioOptionsFromEnv({ SIM_HUGE_AT: '' }).hugeAt, null);
  // SIM_HUGE_CHARS is parsed only when SIM_HUGE_AT is set (Python ignores a bad value otherwise)
  assert.equal(sc.scenarioOptionsFromEnv({ SIM_HUGE_CHARS: 'abc' }).hugeAt, null);
  assert.throws(() => sc.scenarioOptionsFromEnv({ SIM_HUGE_AT: '20', SIM_HUGE_CHARS: 'abc' }));
  assert.equal(sc.scenarioOptionsFromEnv({ SIM_HUGE_AT: '20' }).hugeChars, 240000);
  assert.deepEqual(sc.scenarioEnv({ capBytes: 51200, chatty: true }), { SIM_CAP_BYTES: '51200', SIM_CHATTY: '1' });
});
