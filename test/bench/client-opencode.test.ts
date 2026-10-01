import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  classifyHttpError, classifyStreamError, CLEARED, preserveRecent, processedTotals, runOpenCode, usableTokens, type OpenCodeOptions,
} from '../../bench/client/opencode.js';
import * as S from '../../bench/client/opencode-strings.js';
import { CONTINUE_AFTER_OVERFLOW, CONTINUE_SHORT } from '../../bench/opencode-sim.js';
import { MockServer, type MockRecord, type MockServerOptions } from '../../bench/mock/server.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { referenceScenario, REFERENCE_FACTS } from '../../bench/lib/ref-spec.js';
import { GOAL_TEXT } from '../../bench/scenarios/reference.js';
import type { ChatMessage } from '../../src/types.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';

const tokPath = testTokenizerPath();
const counter = tokPath ? new PromptCounter(loadTokenizer(tokPath)) : null;
const skip = counter ? false : 'no dev tokenizer.json';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

test('OpenCode strings are byte-exact (sha256 of the extracted files) and have the measured token counts', { skip }, () => {
  const want: Array<[string, number, string, number]> = [
    [S.COMPACTION_SYSTEM, 630, '552db0de0af1873a8acd4a631e2548345d4c43192de1d9be69c8feab4b41f80c', 116],
    [S.SUMMARY_TEMPLATE, 1107, 'f508afb34ee881f5d317eda1fa22dff19426c257377796dad5b97436f4436e6a', 268],
    [S.SUMMARY_UPDATE_INSTRUCTIONS, 952, 'f089eb74bde1fb476647bae165d276f4e214eb32b5515f0d86bda9a0f26b6c15', 198],
    [S.TITLE_SYSTEM, 2120, 'e7a6848eba328f28c7e870874cf0591e4edbaf90d7602ad8fdfe90601c6e656f', 523],
    [S.COMPACTION_MARKER, 22, '66f7888b3951addfb842b8b0e10b81d33e70aeaa8d93dbb1d00bffcb9337684b', 7],
    [S.CONTINUE_PROACTIVE, 100, '80a62c1aa08786982ccca7e60fa1d71e6e807bd4af669df041041c5ffb17b0a0', 21],
    [S.CONTINUE_OVERFLOW, 429, '970617110c4b1ce1b55c31deac166b4a23eb84a5473f8fe8b29b93b906aecde1', 81],
  ];
  for (const [s, bytes, digest, tokens] of want) {
    assert.equal(Buffer.byteLength(s), bytes);
    assert.equal(sha(s), digest);
    assert.equal(counter!.countText(s), tokens, s.slice(0, 30));
  }
  assert.equal(S.CONTINUE_OVERFLOW, CONTINUE_AFTER_OVERFLOW);
  assert.equal(S.CONTINUE_PROACTIVE, CONTINUE_SHORT);
  // fixed prompt overhead outside the conversation: 1315 chars (first), 2237 + prior (update) [reference implementation]
  assert.equal(S.buildSummarizerPrompt('X', null).length - 1, 1315);
  assert.equal(S.buildSummarizerPrompt('X', 'P').length - 2, 2237);
  assert.ok(S.buildSummarizerPrompt('C', null).startsWith('Here is the conversation so far:\n\n<conversation>\nC\n</conversation>\n\n' + S.NEW_SUMMARY_INSTRUCTION));
  assert.equal(S.OVERFLOW_PATTERNS.length, 27);
});

