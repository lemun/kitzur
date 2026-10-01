import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAssistant, runAgent } from '../../bench/client/agent.js';
import { httpRequest } from '../../bench/client/http.js';
import { MockServer } from '../../bench/mock/server.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { pyDumps } from '../../bench/lib/pyjson.js';
import * as sc from '../../bench/scenarios/reference.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';
import { benchFixture } from './fixtures.js';

test('SSE parse: every tool_calls delta entry is its own call (no merge by index), CRLF, [DONE]', () => {
  const ev = (o: unknown): string => `data: ${JSON.stringify(o)}\r\n\r\n`;
  const raw =
    ev({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }) +
    ev({ choices: [{ index: 0, delta: { content: 'lo', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'x', arguments: '{"k"' } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ': 1}' } }] } }] }) +
    ev({ choices: [], usage: { prompt_tokens: 5 } }) +
    ': keep-alive\r\n' +
    'data: [DONE]\r\n\r\n';
  const { msg, usage } = parseAssistant('text/event-stream', Buffer.from(raw));
  assert.equal(msg.content, 'Hello');
  assert.deepEqual(msg.tool_calls, [
    { id: 'a', type: 'function', function: { name: 'x', arguments: '{"k"' } },
    { function: { arguments: ': 1}' } },
  ]);
  assert.deepEqual(usage, { prompt_tokens: 5 });
  const empty = parseAssistant('text/event-stream; charset=utf-8', Buffer.from(ev({ choices: [{ delta: { content: '' } }] })));
  assert.equal(empty.msg.content, null);
  assert.deepEqual(empty.msg.tool_calls, []);
  const js = parseAssistant('application/json', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null } }] })));
  assert.deepEqual(js.msg, { role: 'assistant', content: null });
});

test('http client reads byte-by-byte chunked responses and waits for the server FIN', async () => {
  const body = 'data: {"a": 1}\n\n';
  const resp =
    'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n' +
    `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n` + '0\r\nX-Trailer: t\r\n\r\n';
  let seen = '';
  const server = createServer((s: Socket) => {
    s.on('data', (d: Buffer) => {
      seen += d.toString('latin1');
      if (!seen.includes('\r\n\r\n') || !seen.endsWith('{}')) return;
      let i = 0;
      const tick = (): void => {
        if (i < resp.length) {
          s.write(resp[i++]!);
          setImmediate(tick);
        } else setTimeout(() => s.end(), 300); // close only 300 ms after the last byte
      };
      tick();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await httpRequest({ method: 'POST', url: `http://127.0.0.1:${port}/v1/chat/completions`, headers: [['x-sim-step', '3']], body: Buffer.from('{}') });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), body);
    assert.equal(r.serverClosed, true);
    assert.ok(r.msClosed - r.msComplete >= 250, `waited ${r.msClosed - r.msComplete} ms for the FIN`);
    // Python http.client header order, then ours
    assert.ok(seen.startsWith(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept-Encoding: identity\r\nContent-Length: 2\r\nx-sim-step: 3\r\nConnection: close\r\n\r\n{}`));
  } finally {
    server.close();
  }
});

const tokPath = testTokenizerPath();

test('agent -> mock direct (uncapped): Python-identical bodies and counts, HTTP 400 at step 10', { skip: tokPath ? false : 'no dev tokenizer.json' }, async () => {
  const counter = new PromptCounter(loadTokenizer(tokPath!));
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-agent-'));
  const mock = new MockServer({ counter, outDir: dir });
  await mock.start(0);
  try {
    const res = await runAgent({ base: mock.url, counter, outDir: dir, steps: 12, saveOrigs: true, session: 's1' });
    const counts = benchFixture<Record<string, { per_step: number[]; per_step_est: number[] }>>('counts.json.gz')['ot_uncapped']!;
    assert.equal(res.records.length, 11);
    assert.deepEqual(res.error && { step: res.error.step, status: res.error.status }, { step: 10, status: 400 });
    res.records.forEach((r, i) => {
      assert.equal(r.orig_qwen_tokens, counts.per_step[i]);
      assert.equal(r.orig_est_tokens, counts.per_step_est[i]);
    });
    // direct: the mock counts exactly what the agent would have sent
    assert.deepEqual(mock.records.map((m) => m.prompt_tokens), counts.per_step.slice(0, 11));
    const last = mock.records[10]!;
    assert.equal(last.rejected_for_length, true);
    assert.equal(res.records[10]!.error_body, pyDumps({
      object: 'error', type: 'BadRequestError', param: null, code: 400,
      message: `This model's maximum context length is 100000 tokens. However, you requested ${last.prompt_tokens + 32000} tokens (${last.prompt_tokens} in the messages, 32000 in the completion). Please reduce the length of the messages or completion.`,
    }).slice(0, 600));
    // the wire body is Python json.dumps(body) (ensure_ascii=True): its byte length is what the mock logged
    const orig = JSON.parse(readFileSync(join(dir, 'origs', 'step5.json'), 'utf8')) as unknown;
    assert.equal(mock.records[5]!.body_chars, Buffer.byteLength(pyDumps(orig)));
    // prefix-cache LCP: every request extends the previous one (minus the final "\n" merge when the reply has no text)
    for (let i = 1; i < mock.records.length; i++) {
      const d = mock.records[i - 1]!.prompt_tokens - mock.records[i]!.lcp_tokens!;
      assert.ok(d === 0 || d === 1, `step ${i}: lcp ${mock.records[i]!.lcp_tokens} vs previous ${mock.records[i - 1]!.prompt_tokens}`);
      assert.equal(mock.records[i]!.session, 's1');
    }
    // client.jsonl carries Python's keys first, in Python's order
    const first = readFileSync(join(dir, 'client.jsonl'), 'utf8').split('\n')[0]!;
    assert.match(first, /^\{"step": 0, "orig_messages": 2, "orig_est_tokens": \d+, "orig_qwen_tokens": \d+, "status": 200, "secs": \d+\.\d+/);
    assert.equal(res.history.length, 2 + 10 * 2 + 1);
    assert.equal(res.history[22]!.content, sc.USER_INJECT.get(9));
  } finally {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
