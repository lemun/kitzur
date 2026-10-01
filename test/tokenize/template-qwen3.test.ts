import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { qwen3Profile, renderPrompt, TemplateError, type Qwen3Options } from '../../src/tokenize/template.js';
import { createCounter } from '../../src/tokenize/counter.js';
import type { ChatRequest } from '../../src/types.js';
import { ROOT } from '../helpers.js';
import { loadSimHistory, simRequest } from './sim-session.js';
import { testTokenizer } from './tok-helper.js';

// qwen3-goldens.json.gz (scripts/tokenizer/gen_template_goldens.py): the real Qwen3.6-27B chat template
// rendered by jinja2 as HF transformers does, after vLLM-style message preparation; token counts from
// Python tokenizers 0.23.2. `session` rows are reference-session requests (SIM_CAP_BYTES=51200).
interface Case {
  name: string;
  request: ChatRequest;
  profile: { enable_thinking?: boolean; preserve_thinking?: boolean };
  render?: string;
  tokens?: number;
  images?: number;
  error?: string;
}
const G = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'qwen3-goldens.json.gz'))).toString('utf8')) as {
  template_sha256: string;
  cases: Case[];
  session: Array<{ variant: string; steps: number; profile: Case['profile']; render_sha256: string; render_len: number; tokens: number; sim_tokens: number }>;
};
const optsOf = (p: Case['profile']): Qwen3Options => ({ enableThinking: p.enable_thinking ?? null, preserveThinking: p.preserve_thinking ?? false });
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

test('golden fixture is for the committed template copy', () => {
  const t = readFileSync(join(ROOT, 'scripts', 'tokenizer', 'qwen3.6-chat-template.jinja'), 'utf8');
  assert.equal(sha(t), G.template_sha256);
  assert.ok(G.cases.length >= 40);
});

test('qwen3 profile renders byte-exactly what the real Qwen3.6 template renders (jinja2 goldens)', () => {
  let rendered = 0;
  for (const cs of G.cases) {
    if (cs.error !== undefined) continue;
    assert.equal(renderPrompt(qwen3Profile(optsOf(cs.profile)), cs.request), cs.render, cs.name);
    rendered++;
  }
  assert.ok(rendered >= 35);
});

test('qwen3 profile raises the template errors as TemplateError with the same message', () => {
  const errs = G.cases.filter((c) => c.error !== undefined);
  assert.ok(errs.length >= 6);
  for (const cs of errs) {
    assert.throws(
      () => renderPrompt(qwen3Profile(optsOf(cs.profile)), cs.request),
      (e: unknown) => e instanceof TemplateError && e.message === cs.error && e.code === 'template_error',
      cs.name,
    );
  }
});

const tok = testTokenizer();
const skip = tok ? false : 'no dev tokenizer.json';

test('qwen3 counter: total == Python token count of the real render; Σ perMessage + overhead == total', { skip }, () => {
  for (const cs of G.cases) {
    // imageTokens = 3 makes an image cost exactly its placeholder <|vision_start|><|image_pad|><|vision_end|>
    const counter = createCounter({ mode: 'exact', template: qwen3Profile(optsOf(cs.profile)), tokenizer: tok, imageTokens: 3 });
    if (cs.error !== undefined) {
      assert.throws(() => counter.measure(cs.request), TemplateError, cs.name);
      continue;
    }
    const m = counter.measure(cs.request);
    assert.equal(m.total, cs.tokens, cs.name);
    assert.equal(m.perMessage.length, cs.request.messages.length);
    assert.equal(m.perMessage.reduce((a, b) => a + b, 0) + m.overhead, m.total, cs.name);
    assert.equal(tok!.count(cs.render!), cs.tokens, cs.name);
  }
});

test('qwen3 counter: the tools block is merged into message 0 when it is a system message, else overhead', { skip }, () => {
  const byName = new Map(G.cases.map((c) => [c.name, c]));
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: tok });
  const withSys = counter.measure(byName.get('tools + system + user')!.request);
  const noSys = counter.measure(byName.get('tools, no system')!.request);
  assert.ok(withSys.perMessage[0]! > 300, 'system piece holds the tools block');
  assert.ok(withSys.overhead <= 6, 'only the generation prompt');
  assert.ok(noSys.overhead > 300, 'standalone tools block is overhead');
});

