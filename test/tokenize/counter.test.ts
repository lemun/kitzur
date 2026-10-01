import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { counterFromConfig, createCounter } from '../../src/tokenize/counter.js';
import { remoteFromConfig } from '../../src/tokenize/remote.js';
import { createProfile, GLUE_TOKENS, renderPrompt, TemplateError, type TemplateName } from '../../src/tokenize/template.js';
import { classifyContent, estimateText, type CharsPerToken } from '../../src/tokenize/estimate.js';
import { digestOf } from '../../src/tokenize/canonical.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import type { Tokenizer } from '../../src/tokenize/tokenizer.js';
import type { ChatMessage, ChatRequest, ToolCall } from '../../src/types.js';
import { ROOT } from '../helpers.js';
import { loadSimHistory, simRequest } from './sim-session.js';
import { testTokenizer } from './tok-helper.js';

const tok = testTokenizer();
const skip = tok ? false : 'no dev tokenizer.json';

// ---------------------------------------------------------------- random requests (seeded)

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// fragments chosen to stress segment boundaries: whitespace/newline merges, added tokens inside
// content, partial tokens, Python-vs-JS whitespace, non-Latin, astral, CRLF
const FRAG = [
  '', ' ', '  ', '\n', '\n\n', '\r\n', '\t', 'hello', 'Hello world.', 'x', ' y', 'code();\n', '  indented\n',
  '<|im_end|>', '<|im_start|>', '<tool_call>', '</tool_call>', '<tool_response>', '</tool_response>', '<think>', '</think>',
  '<|im_', 'end|>', '<parameter=x>', 'שלום', 'עגלה ₪12.90', '😀', '👍🏽', '中文', '\u0085', '﻿', '\u001c', ' ',
  '1234567', '$19.99', '- button "Pay" [ref=e12]', '{"a": 1}', "it's", 'é', 'é', 'ſ',
];

function randomText(r: () => number, max = 6): string {
  let s = '';
  const k = Math.floor(r() * max);
  for (let i = 0; i < k; i++) s += FRAG[Math.floor(r() * FRAG.length)]!;
  return s;
}

function randomArgs(r: () => number): string {
  const pick = r();
  if (pick < 0.05) return '';
  if (pick < 0.1) return '{broken';
  if (pick < 0.15) return '[1, 2]';
  const parts: string[] = [];
  const k = Math.floor(r() * 4);
  for (let i = 0; i < k; i++) {
    const key = ['filePath', 'command', 'n', 'flag', 'obj', '10', 'x y'][Math.floor(r() * 7)]!;
    const v = [
      () => JSON.stringify(randomText(r)),
      () => String(Math.floor(r() * 1000)),
      () => '1.0',
      () => '-0.5e-7',
      () => 'true',
      () => 'null',
      () => `{"a": [${JSON.stringify(randomText(r, 3))}, 2.50]}`,
    ][Math.floor(r() * 7)]!();
    parts.push(`${JSON.stringify(key)}: ${v}`);
  }
  return '{' + parts.join(', ') + '}';
}

function randomContent(r: () => number): ChatMessage['content'] {
  const p = r();
  if (p < 0.1) return null;
  if (p < 0.25) {
    const parts: unknown[] = [];
    const k = 1 + Math.floor(r() * 3);
    for (let i = 0; i < k; i++) {
      parts.push(r() < 0.15 ? { type: 'image_url', image_url: { url: 'data:x' } } : { type: 'text', text: randomText(r) });
    }
    return parts as ChatMessage['content'];
  }
  return randomText(r);
}

const TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read a file ✓', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } },
  { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', minimum: 0.5 } } } } },
];

