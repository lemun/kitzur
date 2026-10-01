// Adversarial checks of the bench clients (bench/README.md§6, §6.4): the OpenCode client's run directory read
// back by bench/metrics (the record contract), repeated summarizer requests in one step, multi-session drivers,
// interleaving with a failing session, SSE parsing edge cases, and client-side counts under the qwen3 render.
// Written by the regression verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer, type MockServerOptions } from '../../bench/mock/server.js';
import { runAgent } from '../../bench/client/agent.js';
import { processedTotals, runOpenCode } from '../../bench/client/opencode.js';
import { clientErrorKind, parseResponse } from '../../bench/client/sse.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { referenceScenario, referenceSession, REFERENCE_FACTS } from '../../bench/lib/ref-spec.js';
import { collectRunDir } from '../../bench/metrics/collect.js';
import { basics, rewrites, stepViews } from '../../bench/metrics/generic.js';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { ScenarioSpec, SessionSpec } from '../../bench/scenarios/types.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';

const tokPath = testTokenizerPath();
const counter = tokPath ? new PromptCounter(loadTokenizer(tokPath)) : null;
const skip = counter ? false : 'no dev tokenizer.json';

async function withMock<T>(o: Omit<MockServerOptions, 'counter'>, fn: (m: MockServer, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-clientadv-'));
  const m = new MockServer({ counter: counter!, outDir: dir, ...o });
  await m.start(0);
  try {
    return await fn(m, dir);
  } finally {
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
const lines = (p: string): Array<Record<string, unknown>> => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

test('OpenCode run directory read back by bench/metrics: processed split, steps_ok, client compactions, no proxy rewrites', { skip }, async () => {
  const spec = referenceScenario({ capBytes: 51_200 }, { id: 'oc-metrics', steps: 20 });
  await withMock({ limit: 100_000, scenarios: [spec], spec: {} }, async (m, dir) => {
    const r = await runOpenCode({ base: m.url, counter: counter!, spec, context: 100_000, output: 32_000, outDir: dir });
    assert.equal(r.stepsCompleted, 20);
    assert.deepEqual(r.compactions.map((c) => [c.step, c.reason]), [[10, 'overflow'], [17, 'overflow']]);
    const rr = collectRunDir(dir, { counter: counter!, facts: REFERENCE_FACTS, steps: { main: 20 } });
    const views = stepViews(rr);
    const b = basics(rr, views);
    const w = rewrites(rr, views);
    const t = processedTotals(m.records);
    assert.equal(b.processed, t.total);
    assert.equal(b.processed_main_accepted, t.main);
    assert.equal(b.processed_main_rejected, t.rejected);
    assert.equal(b.processed_aux, t.summarizer + t.title);
    assert.equal(b.rejections, 2);
    assert.equal(b.steps_ok, 20, 'the re-sent step after an overflow compaction is a completed step');
    assert.equal(b.client_errors, 2, 'each overflow rejection is client-visible (OpenCode saw it and compacted)');
    assert.deepEqual(b.client_error_kinds, { http_400: 2 });
    assert.equal(b.pairing_errors, 0);
    // direct: every rewrite is the client's own; each overflow compaction is one client compaction
    assert.equal(w.compactions_generic, 0);
    assert.equal(w.client_compactions, 2);
    assert.equal(w.summarizer_requests, 2);
    assert.equal(w.title_requests, 1);
    // the client's own count of each request equals the mock's (direct, same render)
    const cl = lines(join(dir, 'client.jsonl'));
    assert.deepEqual(cl.map((x) => x['orig_qwen_tokens']), m.records.map((x) => x.prompt_tokens));
    assert.deepEqual(rr.client.map((c) => [c.kind, c.step, c.attempt]), cl.map((x) => [x['kind'], x['step'], (x['attempt'] as number) + 1]));
  });
});

test('OpenCode: several summarizer requests in one step keep their own origs (no overwrite), and each matches what the mock received', { skip }, async () => {
  // a server that rejects every main request: the client compacts after each of its 3 attempts at step 0, then gives up
  const window = { limit: 100_000, overLimit: (_p: number, _m: number, _l: number, body: { tools?: unknown }): boolean => Array.isArray(body.tools) };
  await withMock({ window, spec: {} }, async (m, dir) => {
    const r = await runOpenCode({ base: m.url, counter: counter!, scenario: { capBytes: 51_200 }, context: 100_000, output: 32_000, outDir: dir, steps: 3 });
    assert.equal(r.error?.kind, 'could_not_fit');
    assert.equal(r.compactions.length, 3);
    const cl = lines(join(dir, 'client.jsonl'));
    const summ = cl.filter((x) => x['kind'] === 'summarizer');
    assert.equal(summ.length, 3);
    assert.equal(new Set(summ.map((x) => x['orig_file'])).size, 3, 'distinct orig files');
    const mockSumm = m.records.filter((x) => x.kind === 'summarizer');
    summ.forEach((x, i) => {
      const mine = JSON.parse(readFileSync(join(dir, x['orig_file'] as string), 'utf8')) as { messages: ChatMessage[] };
      const theirs = JSON.parse(readFileSync(join(dir, mockSumm[i]!.body_file!), 'utf8')) as { messages: ChatMessage[] };
      assert.deepEqual(mine.messages, theirs.messages, `summarizer ${i}`);
    });
  });
});

test('OpenCode: sessions run one call at a time into one outDir keep every session\'s client records (appendLog)', { skip }, async () => {
  const spec: ScenarioSpec = { ...referenceScenario({ capBytes: 51_200 }, { id: 'two' }), sessions: [referenceSession({ capBytes: 51_200 }, 'a', 3), referenceSession({ capBytes: 51_200 }, 'b', 2)] };
  await withMock({ limit: 100_000, scenarios: [spec], spec: {} }, async (m, dir) => {
    for (const [i, s] of spec.sessions.entries()) await runOpenCode({ base: m.url, counter: counter!, spec, session: s.id, context: 100_000, output: 32_000, outDir: dir, appendLog: i > 0 });
    const cl = lines(join(dir, 'client.jsonl'));
    assert.deepEqual(cl.filter((x) => x['kind'] === 'main').map((x) => `${x['session'] as string}${x['step'] as number}`), ['a0', 'a1', 'a2', 'b0', 'b1']);
    assert.deepEqual(m.records.map((x) => x.session), cl.map((x) => x['session']));
    const rr = collectRunDir(dir, { counter: counter!, facts: REFERENCE_FACTS, steps: { a: 3, b: 2 } });
    assert.equal(basics(rr).steps_ok, 5);
  });
});

test('client counts default to the scenario\'s mock render: qwen3 orig_qwen_tokens equal the mock\'s qwen3 prompt_tokens (direct)', { skip }, async () => {
  const spec = referenceScenario({ capBytes: 51_200 }, { id: 'q3', steps: 4, mock: { render: 'qwen3' } });
  await withMock({ limit: 100_000, scenarios: [spec], spec: spec.mock }, async (m) => {
    const res = await runAgent({ base: m.url, counter: counter!, spec, strict: true });
    assert.equal(res.error, null);
    assert.deepEqual(res.records.map((r) => r.orig_qwen_tokens), m.records.map((r) => r.prompt_tokens));
    assert.equal(res.records[0]!.orig_qwen_tokens, 9564, 'the jinja2 count of the reference step 0 (the sim render says 9,376)');
  });
  await withMock({ limit: 100_000, scenarios: [spec], spec: spec.mock }, async (m, dir) => {
    await runOpenCode({ base: m.url, counter: counter!, spec, context: 100_000, output: 32_000, outDir: dir, steps: 12 });
    assert.deepEqual(lines(join(dir, 'client.jsonl')).map((x) => x['orig_qwen_tokens']), m.records.map((r) => r.prompt_tokens));
  });
});

function tiny(id: string, steps: number, failAt: number | null): SessionSpec {
  const call = (step: number): ToolCall => ({ id: `${id}_${step}`, type: 'function', function: { name: 'read', arguments: '{"p":"/x"}' } });
  return {
    id, seed: 0, steps,
    system: () => `System ${id}.`, tools: () => [{ type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object', properties: {} } } }],
    goal: () => ({ role: 'user', content: `Goal of ${id}${failAt !== null ? ' FAIL-ME' : ''}` }),
    assistantAt: (step: number): ChatMessage => ({ role: 'assistant', content: null, tool_calls: [call(step)] }),
    toolResults: (step: number, calls: ToolCall[]): ChatMessage[] => calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: `out ${id} ${step}${failAt !== null && step + 1 === failAt ? ' TRIGGER' : ''}` })),
    userAfter: () => [],
  };
}

test('spec agent: unequal session lengths round-robin, and a failing session does not stop the others (sequential and concurrent)', { skip }, async () => {
  const sc: ScenarioSpec = {
    id: 'mix', family: 'F8', client: 'sim', capBytes: null, mock: {}, gates: [], expect: 'complete', facts: [],
    sessions: [tiny('s1', 2, null), tiny('s2', 4, 2), tiny('s3', 1, null)],
  };
  // reject any request that carries the TRIGGER output (s2 from its step 2 on)
  const window = { limit: 100_000, overLimit: (_p: number, _m: number, _l: number, body: { messages?: unknown }): boolean => JSON.stringify(body.messages).includes('TRIGGER') };
  for (const interleave of ['round-robin', { seed: 5, concurrent: 3 }] as const) {
    await withMock({ scenarios: [sc], spec: {}, window }, async (m) => {
      const res = await runAgent({ base: m.url, counter: counter!, spec: sc, strict: true, interleave });
      assert.deepEqual(res.errors!.map((e) => [e.session, e.step, e.kind]), [['s2', 2, 'http_400']]);
      const ok = (s: string): number[] => m.records.filter((r) => r.session === s && r.status === 200).map((r) => r.step);
      assert.deepEqual([ok('s1'), ok('s2'), ok('s3')], [[0, 1], [0, 1], [0]]);
      if (interleave === 'round-robin') assert.deepEqual(m.records.map((r) => `${r.session!}:${r.step}`), ['s1:0', 's2:0', 's3:0', 's1:1', 's2:1', 's2:2']);
    });
  }
});

test('SSE parsing edge cases: CRLF, comments, no space after data:, late ids, split arguments, error: frames, string errors', () => {
  const ev = (o: unknown, sep = '\n'): string => `data:${JSON.stringify(o)}${sep}${sep}`;
  const text = ': keep-alive\r\n\r\n' + 'event: message\r\n' +
    ev({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'th' } }] }, '\r\n') +
    ev({ choices: [{ index: 0, delta: { reasoning: 'ink', tool_calls: [{ index: 1, function: { name: 'b', arguments: '{"x"' } }, { index: 0, id: '', function: { name: 'a', arguments: '' } }] } }] }, '\r\n') +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { arguments: '{}' } }, { index: 1, id: 'call_b', function: { arguments: ':1}' } }] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + ev({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + 'data: [DONE]\n\n';
  const p = parseResponse('text/event-stream; charset=utf-8', text);
  assert.equal(p.reasoning, 'think');
  // ordered by `index` like the AI SDK (toolCalls[index]), not by first arrival; the id arrived in a later delta
  assert.deepEqual(p.toolCalls, [
    { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
    { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
  ]);
  // a non-stream message lists whole calls: two calls that both carry index 0 stay two calls
  const js = parseResponse('application/json', JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
    { index: 0, id: 'x', type: 'function', function: { name: 'a', arguments: '{}' } },
    { index: 0, id: 'y', type: 'function', function: { name: 'b', arguments: '{}' } },
  ] }, finish_reason: 'tool_calls' }] }));
  assert.deepEqual(js.toolCalls.map((c) => c.id), ['x', 'y']);
  assert.deepEqual(p.usage, { prompt_tokens: 5, completion_tokens: 2 });
  assert.equal(clientErrorKind(200, p), null);
  // an in-stream error whose `error` is a plain string still is a top-level error
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', 'data: {"error":"overloaded"}\n\n')), 'stream_error');
  // llama.cpp ≤b6400 frame (field name `error:`), then [DONE]: an error, not a clean empty turn
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', 'error: {"code":400,"message":"x","type":"invalid_request_error"}\n\ndata: [DONE]\n\n')), 'stream_error');
  // a stream that closes after a content delta: truncated; with [DONE] but no finish_reason it is complete
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', ev({ choices: [{ index: 0, delta: { content: 'x' } }] }))), 'truncated_stream');
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', ev({ choices: [{ index: 0, delta: { content: 'x' } }] }) + 'data: [DONE]\n\n')), null);
  // non-JSON 200 body
  assert.equal(clientErrorKind(200, parseResponse('application/json', '<html>oops</html>')), 'bad_response');
});