test('qwen3 counter: a tool result first (piece boundary not next to an added token) is still exact', { skip }, () => {
  const cs = G.cases.find((c) => c.name === 'tool message first')!;
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: tok });
  assert.equal(counter.measure(cs.request).total, cs.tokens);
  assert.ok(counter.stats().jointRecounts >= 1);
  assert.equal(counter.measure(cs.request).total, cs.tokens); // cached path, same answer
});

test('qwen3: a developer message mid-history is merged into one leading system message, as vLLM does (not a TemplateError)', { skip }, () => {
  // regression: the profile used to rename developer -> system and then raise 'System message must be at
  // the beginning.'; vLLM (renderers/hf.py _consolidate_system_messages) renders it (goldens: '(consolidated)')
  const byName = new Map(G.cases.map((c) => [c.name, c]));
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: tok, imageTokens: 3 });
  const cs = byName.get('developer mid-history (consolidated)')!;
  const m = counter.measure(cs.request);
  assert.equal(m.total, cs.tokens);
  // the merged header is message 0's; the developer message itself contributes nothing
  assert.equal(m.perMessage[1], 0);
  assert.equal(m.perMessage[0], tok!.count('<|im_start|>system\nlate<|im_end|>\n<|im_start|>user\nx<|im_end|>\n'));
  const big = byName.get('system + developer mid-history + tools (consolidated)')!;
  const mb = counter.measure(big.request);
  assert.equal(mb.total, big.tokens);
  assert.equal(mb.perMessage[4], 0);
  // cache key of message 0 follows the merged text: same messages 0..3, another developer text
  const other = structuredClone(big.request);
  other.messages[4]!.content = 'Another, much longer developer note.';
  const want = tok!.count(renderPrompt(qwen3Profile(), other));
  assert.notEqual(want, big.tokens);
  assert.equal(counter.measure(other).total, want);
  assert.equal(counter.measure(big.request).total, big.tokens);
  // errors keep the original message index (virtual [system, user, function]: the function message is original 1)
  assert.throws(
    () => renderPrompt(qwen3Profile(), { messages: [{ role: 'user', content: 'q' }, { role: 'function', content: 'r' }, { role: 'developer', content: 'd' }] }),
    (e: unknown) => e instanceof TemplateError && e.message === 'Unexpected message role.' && e.index === 1,
  );
  // without a developer message the template's own error stands
  assert.throws(() => renderPrompt(qwen3Profile(), { messages: [{ role: 'user', content: 'q' }, { role: 'system', content: 's' }] }), /System message must be at the beginning/);
});

test('qwen3 counter on the reference session (cap 51200): render sha and token counts match the real template', { skip }, () => {
  const h = loadSimHistory();
  const counters = new Map<string, ReturnType<typeof createCounter>>();
  for (const row of G.session) {
    const opts = optsOf(row.profile);
    const key = JSON.stringify(opts);
    if (!counters.has(key)) counters.set(key, createCounter({ mode: 'exact', template: qwen3Profile(opts), tokenizer: tok }));
    const req = simRequest(h, row.steps, { cap: 51200 });
    const r = renderPrompt(qwen3Profile(opts), req);
    assert.equal(r.length, row.render_len, `steps ${row.steps}`);
    assert.equal(sha(r), row.render_sha256, `steps ${row.steps}`);
    assert.equal(counters.get(key)!.countRequest(req), row.tokens, `steps ${row.steps} ${key}`);
  }
  // reference implementation: real 9,564 / 317,179 vs sim 9,376 / 316,604
  const s46 = G.session.find((r) => r.steps === 46 && !r.profile.enable_thinking && r.profile.enable_thinking !== false)!;
  assert.equal(s46.tokens, 317_189);
  assert.equal(s46.sim_tokens, 316_614);
});