/** A random valid-ish chat as a sequence of growing requests (each a prefix of the next). */
function randomChain(seed: number): ChatRequest[] {
  const r = rng(seed);
  const msgs: ChatMessage[] = [];
  const tools = r() < 0.6 ? TOOLS.slice(0, 1 + Math.floor(r() * 2)) : undefined;
  if (r() < 0.7) msgs.push({ role: 'system', content: r() < 0.2 ? [{ type: 'text', text: randomText(r) }] : randomText(r) });
  if (r() < 0.05) msgs.push({ role: 'tool', tool_call_id: 'orphan', content: randomText(r) });
  msgs.push({ role: 'user', content: randomContent(r) });
  const kw = r() < 0.2 ? { enable_thinking: r() < 0.5 } : r() < 0.1 ? { preserve_thinking: true } : null;
  const out: ChatRequest[] = [];
  const snap = (): void => {
    const req: ChatRequest = { model: 'm', messages: msgs.slice() };
    if (tools) req.tools = tools;
    if (kw) req['chat_template_kwargs'] = kw;
    out.push(req);
  };
  snap();
  const steps = 1 + Math.floor(r() * 6);
  let id = 0;
  for (let s = 0; s < steps; s++) {
    const calls: ToolCall[] = [];
    const nc = r() < 0.3 ? 0 : 1 + Math.floor(r() * 3);
    for (let i = 0; i < nc; i++) calls.push({ id: `c${id++}`, type: 'function', function: { name: r() < 0.5 ? 'read' : 'bash', arguments: randomArgs(r) } });
    const a: ChatMessage = { role: 'assistant', content: r() < 0.3 ? null : randomContent(r) };
    if (nc || r() < 0.2) a.tool_calls = calls;
    const rr = r();
    if (rr < 0.2) a.reasoning_content = randomText(r);
    else if (rr < 0.25) a.reasoning = randomText(r);
    msgs.push(a);
    for (const c of calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: r() < 0.2 ? [{ type: 'text', text: randomText(r) }, { type: 'text', text: randomText(r) }] : randomContent(r) });
    if (r() < 0.3) msgs.push({ role: 'user', content: r() < 0.2 ? `<tool_response>\n${randomText(r)}\n</tool_response>` : randomContent(r) });
    snap();
  }
  return out;
}

// ---------------------------------------------------------------- additivity / exactness

for (const name of ['sim', 'qwen3', 'chatml'] as TemplateName[]) {
  test(`${name}: Σ perMessage + overhead == tokenizer count of the full render, on 400 random chains with a shared cache`, { skip }, () => {
    const profile = createProfile(name);
    // imageTokens = 3: an image then costs exactly its placeholder's 3 added tokens
    const counter = createCounter({ mode: 'exact', template: profile, tokenizer: tok, imageTokens: 3 });
    let checked = 0;
    let errors = 0;
    for (let seed = 1; seed <= 400; seed++) {
      for (const req of randomChain(seed)) {
        let full: string;
        try {
          full = renderPrompt(profile, req);
        } catch (e) {
          assert.ok(e instanceof TemplateError);
          assert.throws(() => counter.measure(req), TemplateError);
          errors++;
          continue;
        }
        const m = counter.measure(req);
        const want = tok!.count(full);
        assert.equal(m.total, want, `seed ${seed}: ${JSON.stringify(req).slice(0, 300)}`);
        assert.equal(m.perMessage.reduce((a, b) => a + b, 0) + m.overhead, m.total);
        assert.equal(m.perMessage.length, req.messages.length);
        checked++;
      }
    }
    assert.ok(checked > 1000, `${checked} checked`);
    if (name !== 'qwen3') assert.equal(errors, 0);
    const st = counter.stats();
    assert.ok(st.pieceHits > st.pieceMisses, 'prefix chains reuse cached pieces');
  });
}

test('generic: each message costs its content tokens plus perMessageOverhead; the generation prompt one more', { skip }, () => {
  const counter = createCounter({ mode: 'exact', template: 'generic', tokenizer: tok, fallback: { perMessageOverhead: 8 } });
  const req: ChatRequest = {
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: [{ type: 'text', text: 'part a' }, { type: 'text', text: 'part b' }] },
      { role: 'assistant', content: 'ok', reasoning_content: 'think', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{"filePath": "/a"}' } }] },
    ],
  };
  const m = counter.measure(req);
  const n = (s: string): number => tok!.count(s);
  assert.deepEqual(m.perMessage, [8 + n('You are terse.'), 8 + n('part a') + n('part b'), 8 + n('ok') + n('think') + n('read') + n('{"filePath": "/a"}')]);
  assert.equal(m.overhead, 8);
});

// ---------------------------------------------------------------- cache behaviour

function spy(t: Tokenizer): Tokenizer & { calls: number; chars: number } {
  const s = {
    ...t,
    calls: 0,
    chars: 0,
    count(text: string): number {
      s.calls++;
      s.chars += text.length;
      return t.count(text);
    },
  };
  return s;
}

test('cache: measuring the next step of a session tokenizes only its new messages (fresh request objects)', { skip }, () => {
  const h = loadSimHistory();
  for (const template of ['qwen3', 'sim'] as TemplateName[]) {
    const s = spy(tok!);
    const counter = createCounter({ mode: 'exact', template, tokenizer: s });
    counter.measure(simRequest(h, 20, { cap: 51200 }));
    const coldChars = s.chars;
    s.calls = 0;
    s.chars = 0;
    const next = simRequest(h, 21, { cap: 51200 }); // new objects, as the proxy parses every body anew
    const m = counter.measure(next);
    assert.equal(s.calls, 2, `${template}: the new assistant message and its tool result`);
    const newChars = next.messages.slice(-2).reduce((a, m) => a + JSON.stringify(m).length, 0);
    assert.ok(s.chars < newChars + 200, `${template}: ${s.chars} chars re-tokenized (cold: ${coldChars})`);
    // same result as a cold counter
    assert.equal(m.total, createCounter({ mode: 'exact', template, tokenizer: tok }).countRequest(next));
  }
});

