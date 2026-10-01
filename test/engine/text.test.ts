import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePointLength, fmtInt, headCut, savedPathOf, tailCut, truncateHeadTail, truncationMarker } from '../../src/engine/text.js';
import { cutAssistant, IMAGE_OMITTED, omitOneImage, slimText, truncateText, carryImageOmissions, messageSize, type OpsEnv } from '../../src/engine/oversize.js';
import { fmtK, fixedPromptTooLarge, contextLengthExceeded, OPENCODE_RETRY_RE } from '../../src/engine/impossible.js';
import type { ChatMessage } from '../../src/types.js';
import { exactCounter, estimateCounter, StubRules, testConfig } from './stubs.js';
import { toolOutput } from '../../bench/scenarios/reference.js';

const est = estimateCounter();
const counting = (f: (s: string) => number) => {
  let calls = 0;
  return { count: (s: string) => (calls++, f(s)), calls: () => calls };
};

test('fmtInt groups thousands', () => {
  assert.equal(fmtInt(0), '0');
  assert.equal(fmtInt(999), '999');
  assert.equal(fmtInt(180_000), '180,000');
  assert.equal(fmtInt(1_234_567), '1,234,567');
});

test('the §5.6 marker, with and without the OpenCode saved path', () => {
  assert.equal(
    truncationMarker(9812, 2104, 180_000, null),
    "[kitzur: this output was truncated to fit the model's context window: kept the first 9,812 and the last 2,104 of 180,000 characters. The middle is not visible to you. To see it, re-run the tool with narrower arguments (for example Read with offset/limit, grep, or a scoped snapshot).]",
  );
  const m = truncationMarker(1, 2, 3, '/users/example/.local/share/opencode/tool-output/tool_0012');
  assert.match(m, /saved at \/users\/example\/\.local\/share\/opencode\/tool-output\/tool_0012;/);
  assert.equal(savedPathOf('x\nFull output saved to: /tmp/a b\nUse Grep'), '/tmp/a b');
  assert.equal(savedPathOf('nothing'), null);
});

test('cuts never split a surrogate pair', () => {
  const s = 'ab😀cd';
  assert.equal(headCut(s, 3), 2);
  assert.equal(tailCut(s, 3), 4);
  assert.equal(codePointLength(s), 5);
  const big = '😀'.repeat(5000) + '\n' + 'é😀'.repeat(4000);
  const r = truncateHeadTail(big, 800, est.countText.bind(est), { headShare: 0.8 })!;
  assert.ok(r && r.tokens <= 800);
  for (let i = 0; i < r.text.length; i++) {
    const c = r.text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) assert.ok(r.text.charCodeAt(i + 1) >= 0xdc00 && r.text.charCodeAt(i + 1) <= 0xdfff, `lone high at ${i}`);
    if (c >= 0xdc00 && c <= 0xdfff) assert.ok(r.text.charCodeAt(i - 1) >= 0xd800 && r.text.charCodeAt(i - 1) <= 0xdbff, `lone low at ${i}`);
  }
});

test('head+tail truncation: fits the room, head share, line boundaries, few counts ()', () => {
  const tok = exactCounter('sim');
  const count = tok ? tok.countText.bind(tok) : est.countText.bind(est);
  const text = toolOutput(0, { hugeAt: 0, hugeChars: 180_000 });
  for (const room of [500, 5_000, 27_472]) {
    const c = counting(count);
    const r = truncateHeadTail(text, room, c.count, { headShare: 0.8 })!;
    assert.ok(r.tokens <= room, `${r.tokens} <= ${room}`);
    assert.ok(r.tokens > room * 0.85, `uses the room: ${r.tokens} of ${room}`);
    assert.ok(c.calls() <= 2 + 4, `counts: ${c.calls()}`); // original + marker + ≤ 4 verifications
    const [head, rest] = r.text.split('\n\n[kitzur: this output was truncated');
    assert.ok(head && rest);
    assert.ok(text.startsWith(head!));
    const tail = rest!.slice(rest!.indexOf(']\n\n') + 3);
    assert.ok(text.endsWith(tail));
    assert.ok(text[head!.length] === '\n', 'head ends at a line boundary');
    assert.ok(text[text.length - tail.length - 1] === '\n', 'tail starts at a line boundary');
    assert.ok(Math.abs(r.keptHead / (r.keptHead + r.keptTail) - 0.8) < 0.05);
    assert.match(r.text, new RegExp(`kept the first ${fmtInt(r.keptHead)} and the last ${fmtInt(r.keptTail)} of 180,`));
  }
  assert.equal(truncateHeadTail('short', 100, count, { headShare: 0.8 }), null);
  const m = truncateHeadTail(text, 3, count, { headShare: 0.8 })!;
  assert.ok(m.markerOnly && m.keptHead === 0 && m.keptTail === 0);
  // deterministic
  assert.deepEqual(truncateHeadTail(text, 5000, count, { headShare: 0.8 }), truncateHeadTail(text, 5000, count, { headShare: 0.8 }));
});

const env: OpsEnv = { text: (s) => est.countText(s), headShare: 0.8, imageTokens: 1568 };

