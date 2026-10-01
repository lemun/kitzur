import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer, mockRecordLine, type MockRecord } from '../../bench/mock/server.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { pyDumps } from '../../bench/lib/pyjson.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';
import { benchFixture } from './fixtures.js';

type Golden = Record<string, Record<string, unknown> & { startup_line: string; mock_jsonl: Array<Record<string, unknown>>; reqs_files: string[] }>;
const G = benchFixture<Golden>('mock_http.json.gz');
const tokPath = testTokenizerPath();

/** The raw request capture_mock.py sent (Python json.dumps default body, header order as captured). */
function rawPost(port: number, body: unknown, step: number): Promise<string> {
  const data = Buffer.from(pyDumps(body), 'latin1');
  const hdr =
    `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\n` +
    `authorization: Bearer sim-key\r\nx-sim-step: ${step}\r\ncontent-length: ${data.length}\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port });
    const parts: Buffer[] = [];
    s.on('connect', () => s.write(Buffer.concat([Buffer.from(hdr, 'latin1'), data])));
    s.on('data', (d: Buffer) => parts.push(d));
    s.on('end', () => resolve(Buffer.concat(parts).toString('latin1')));
    s.on('error', reject);
  });
}

/** Split a raw response into status line, the headers that matter (Server/Date/Connection/Keep-Alive dropped), body bytes. */
function split(raw: string): { status: string; headers: string[]; body: string } {
  const i = raw.indexOf('\r\n\r\n');
  const [status, ...hs] = raw.slice(0, i).split('\r\n');
  const skip = new Set(['server', 'date', 'connection', 'keep-alive']);
  return { status: status!, headers: hs.filter((h) => !skip.has(h.slice(0, h.indexOf(':')).toLowerCase())), body: raw.slice(i + 4) };
}

/** A record as the Python mock logs it: without the harness extras, ts replaced like capture_mock.py. */
function pythonView(r: MockRecord): string {
  const { session: _s, lcp_tokens: _l, lcp_ok_tokens: _lo, body_bytes: _b, body_file: _f, stream_error: _e, ...py } = r;
  return pyDumps({ ...py, ts: '<time.time()>' });
}

const baseHist = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];

test('mock HTTP responses and mock.jsonl records are byte-identical to mock_server.py', { skip: tokPath ? false : 'no dev tokenizer.json' }, async () => {
  const counter = new PromptCounter(loadTokenizer(tokPath!));
  for (const [key, g] of Object.entries(G)) {
    const [style, lim] = key.split('_limit') as [string, string];
    const dir = mkdtempSync(join(tmpdir(), 'kitzur-mock-'));
    const mock = new MockServer({ counter, outDir: dir, limit: Number(lim), errorStyle: style });
    const port = await mock.start(0);
    try {
      assert.equal(mock.startupLine() + '\n', g.startup_line.replace(/listening on \d+/, `listening on ${port}`));
      const cases: Array<[string, unknown, number]> =
        lim === '100000'
          ? [
              ['stream_usage', { model: 'm', messages: baseHist, max_tokens: 10, stream: true, stream_options: { include_usage: true } }, 3],
              ['stream_nousage', { model: 'm', messages: baseHist, max_tokens: 10, stream: true }, 3],
              ['nonstream', { model: 'm', messages: baseHist, max_tokens: 10, stream: false }, 3],
              ['nonstream_step4_null_content', { model: 'm', messages: baseHist, max_completion_tokens: 7 }, 4],
              ['pairing_error', { model: 'm', messages: [...baseHist, { role: 'tool', tool_call_id: 'x', content: 'r' }], max_tokens: 10 }, 0],
            ]
          : [['length_error', { model: 'm', messages: baseHist, max_tokens: 10, stream: true }, 0]];
      for (const [name, body, step] of cases) {
        const got = split(await rawPost(port, body, step));
        const want = split(g[name] as string);
        assert.equal(got.status, want.status, `${key} ${name} status line`);
        assert.deepEqual(got.headers, want.headers, `${key} ${name} headers`);
        assert.equal(got.body, want.body, `${key} ${name} body bytes (SSE chunks included)`);
      }
      // mock.jsonl: Python fields in Python order, then the extras
      const lines = readFileSync(join(dir, 'mock.jsonl'), 'utf8').trimEnd().split('\n');
      assert.equal(lines.length, g.mock_jsonl.length);
      mock.records.forEach((r, i) => {
        assert.equal(pythonView(r), pyDumps(g.mock_jsonl[i]), `${key} record ${i}`);
        assert.equal(lines[i], mockRecordLine(r));
        assert.equal(r.session, 'default');
        assert.equal(r.body_bytes, r.body_chars);
      });
      assert.deepEqual(readdirSync(join(dir, 'reqs')).sort(), g.reqs_files);
    } finally {
      await mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('mock: missing x-sim-step scripts step -1; hooks: usage, window, stream error', { skip: tokPath ? false : 'no dev tokenizer.json' }, async () => {
  const counter = new PromptCounter(loadTokenizer(tokPath!));
  const want = String((G['vllm_limit100000']!['missing_step_header_default'] as string).split(': ').slice(1).join(': '));
  const mock = new MockServer({
    counter,
    usage: 'always',
    window: { limit: 30, overLimit: (p) => p > 30 }, // prompt-only check (llama.cpp style)
    streamError: ({ step }) => (step === 7 ? { event: { error: { message: 'boom', code: 400 } } } : null),
  });
  const port = await mock.start(0);
  try {
    const body = pyDumps({ model: 'm', messages: baseHist, max_tokens: 10, stream: false });
    const res = await fetch(`http://127.0.0.1:${port}/any/path`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    const j = (await res.json()) as { choices: Array<{ message: unknown }> };
    assert.equal(pyDumps(j.choices[0]!.message), want);
    // usage 'always': a usage chunk although the request did not ask
    const s = await rawPost(port, { model: 'm', messages: baseHist, max_tokens: 1000, stream: true }, 3);
    assert.match(s, /"usage": \{"prompt_tokens": 15/);
    // stream error injection after HTTP 200
    const e = await rawPost(port, { model: 'm', messages: baseHist, max_tokens: 1000, stream: true }, 7);
    assert.match(e, /^HTTP\/1\.1 200 OK/);
    assert.match(e, /data: \{"error": \{"message": "boom", "code": 400\}\}\n\n/);
    assert.ok(!e.includes('[DONE]'));
    // window hook: prompt-only check passes with a huge max_tokens, fails on prompt > 30
    const big = await rawPost(port, { model: 'm', messages: [...baseHist, { role: 'user', content: 'x '.repeat(40) }], max_tokens: 1 }, 3);
    assert.match(big, /^HTTP\/1\.1 400 Bad Request/);
    assert.equal(mock.records.at(-1)!.rejected_for_length, true);
    assert.equal(mock.records.find((r) => r.step === 7)!.stream_error, true);
    // LCP bookkeeping: identical prompts share every token, per session
    const r = mock.records;
    assert.equal(r[0]!.lcp_tokens, 0);
    assert.equal(r[1]!.lcp_tokens, r[1]!.prompt_tokens);
  } finally {
    await mock.stop();
  }
  assert.throws(() => new MockServer({ counter, errorStyle: 'nope' }), /unknown error style/);
});