test('cache: a new real user query re-renders the qwen3 assistant turns it moves out of the loop (render context in the key)', { skip }, () => {
  const h = loadSimHistory();
  const s = spy(tok!);
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: s });
  counter.measure(simRequest(h, 9, { cap: 51200 }));
  s.calls = 0;
  const r10 = simRequest(h, 10, { cap: 51200 }); // step 9's result + the USER-RULE-Q7 message + step... (the inject)
  const m = counter.measure(r10);
  // new: assistant 9, tool 9, the user inject; re-rendered without <think>: assistants 0..8
  assert.equal(s.calls, 3 + 9);
  assert.equal(m.total, createCounter({ mode: 'exact', template: 'qwen3', tokenizer: tok }).countRequest(r10));
});

test('cache: supplied digests are the cache keys; the same objects measured again cost no tokenization', { skip }, () => {
  const h = loadSimHistory();
  const s = spy(tok!);
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: s });
  const req = simRequest(h, 12, { cap: 51200 });
  const digests = req.messages.map((m) => 'engine:' + digestOf(m));
  const a = counter.measure(req, digests);
  const calls = s.calls;
  const b = counter.measure(req, digests);
  const c = counter.measure(req); // the counter's own digests: another key space, found by piece hash
  assert.equal(s.calls, calls, 'nothing re-tokenized across key spaces');
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  counter.measure(req);
  assert.equal(s.calls, calls, 'identity-memoized digests: nothing re-tokenized');
  // wrong-length digests are ignored rather than misaligned
  assert.deepEqual(counter.measure(req, digests.slice(1)), a);
});

test('cache: LRU capacity bounds the entries', { skip }, () => {
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: tok, cacheEntries: 16 });
  for (let i = 0; i < 40; i++) counter.measure({ messages: [{ role: 'user', content: `question ${i}` }] });
  assert.ok(counter.stats().entries <= 16);
});

test('counter id reflects mode, template options, tokenizer and fallback (planning-hash input)', () => {
  const a = createCounter({ mode: 'estimate', template: 'qwen3' });
  const b = createCounter({ mode: 'estimate', template: 'qwen3', templateOptions: { enableThinking: false } });
  const c = createCounter({ mode: 'estimate', template: 'qwen3', fallback: { safetyFactor: 1.2 } });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal(a.id, createCounter({ mode: 'estimate', template: 'qwen3' }).id);
  assert.throws(() => createCounter({ mode: 'exact', template: 'qwen3' }), /needs a tokenizer/);
});

test('measure() throws TemplateError where the template raises (engine catches it)', () => {
  const counter = createCounter({ mode: 'estimate', template: 'qwen3' });
  assert.throws(() => counter.measure({ messages: [{ role: 'user', content: 'x' }, { role: 'system', content: 'late' }] }), TemplateError);
  assert.throws(() => counter.measure({ messages: [{ role: 'assistant', content: 'x' }] }), /No user query found/);
  assert.throws(() => counter.measure({ messages: [] }), /No messages provided/);
});

// ---------------------------------------------------------------- estimate mode

const cptGatewayProbes: CharsPerToken = { prose: 5.464, code: 3.815, snapshot: 2.949, testOutput: 2.402, json: 2.334, snapshotNonLatin: 2.172 };
const cptDefault: CharsPerToken = DEFAULT_CONFIG.tokenizer.fallback.charsPerToken;
const safety = DEFAULT_CONFIG.tokenizer.fallback.safetyFactor;

interface Row { cat: string; text: string; tokens: number }
function estimateCorpus(): Row[] {
  const h = loadSimHistory();
  const rows = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'estimate-corpus.json.gz'))).toString('utf8')) as Array<{ cat: string; text?: string; step?: number; tokens: number }>;
  const out: Row[] = rows.map((r) => ({ cat: r.cat, tokens: r.tokens, text: r.text ?? (r.step === -1 ? h.system : h.steps[r.step!]!.output) }));
  // realistic categories of the Python-verified tokenizer fixture (ids inline)
  const fx = gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'tokenizer-fixture.jsonl.gz'))).toString('utf8').trimEnd().split('\n');
  for (const line of fx) {
    const { cat, text, ids } = JSON.parse(line) as { cat: string; text: string; ids: number[] };
    if (cat === 'snapshot' || cat === 'code' || cat === 'test-output' || cat === 'hebrew') out.push({ cat: 'fx:' + cat, text, tokens: ids.length });
  }
  return out;
}

