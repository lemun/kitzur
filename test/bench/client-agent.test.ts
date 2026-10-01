import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../bench/client/agent.js';
import { clientErrorKind, parseResponse } from '../../bench/client/sse.js';
import { MockServer, type MockServerOptions } from '../../bench/mock/server.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { referenceScenario } from '../../bench/lib/ref-spec.js';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { ScenarioSpec, SessionSpec } from '../../bench/scenarios/types.js';
import * as sc from '../../bench/scenarios/reference.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';

const tokPath = testTokenizerPath();
const counter = tokPath ? new PromptCounter(loadTokenizer(tokPath)) : null;
const skip = counter ? false : 'no dev tokenizer.json';

const call = (id: string, args: unknown): ToolCall => ({ id, type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } });
function session(id: string, marker: string, steps = 4): SessionSpec {
  return {
    id, seed: 0, steps,
    system: () => `System prompt of ${id}.`,
    tools: () => [{ type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }],
    goal: (): ChatMessage => ({ role: 'user', content: `Goal ${marker} for ${id}` }),
    assistantAt: (step: number): ChatMessage =>
      step === 1
        ? { role: 'assistant', content: `Two reads for ${id}.`, reasoning_content: `RSN-${id} step one`, tool_calls: [call(`${id}_1_0`, { p: '/a' }), call(`${id}_1_1`, { p: '/b' })] }
        : { role: 'assistant', content: null, tool_calls: [call(`${id}_${step}_0`, { p: `/f${step}` })] },
    toolResults: (step: number, calls: ToolCall[]): ChatMessage[] => calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: `out ${id} ${step} ${i} ` + 'data '.repeat(20 * (step + 1)) })),
    userAfter: (step: number): ChatMessage[] => (step === 2 ? [{ role: 'user', content: `User adds ${marker}-U` }] : []),
  };
}
const THREE: ScenarioSpec = {
  id: 'three', family: 'F8', client: 'sim', capBytes: null, mock: {}, gates: [], expect: 'complete',
  sessions: [session('s1', 'MK1'), session('s2', 'MK2'), session('s3', 'MK3')],
  facts: [
    { id: 'g1', marker: 'MK1', channel: 'head', expect: 'survive', gate: true },
    { id: 'r1', marker: 'RSN-s1 step one', channel: 'reasoning', expect: 'report-only', gate: false },
  ],
};