test('overflow and retry classification matches OpenCode / Kilo (reference implementation measured table)', () => {
  const J = JSON.stringify;
  const rows: Array<[string, number, string, boolean, boolean, boolean]> = [
    // name, status, body, OpenCode overflow, Kilo overflow, retried when not overflow
    ['vllm 400 (mock_server)', 400, J({ object: 'error', type: 'BadRequestError', param: null, code: 400, message: "This model's maximum context length is 100000 tokens. However, you requested 115000 tokens (83000 in the messages, 32000 in the completion). Please reduce the length of the messages or completion." }), true, true, false],
    ['llama.cpp 400', 400, J({ error: { code: 400, type: 'exceed_context_size_error', message: 'the request exceeds the available context size, try increasing it', n_prompt_tokens: 83000, n_ctx: 100000 } }), true, true, false],
    ['gateway 502', 502, J({ error: { type: 'upstream_error', message: 'Upstream model server returned an error' } }), false, false, true],
    ['tgi 422', 422, J({ error_type: 'validation', error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 100000. Given: 83000 `inputs` tokens and 32000 `max_new_tokens`' }), false, false, false],
    ['sglang', 400, J({ object: 'error', message: "Requested token count exceeds the model's maximum context length of 100000 tokens. You requested a total of 115000 tokens: 83000 tokens from the input messages and 32000 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.", type: 'BadRequestError', param: null, code: 400 }), true, true, false],
    ['lmstudio', 400, J({ error: 'Trying to keep the first 83000 tokens when context the overflows. However, the model is loaded with context length of only 100000 tokens, which is not enough.' }), false, false, false],
    ['openai code', 400, J({ error: { message: "This model's maximum context length is 100000 tokens.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }), true, true, false],
    ['413 html', 413, '<html><head><title>413 Request Entity Too Large</title></head><body></body></html>', true, true, false],
    ['413 empty', 413, '', true, true, false],
    ['400 empty', 400, '', false, false, false],
    ['429 too many tokens', 429, J({ error: { message: 'Too many tokens, please wait before trying again.', type: 'rate_limit', code: 429 } }), true, false, true],
    ['nginx 502', 502, '<html>\r\n<head><title>502 Bad Gateway</title></head></html>', false, false, true],
    ['unknown400', 400, 'E_UPSTREAM_7: request refused', false, false, false],
  ];
  for (const [name, status, body, oc, kilo, retry] of rows) {
    const a = classifyHttpError(status, '', body, 'opencode');
    assert.equal(a.overflow, oc, `${name}: OpenCode`);
    assert.equal(classifyHttpError(status, '', body, 'kilo').overflow, kilo, `${name}: Kilo`);
    if (!kilo) assert.equal(classifyHttpError(status, '', body, 'kilo').retryable, retry, `${name}: retried`);
  }
  // in-stream: only code "context_length_exceeded" is an overflow; an unknown error is retried when its JSON has 500/502/…
  assert.deepEqual(classifyStreamError({ error: { message: "maximum context length is 1000 tokens", type: 'BadRequestError', code: 400 } }).overflow, false);
  assert.equal(classifyStreamError({ error: { message: 'you requested 1234 tokens', code: 400 } }).retryable, false);
  assert.equal(classifyStreamError({ error: { message: 'you requested 1500 tokens', code: 400 } }).retryable, true); // the no-word-boundary quirk
  assert.equal(classifyStreamError({ error: { message: 'x', code: 'context_length_exceeded' } }).overflow, true);
  assert.equal(classifyStreamError({ error: { message: JSON.stringify({ type: 'error', error: { code: 'context_length_exceeded' } }) } }).overflow, true);
  // usable / preserve_recent per window (reference implementation)
  assert.deepEqual([[32000, 8000], [64000, 16000], [100000, 32000], [128000, 32000]].map(([c, o]) => [usableTokens(c!, o!), preserveRecent(usableTokens(c!, o!))]),
    [[24000, 6000], [48000, 12000], [68000, 15000], [96000, 15000]]);
  assert.equal(usableTokens(100000, 0), 68000);
  assert.equal(usableTokens(0, 32000), 0);
});

async function withMock<T>(o: Omit<MockServerOptions, 'counter'>, fn: (m: MockServer, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-oc-'));
  const m = new MockServer({ counter: counter!, outDir: dir, ...o });
  await m.start(0);
  try {
    return await fn(m, dir);
  } finally {
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (m: MockServer, o: Partial<OpenCodeOptions>): ReturnType<typeof runOpenCode> =>
  runOpenCode({ base: m.url, counter: counter!, scenario: { capBytes: 51_200 }, context: 100_000, output: 32_000, ...o });
const bodyOf = (dir: string, r: MockRecord): { messages: ChatMessage[]; tools?: Array<{ function: { name: string } }>; max_tokens: number; [k: string]: unknown } =>
  JSON.parse(readFileSync(join(dir, r.body_file!), 'utf8'));

test('--baseline-compat reproduces baseline.py direct against the TS mock: 1,994,221 main + 462,177 rejected', { skip }, async () => {
  await withMock({ limit: 100_000 }, async (m) => {
    const r = await run(m, { mode: 'baseline-compat' });
    const t = processedTotals(m.records);
    assert.equal(r.stepsCompleted, 46);
    assert.equal(t.main, 1_994_221);
    assert.equal(t.rejected, 462_177);
    assert.equal(t.rejections, 6);
    assert.deepEqual(r.compactions.map((c) => [c.step, c.reason]), [10, 17, 25, 32, 38, 45].map((s) => [s, 'overflow']));
    assert.equal(r.baselineSummIn, 36_451); // baseline.py's summ_in estimate, re-computed on the same heads
    assert.equal(t.main + t.rejected + r.baselineSummIn, 2_492_849); // baseline.py total_prompt_tokens
    assert.equal(t.title, 0);
    assert.equal(t.summarizerRequests, 6);
  });
  // with outDir the client logs every request with its own body (origs/) and count, as bench/metrics collects them
  const out = mkdtempSync(join(tmpdir(), 'kitzur-oc-out-'));
  try {
    await withMock({ limit: 100_000 }, async (m) => {
      const r = await run(m, { mode: 'baseline-compat', steps: 11, outDir: out });
      const lines = readFileSync(join(out, 'client.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(lines.length, r.requests.length);
      const rejected = lines.find((l) => l['status'] === 400)!;
      assert.equal(rejected['client_error_kind'], 'http_400');
      assert.equal(rejected['overflow'], true);
      // direct: what the client counted for its request is what the mock counted
      const mains = m.records.filter((x) => (x.kind ?? 'main') === 'main');
      assert.deepEqual(lines.filter((l) => l['kind'] === 'main').map((l) => l['orig_qwen_tokens']), mains.map((x) => x.prompt_tokens));
      const ok = lines.find((l) => l['status'] === 200 && l['kind'] === 'main')!;
      assert.deepEqual(Object.keys(ok['usage'] as object), ['prompt_tokens', 'completion_tokens']);
      assert.ok(JSON.parse(readFileSync(join(out, ok['orig_file'] as string), 'utf8')).messages.length >= 2);
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  // 32k/8k exercises the usage trigger too: 17 compactions (16 overflow errors), 1,104,062 on baseline.py's basis
  await withMock({ limit: 32_000 }, async (m) => {
    const r = await run(m, { mode: 'baseline-compat', context: 32_000, output: 8_000 });
    const t = processedTotals(m.records);
    assert.equal(r.compactions.length, 17);
    assert.equal(r.compactions.filter((c) => c.reason === 'usage').length, 1);
    assert.equal(t.rejected, 465_665);
    assert.equal(t.main + t.rejected + r.baselineSummIn, 1_104_062);
  });
});

test('faithful mode: exact summarizer/title requests, wire conventions, long Continue after overflow, routed records', { skip }, async () => {
  const spec = referenceScenario({ capBytes: 51_200 });
  await withMock({ limit: 100_000, scenarios: [spec] }, async (m, dir) => {
    const r = await run(m, { spec });
    const t = processedTotals(m.records);
    assert.equal(r.stepsCompleted, 46);
    assert.equal(r.compactions.length, 6);
    // ≈ baseline.py with OpenCode's long Continue text (2,495,544): the faithful wire differs (sorted tools, compact
    // arguments, AI-SDK estimate, a title request, the mock-counted summarizer prompts)
    assert.ok(Math.abs(t.total / 2_495_544 - 1) < 0.01, `faithful processed ${t.total}`);
    assert.ok(m.records.every((x) => x.scenario === spec.id && JSON.stringify(Object.keys(x.facts)) === JSON.stringify(REFERENCE_FACTS.map((f) => f.marker))));
    const main0 = bodyOf(dir, m.records.find((x) => x.kind === 'main')!);
    assert.deepEqual(Object.keys(main0), ['model', 'max_tokens', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options']);
    const names = main0.tools!.map((x) => x.function.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    assert.equal(main0.max_tokens, 32_000);
    // title: [title.txt, "Generate a title…", the goal]
    const title = m.records.filter((x) => x.kind === 'title');
    assert.equal(title.length, 1);
    assert.deepEqual(bodyOf(dir, title[0]!).messages.map((x) => x.content), [S.TITLE_SYSTEM, S.TITLE_USER_PREFIX, GOAL_TEXT]);
    // summarizer: compaction.txt + buildPrompt; no tools; the first is a new summary, the later ones update it
    const summ = m.records.filter((x) => x.kind === 'summarizer').map((x) => bodyOf(dir, x));
    assert.equal(summ.length, 6);
    for (const [i, b] of summ.entries()) {
      assert.equal(b['tools'], undefined);
      assert.equal(b.messages[0]!.content, S.COMPACTION_SYSTEM);
      const u = b.messages[1]!.content as string;
      assert.ok(u.startsWith('Here is the conversation so far:\n\n<conversation>\n[') && u.endsWith(S.SUMMARY_TEMPLATE));
      assert.equal(u.includes('<prior-summary>\n## Objective'), i > 0);
      assert.equal(u.includes(S.SUMMARY_UPDATE_INSTRUCTIONS), i > 0);
      // tool results are cut at 2000 chars: no result line runs longer than 2000 chars + the marker
      for (const part of u.split('[Tool result]: ').slice(1)) assert.ok(part.split('\n[Assistant')[0]!.split('\n\n[')[0]!.split('\n</conversation>')[0]!.replace(/\n$/, '').length <= 2000 + '\n[truncated]'.length);
    }
    assert.ok((summ[0]!.messages[1]!.content as string).includes('\n[truncated]'));
    // the request after the first compaction: [system, marker, summary, tail…, long Continue]
    const after = m.records.filter((x) => x.kind === 'main' && x.step === 10 && x.status === 200).map((x) => bodyOf(dir, x))[0]!;
    assert.deepEqual(after.messages.slice(1, 2), [{ role: 'user', content: S.COMPACTION_MARKER }]);
    assert.ok((after.messages[2]!.content as string).startsWith('## Objective'));
    assert.deepEqual(after.messages.at(-1), { role: 'user', content: S.CONTINUE_OVERFLOW });
    // assistant wire: content "" on tool-only turns, arguments re-serialized compactly
    const assts = after.messages.filter((x) => x.role === 'assistant' && x.tool_calls);
    assert.ok(assts.some((x) => x.content === ''));
    assert.ok(assts.every((x) => x.tool_calls!.every((c) => !c.function.arguments.includes('": '))));
  });
});

test('retries run on a virtual clock (retry.ts: 5 retries, 2000·2^(n−1)·[1, 1.25] ms), 502 is not an overflow', { skip }, async () => {
  await withMock({ limit: 60_000, errorStyle: 'gateway502' }, async (m) => {
    const t0 = performance.now();
    const r = await run(m, { steps: 12 });
    const wall = performance.now() - t0;
    assert.equal(r.error?.kind, 'http_502');
    assert.equal(r.error?.status, 502);
    const step = r.error!.step;
    const tries = r.requests.filter((x) => x.kind === 'main' && x.step === step);
    assert.deepEqual(tries.map((x) => x.retry), [0, 1, 2, 3, 4, 5]);
    assert.ok(tries.every((x) => x.status === 502 && !x.overflow && x.retryable));
    assert.ok(r.virtualMs >= 62_000 && r.virtualMs <= 77_500, `virtual ${r.virtualMs} ms`);
    assert.ok(wall < 20_000, 'nothing slept');
    assert.equal(r.compactions.length, 0);
  });
});

test('413 is an overflow: OpenCode compacts on the gateway\'s page and completes', { skip }, async () => {
  await withMock({ limit: 100_000, spec: { errorStyle: 'http413', maxBodyBytes: 200_000 } }, async (m) => {
    const r = await run(m, {});
    assert.equal(r.stepsCompleted, 46);
    assert.ok(m.records.some((x) => x.status === 413 && x.reject_reason === 'bytes'));
    assert.ok(r.compactions.length > 0 && r.compactions.every((c) => c.reason === 'overflow'));
    assert.ok(r.requests.filter((x) => x.status === 413).every((x) => x.overflow));
  });
});

test('manual compaction (client-compact event) plants the client-summary markers, which later requests carry', { skip }, async () => {
  const facts = [...REFERENCE_FACTS,
    { id: 'cs1', marker: 'CS-ONLY-P4W7Q', channel: 'client-summary' as const, expect: 'survive' as const, gate: true },
    { id: 'cs2', marker: 'CS-ONLY-T9J2X', channel: 'client-summary' as const, expect: 'survive' as const, gate: true }];
  const spec = referenceScenario({ capBytes: 51_200 }, { id: 'cc-ref', facts, steps: 9, events: [{ atStep: 6, kind: 'client-compact' }] });
  await withMock({ limit: 100_000, scenarios: [spec] }, async (m) => {
    const r = await run(m, { spec });
    assert.deepEqual(r.compactions.map((c) => [c.step, c.reason, c.continueText]), [[6, 'manual', 'short']]);
    const mains = m.records.filter((x) => x.kind === 'main');
    assert.deepEqual(mains.map((x) => x.facts['CS-ONLY-P4W7Q'] && x.facts['CS-ONLY-T9J2X']), mains.map((x) => x.step >= 6));
    assert.ok(mains.filter((x) => x.step >= 6).every((x) => x.facts['GOAL-CHK-7F3A']), 'the goal survives in the summary');
  });
  // a scenario that carries its own client summary (bench/scenarios ScenarioDef.clientCompact, F10): the mock returns
  // it for the summarizer request of that step, and trigger 'overflow' gives the long Continue text
  const summaryText = '## Objective\n- migrate the checkout suite\n\n## Important Details\n- CS-ONLY-P4W7Q keep\n- CS-ONLY-T9J2X keep';
  const withCc = { ...spec, id: 'cc-ref-2', clientCompact: { atStep: 6, trigger: 'overflow', summaryText, summaryTokens: 40 } };
  await withMock({ limit: 100_000, scenarios: [withCc] }, async (m, dir) => {
    const r = await run(m, { spec: withCc });
    assert.deepEqual(r.compactions.map((c) => [c.step, c.reason, c.continueText]), [[6, 'manual', 'long']]);
    const first = bodyOf(dir, m.records.find((x) => x.kind === 'main' && x.step === 6)!);
    assert.equal(first.messages[2]!.content, summaryText);
    assert.equal(first.messages.at(-1)!.content, S.CONTINUE_OVERFLOW);
  });
});

test('Kilo variant: content null, <environment_details> parts, capOutputTokens, 2-turn tail, payload-limit prune', { skip }, async () => {
  await withMock({ limit: 100_000 }, async (m, dir) => {
    const r = await run(m, { variant: 'kilo', steps: 30 });
    assert.equal(r.stepsCompleted, 30);
    const mains = m.records.filter((x) => x.kind === 'main').map((x) => bodyOf(dir, x));
    assert.ok(mains.some((b) => b.max_tokens < 32_000 && b.max_tokens >= 1024), 'KiloLLM.capOutputTokens');
    const b = mains.at(-1)!;
    const users = b.messages.filter((x) => x.role === 'user');
    assert.ok(users.length >= 2 && users.every((u) => Array.isArray(u.content) && (u.content[1] as { text: string }).text.includes('<environment_details>\nMessage time: ')));
    assert.ok(b.messages.some((x) => x.role === 'assistant' && x.tool_calls && x.content === null));
    // Kilo keeps at most the 2 newest user turns: count the tail's user messages right after each compaction
    assert.ok(r.compactions.length > 0);
    let afterSummary = false;
    for (const x of m.records) {
      if (x.kind === 'summarizer') afterSummary = true;
      else if (x.kind === 'main' && afterSummary) {
        afterSummary = false;
        const msgs = bodyOf(dir, x).messages;
        assert.equal((msgs[1]!.content as Array<{ text: string }>)[0]!.text, S.COMPACTION_MARKER);
        assert.ok(msgs.slice(3, -1).filter((y) => y.role === 'user').length <= 2);
      }
    }
  });
  // no client compaction (a huge declared window) and a 1.2 MB snapshot at step 4: the history passes 1.25 MB and
  // Kilo's payload-limit prune rewrites the old tool results
  await withMock({ limit: 5_000_000 }, async (m, dir) => {
    const r = await runOpenCode({ base: m.url, counter: counter!, scenario: { hugeAt: 4, hugeChars: 1_200_000 }, context: 5_000_000, output: 32_000, variant: 'kilo', steps: 12, title: false });
    assert.equal(r.compactions.length, 0);
    const bodies = m.records.map((x) => bodyOf(dir, x));
    const first = bodies.findIndex((x) => x.messages.some((y) => y.role === 'tool' && y.content === CLEARED));
    assert.ok(first > 0, 'pruned');
    const last = bodies.at(-1)!.messages.filter((y) => y.role === 'tool');
    assert.equal(last[0]!.content, CLEARED, 'oldest results cleared');
    assert.notEqual(last.at(-1)!.content, CLEARED, 'newest results kept');
    // everything before `first` grew append-only; the prune is a client-side rewrite of old messages
    assert.ok(bodies[first]!.messages.length >= bodies[first - 1]!.messages.length);
  });
});