function byCategory(rows: Row[], cpt: CharsPerToken): Map<string, { est: number; exact: number; min: number }> {
  const m = new Map<string, { est: number; exact: number; min: number }>();
  for (const r of rows) {
    const e = estimateText(r.text, { charsPerToken: cpt, safetyFactor: safety });
    const g = m.get(r.cat) ?? { est: 0, exact: 0, min: Infinity };
    g.est += e;
    g.exact += r.tokens;
    g.min = Math.min(g.min, e / r.tokens);
    m.set(r.cat, g);
  }
  return m;
}

test('estimate: classes are recognised on the reference content', () => {
  const rows = estimateCorpus();
  const want: Record<string, string> = {
    'ep:english_prose': 'prose', 'ep:typescript_code': 'code', 'ep:playwright_snapshot_en': 'snapshot', 'ep:test_runner_output': 'testOutput',
    'ep:json_api': 'json', 'ep:playwright_snapshot_he': 'snapshotNonLatin', 'sim:snapshot': 'snapshot', 'sim:navigate': 'snapshot',
    'sim:click': 'snapshot', 'sim:test': 'testOutput', 'sim:read': 'code', 'sim:todo': 'json', 'sim:ls': 'json', 'sim:grep': 'code',
    'he:plain': 'snapshotNonLatin', 'he:prose': 'snapshotNonLatin', 'sim:system': 'prose', 'fx:snapshot': 'snapshot', 'fx:code': 'code', 'fx:test-output': 'testOutput',
  };
  for (const r of rows) if (want[r.cat]) assert.equal(classifyContent(r.text), want[r.cat], r.cat);
});

test('estimate: within 30% of exact per content category with gateway-probes ratios (x safetyFactor 1.1)', () => {
  const rows = estimateCorpus();
  for (const [cat, g] of byCategory(rows, cptGatewayProbes)) {
    // skip: the adversarial niqqud corpus (reported), and categories under 500 tokens (rounding, one tiny sample)
    if (cat === 'fx:hebrew' || g.exact < 500) continue;
    const q = g.est / g.exact;
    assert.ok(q > 0.7 && q < 1.3, `${cat}: est/exact ${q.toFixed(3)}`);
  }
});

test('estimate: errs high on snapshots and Hebrew UI text with the default ratios and safetyFactor', () => {
  const rows = estimateCorpus();
  const cats = byCategory(rows, cptDefault);
  for (const cat of ['ep:playwright_snapshot_en', 'ep:playwright_snapshot_he', 'sim:snapshot', 'sim:navigate', 'sim:click', 'fx:snapshot', 'he:plain', 'he:prose', 'ep:test_runner_output', 'sim:test', 'ep:typescript_code', 'sim:read']) {
    const g = cats.get(cat)!;
    assert.ok(g.est >= g.exact, `${cat}: est ${g.est} < exact ${g.exact}`);
    // per sample: never more than 2% under (one 36k-char corpus snapshot is at 0.99 with snapshot=3.05)
    assert.ok(g.min >= 0.98, `${cat}: worst sample est/exact ${g.min.toFixed(3)}`);
  }
});

test('estimate: whole reference requests (qwen3, sim, chatml) err high; within 15% once tool outputs dominate', { skip }, () => {
  const h = loadSimHistory();
  for (const template of ['qwen3', 'sim', 'chatml'] as TemplateName[]) {
    const exact = createCounter({ mode: 'exact', template, tokenizer: tok });
    const estDefault = createCounter({ mode: 'estimate', template });
    const estPack = createCounter({ mode: 'estimate', template, fallback: { charsPerToken: cptGatewayProbes } });
    for (const steps of [0, 1, 5, 10, 20, 46]) {
      const req = simRequest(h, steps, { cap: 51200 });
      const x = exact.countRequest(req);
      const qd = estDefault.countRequest(req) / x;
      const qp = estPack.countRequest(req) / x;
      // steps 0-1 are dominated by the English system prompt and tool schemas: the default prose
      // ratio (4.0 chars/token) is conservative for Qwen English (~5.4), hence up to +40%
      assert.ok(qd >= 1 && qd < (steps < 5 ? 1.45 : 1.15), `${template} steps ${steps} default ratios: ${qd.toFixed(3)}`);
      assert.ok(qp >= 1 && qp < 1.25, `${template} steps ${steps} gateway-probes ratios: ${qp.toFixed(3)}`);
    }
  }
});