async function withMock<T>(o: Omit<MockServerOptions, 'counter'>, fn: (m: MockServer, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-agent-'));
  const m = new MockServer({ counter: counter!, outDir: dir, ...o });
  await m.start(0);
  try {
    return await fn(m, dir);
  } finally {
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('strict client-visible errors (benchmark contract ): http, in-stream data:/error:, no [DONE]/finish, length without a call', () => {
  const ev = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const ok = ev({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hi', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{"p"' } }] }, finish_reason: null }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ': 1}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const p = parseResponse('text/event-stream', ok);
  assert.deepEqual(p.toolCalls, [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{"p": 1}' } }]); // merged by index
  assert.equal(clientErrorKind(200, p), null);
  assert.equal(clientErrorKind(400, null), 'http_400');
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', ev({ error: { message: 'too long', code: 400 } }) + 'data: [DONE]\n\n')), 'stream_error');
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', 'error: {"code":400,"message":"the request exceeds the available context size"}\n\ndata: [DONE]\n\n')), 'stream_error');
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', ev({ choices: [{ index: 0, delta: { content: 'cut' } }] }))), 'truncated_stream');
  assert.equal(clientErrorKind(200, parseResponse('text/event-stream', ev({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n')), 'length_no_tool');
  assert.equal(clientErrorKind(200, parseResponse('application/json', JSON.stringify({ error: { message: 'x' } }))), 'stream_error');
  assert.equal(clientErrorKind(200, parseResponse('application/json', JSON.stringify({ choices: [{ message: { content: 'x', tool_calls: [call('a', {})] }, finish_reason: 'length' }] }))), null);
  assert.equal(parseResponse('text/event-stream', ev({ choices: [{ delta: { reasoning: 'r1' } }] }) + ev({ choices: [{ delta: { reasoning_content: 'r2' } }] })).reasoning, 'r1r2');
});

test('legacy (Python) agent with strict: an in-stream overflow ends the run; without strict it is an empty turn', { skip }, async () => {
  // the reference requests grow past 40k tokens within 8 steps: with max_tokens 20k a 60k server rejects them in-stream
  for (const strict of [true, false]) {
    await withMock({ limit: 60_000, spec: { errorStyle: 'sse-inline' }, scenario: { capBytes: 51_200 } }, async (m, dir) => {
      const res = await runAgent({ base: m.url, counter: counter!, outDir: dir, steps: 8, scenario: { capBytes: 51_200 }, strict, maxTokens: 20_000 });
      const failed = m.records.findIndex((r) => r.stream_error);
      assert.ok(failed > 0, 'some step overflowed in-stream');
      if (strict) {
        assert.equal(res.records.length, failed + 1);
        assert.equal(res.records.at(-1)!.client_error_kind, 'stream_error');
        assert.deepEqual(res.error && { status: res.error.status, kind: res.error.kind }, { status: 200, kind: 'stream_error' });
      } else {
        assert.equal(res.error, null, 'agent_client.py accepts it');
        assert.equal(res.records.length, 8);
        const empty = res.history.find((h) => h.role === 'assistant' && Array.isArray(h.tool_calls) && !h.tool_calls.length);
        assert.deepEqual(empty, { role: 'assistant', content: null, tool_calls: [] });
      }
    });
  }
});

test('spec agent: multi-session round-robin, x-sim headers, tool results, userAfter, reasoning echo', { skip }, async () => {
  await withMock({ scenarios: [THREE], spec: {} }, async (m) => {
    const res = await runAgent({ base: m.url, counter: counter!, spec: THREE, strict: true });
    assert.equal(res.error, null);
    assert.equal(res.records.length, 12);
    assert.deepEqual(m.records.map((r) => r.session), ['s1', 's2', 's3', 's1', 's2', 's3', 's1', 's2', 's3', 's1', 's2', 's3']);
    assert.deepEqual(m.records.map((r) => r.step), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    assert.ok(m.records.every((r) => r.scenario === 'three' && r.kind === 'main' && r.status === 200 && r.pairing_strict!.length === 0));
    const h1 = res.histories!['s1']!;
    // [system, goal, a0, t0, a1(2 calls), t1a, t1b, a2, t2, user, a3, t3]
    assert.deepEqual(h1.map((x) => x.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'user', 'assistant', 'tool']);
    assert.equal(h1[4]!.reasoning_content, 'RSN-s1 step one', 'reasoning sent back like OpenCode');
    assert.deepEqual(h1[4]!.tool_calls!.map((c) => c.id), ['s1_1_0', 's1_1_1']);
    assert.equal(h1[9]!.content, 'User adds MK1-U');
    assert.equal(res.records[0]!.session, 's1');
    // the echoed reasoning reached the mock: every later s1 request carries the reasoning-only marker
    assert.deepEqual(m.records.filter((r) => r.session === 's1').map((r) => r.facts['RSN-s1 step one']), [false, false, true, true]);
  });
  await withMock({ scenarios: [THREE], spec: {} }, async (m) => {
    const res = await runAgent({ base: m.url, counter: counter!, spec: THREE, reasoningEcho: false, steps: 3 });
    assert.equal(res.histories!['s2']![4]!.reasoning_content, undefined);
    assert.equal(res.records.length, 9);
    assert.ok(m.records.every((r) => !r.facts['RSN-s1 step one']));
  });
});

test('spec agent: seeded and concurrent interleaving give every session the bodies of its round-robin run', { skip }, async () => {
  const bodies = async (interleave: ScenarioSpec['interleave']): Promise<{ order: string[]; per: Map<string, string> }> =>
    withMock({ scenarios: [THREE], spec: {} }, async (m, dir) => {
      await runAgent({ base: m.url, counter: counter!, spec: THREE, strict: true, ...(interleave ? { interleave } : {}) });
      const per = new Map<string, string>();
      for (const r of m.records) per.set(`${r.session}/${r.step}`, readFileSync(join(dir, r.body_file!), 'utf8'));
      return { order: m.records.map((r) => r.session!), per };
    });
  const rr = await bodies('round-robin');
  const s1 = await bodies({ seed: 1 });
  const s1b = await bodies({ seed: 1 });
  const conc = await bodies({ seed: 1, concurrent: 3 });
  assert.deepEqual(s1.order, s1b.order, 'seeded order is deterministic');
  assert.notDeepEqual(s1.order, rr.order);
  for (const run of [s1, conc]) {
    assert.equal(run.per.size, 12);
    for (const [k, v] of rr.per) assert.equal(run.per.get(k), v, k);
  }
});

test('spec agent strict: length cut-off without a tool call, and the reference spec equals the legacy agent', { skip }, async () => {
  await withMock({ scenarios: [THREE], spec: { completionModel: { reasoning: { kind: 'fixed', value: 200 }, text: { kind: 'fixed', value: 0 }, seed: 1 } } }, async (m) => {
    const res = await runAgent({ base: m.url, counter: counter!, spec: THREE, strict: true, maxTokens: 100, steps: 2 });
    assert.equal(res.errors!.length, 3);
    assert.ok(res.errors!.every((e) => e.kind === 'length_no_tool' && e.step === 0));
    assert.equal(m.records[0]!.finish_reason, 'length');
  });
  // the reference scenario through the spec path sends exactly the legacy agent's bodies
  const ref = referenceScenario({ capBytes: 51_200 }, { steps: 6 });
  const legacy = await withMock({}, async (m, dir) => {
    await runAgent({ base: m.url, counter: counter!, steps: 6, scenario: { capBytes: 51_200 } });
    return m.records.map((r) => readFileSync(join(dir, r.body_file!), 'utf8'));
  });
  const viaSpec = await withMock({ scenarios: [ref] }, async (m, dir) => {
    const res = await runAgent({ base: m.url, counter: counter!, spec: ref, strict: true });
    assert.equal(res.error, null);
    assert.deepEqual(Object.keys(m.records[0]!.facts), sc.FACT_KEYS);
    return m.records.map((r) => readFileSync(join(dir, r.body_file!), 'utf8'));
  });
  assert.deepEqual(viaSpec, legacy);
});

test('spec agent: `concurrent: 3` keeps three requests in flight; round-robin keeps one', async () => {
  let inflight = 0;
  let max = 0;
  const server = createServer((req, res) => {
    inflight++;
    max = Math.max(max, inflight);
    req.resume();
    req.on('end', () => setTimeout(() => {
      inflight--;
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, 40));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = { countBody: () => 0, countText: () => 0 } as unknown as PromptCounter;
  try {
    await runAgent({ base, counter: fake, spec: THREE, steps: 2, interleave: { seed: 3, concurrent: 3 }, strict: true });
    assert.equal(max, 3);
    max = 0;
    await runAgent({ base, counter: fake, spec: THREE, steps: 2, strict: true });
    assert.equal(max, 1);
  } finally {
    server.close();
  }
});