test('array content: text parts only, largest first; images untouched until R4', () => {
  const big = 'line of text\n'.repeat(3000);
  const m: ChatMessage = {
    role: 'tool', tool_call_id: 'c', content: [
      { type: 'text', text: 'small part' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: big },
    ],
  };
  const e = truncateText(m, 2000, env)!;
  const parts = e.message.content as Array<{ type: string; text?: string }>;
  assert.equal(parts[0]!.text, 'small part');
  assert.equal(parts[1]!.type, 'image_url');
  assert.ok(parts[2]!.text!.includes('[kitzur: this output was truncated'));
  assert.ok(messageSize(e.message, env) <= messageSize(m, env) - 2000);
  const o = omitOneImage(e.message)!;
  assert.deepEqual((o.content as Array<{ text?: string }>)[1], { type: 'text', text: IMAGE_OMITTED });
  assert.equal(omitOneImage(o), null);
  // image omissions carry over to a recomputation from the original
  const again = carryImageOmissions(m, o);
  assert.deepEqual((again.content as Array<{ text?: string }>)[1], { type: 'text', text: IMAGE_OMITTED });
  assert.equal((again.content as Array<{ text?: string }>)[2]!.text, big);
});

test('R5: assistant content and argument strings cut, arguments stay valid JSON with key order', () => {
  const long = 'x'.repeat(20_000);
  const m: ChatMessage = {
    role: 'assistant', content: 'thinking out loud '.repeat(500), reasoning_content: 'r'.repeat(100),
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'write', arguments: `{"filePath": "/x", "2": "num", "content": "${long}", "n": 1.0}` } },
      { id: 'b', type: 'function', function: { name: 'bash', arguments: 'not json {' } },
    ],
  };
  const out = cutAssistant(m, 5000, env)!;
  assert.ok(!('reasoning_content' in out));
  assert.ok(messageSize(out, env) <= messageSize(m, env) - 5000);
  const args = out.tool_calls![0]!.function.arguments;
  const parsed = JSON.parse(args) as Record<string, unknown>;
  assert.equal(parsed['filePath'], '/x');
  assert.ok((parsed['content'] as string).includes('[kitzur: this output was truncated'));
  // key order as sent ("2" is integer-like: a plain JS object would hoist it)
  assert.ok(args.indexOf('"filePath"') < args.indexOf('"2"'));
  assert.ok(args.endsWith('"n":1.0}'), 'floats keep their form');
  assert.equal(out.tool_calls![1]!.function.arguments, 'not json {');
});

test('slimText uses ToolRules.slimSnapshot and requires a smaller result', () => {
  const rules = new StubRules(testConfig());
  const snap = toolOutput(4, { capBytes: 51_200 });
  const m: ChatMessage = { role: 'tool', tool_call_id: 'c', content: snap };
  const s = slimText(m, 1_000_000, rules, env)!;
  assert.ok(env.text(s.content as string) < env.text(snap));
  assert.equal(slimText(m, 5, rules, env), null);
});

test('fmtK: one-decimal thousands that never contain an OpenCode retry run', () => {
  assert.equal(fmtK(26_000), '26.0k');
  assert.equal(fmtK(24_256), '24.3k');
  assert.equal(fmtK(500_000), '499.9k');
  assert.equal(fmtK(429_500), '428.9k');
  assert.equal(fmtK(1_502_300), '1501.9k');
  for (let n = 0; n < 3_000_000; n += 37) assert.ok(!OPENCODE_RETRY_RE.test(fmtK(n)), `${n} -> ${fmtK(n)}`);
});

// reference implementation (27 overflow patterns + exclusions): the fixed-prompt body must match none
const OVERFLOW = [
  /prompt is too long/i, /request_too_large/i, /input is too long for requested model/i, /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i, /maximum prompt length is \d+/i, /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i, /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, /exceeds the limit of \d+/i,
  /exceeds the available context size/i, /greater than the context length/i, /context window exceeds limit/i,
  /exceeded model token limit/i, /context[_ ]length[_ ]exceeded/i, /request entity too large/i, /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i, /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i, /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i, /too many tokens/i, /token limit exceeded/i, /^4(00|13)\s*(status code)?\s*\(no body\)/i,
];

test('§5.7 (b) fixed-prompt body: exact shape, no overflow pattern, no retry run', () => {
  const b = fixedPromptTooLarge(26_000, 24_256, 32_768, 8_000);
  assert.equal(
    JSON.stringify(b),
    '{"error":{"message":"kitzur: the system prompt and tool definitions alone need about 26.0k tokens, but at most 24.3k fit in this model\'s window (32.8k) after reserving 8.0k for the reply. Remove tools or MCP servers, or shorten the system prompt.","type":"invalid_request_error","param":null,"code":"kitzur_fixed_prompt_too_large"}}',
  );
  for (const n of [1000, 26_000, 150_000, 429_000, 502_000, 5_240_000]) {
    const s = JSON.stringify(fixedPromptTooLarge(n, n - 5000, n + 11_111, 8192));
    assert.ok(!OPENCODE_RETRY_RE.test(s), s);
    for (const re of OVERFLOW) assert.ok(!re.test(b.error.message), `${re}`);
  }
  const c = contextLengthExceeded(502_000, 99_000, 100_000, 32_000);
  assert.equal(c.error.code, 'context_length_exceeded');
  assert.ok(!OPENCODE_RETRY_RE.test(JSON.stringify(c)));
});