test('estimate: a mostly-English text with Hebrew labels is not costed at the English ratio', () => {
  const heb = 'המשך לתשלום סל קניות קופון משלוח';
  const text = Array.from({ length: 40 }, (_, i) => `- button "${i % 3 ? 'Continue to payment' : heb}" [ref=e${i}]`).join('\n');
  const flat = Math.ceil((text.length / cptDefault.prose) * safety);
  assert.ok(estimateText(text, { charsPerToken: cptDefault, safetyFactor: safety }) > flat);
  if (tok) assert.ok(estimateText(text, { charsPerToken: cptDefault, safetyFactor: safety }) >= tok.count(text));
});

test('estimate: classification stays linear on long blank-line runs (regex backtracking)', () => {
  // regression: TEST_TALLY's `^\s*` under /m rescanned the rest of a blank-line run from every line
  // start: 40k newlines took ~10 s and 40k CRLF ~38 s, blocking the synchronous measure()
  const t0 = performance.now();
  for (const s of ['\n'.repeat(80_000), '\r\n'.repeat(80_000), ' \n'.repeat(80_000), '\n'.repeat(80_000) + '  Tests: 3 passed']) {
    estimateText(s, { charsPerToken: cptDefault, safetyFactor: safety });
  }
  assert.ok(performance.now() - t0 < 2000, `${(performance.now() - t0).toFixed(0)} ms`);
  // the tally after indentation (and after a blank-line run) is still recognised
  assert.equal(classifyContent('\n\n\n   Tests:  3 failed, 9 total\n'), 'testOutput');
  assert.equal(classifyContent('\r\n\r\nTests: 12\r\n'), 'testOutput');
});

test('estimate mode counts template tokens and images; countText estimates plain text', () => {
  const counter = createCounter({ mode: 'estimate', template: 'qwen3', imageTokens: 1568 });
  const m = counter.measure({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'x' } }] }] });
  assert.ok(m.perMessage[0]! >= 1568 + 2 + 3); // image + <|im_start|>, <|im_end|> + text
  assert.ok(m.overhead >= 3); // <|im_start|>assistant\n<think>\n
  assert.equal(counter.countText(''), 0);
  assert.ok(counter.countText('hello world, this is prose') > 0);
});

test('estimate: the glue token table matches the Qwen3.6 tokenizer', { skip }, () => {
  for (const [glue, n] of GLUE_TOKENS) assert.equal(tok!.count(glue), n, JSON.stringify(glue).slice(0, 60));
});

test('counterFromConfig: exact with a tokenizer, remote with an endpoint client, else estimate; config knobs carried', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tokenizer.template = { name: 'qwen3', enableThinking: false, preserveThinking: null };
  cfg.tokenizer.imageTokens = 100;
  const est = counterFromConfig(cfg);
  assert.equal(est.mode, 'estimate');
  assert.equal(est.profile.name, 'qwen3');
  assert.match(est.id, /think=false/);
  assert.match(est.id, /img=100/);
  // enable_thinking=false generation prompt: <|im_start|>assistant\n<think>\n\n</think>\n\n = 7 tokens
  assert.equal(est.measure({ messages: [{ role: 'user', content: 'x' }] }).overhead, 7);
  assert.equal(remoteFromConfig(cfg), null, 'no endpoint style configured');
  cfg.upstream.origin = 'http://127.0.0.1:9';
  cfg.tokenizer.endpoint.style = 'llamacpp';
  const remote = remoteFromConfig(cfg)!;
  assert.equal(remote.url, 'http://127.0.0.1:9/tokenize');
  const rc = counterFromConfig(cfg, { remote });
  assert.equal(rc.mode, 'remote');
  assert.equal(typeof rc.prefetch, 'function');
  remote.close();
  if (tok) {
    const ex = counterFromConfig(DEFAULT_CONFIG, { tokenizer: tok });
    assert.equal(ex.mode, 'exact');
    assert.ok(ex.id.includes(tok.sha256));
    assert.equal(ex.prefetch, undefined);
  }
});

test('countText: exact, and long texts are cached by content hash', { skip }, () => {
  const s = spy(tok!);
  const counter = createCounter({ mode: 'exact', template: 'qwen3', tokenizer: s });
  const long = 'The following is a summary of your previous actions. '.repeat(40);
  assert.equal(counter.countText(long), tok!.count(long));
  assert.equal(counter.countText(long), tok!.count(long));
  assert.equal(s.calls, 1);
  assert.equal(counter.countText('<|im_start|>user\nhi<|im_end|>'), 5);
});
