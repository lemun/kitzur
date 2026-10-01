// End to end against the byte-exact port of the Python mock (bench/mock/server.ts) with the real Qwen
// tokenizer and the `sim` template (): the mock's real limit sits below the configured window, so
// every Python error style (vllm, llamacpp, tgi422, gateway502) actually overflows (). Skipped when
// the dev tokenizer is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTokenizerCached } from '../../src/tokenize/load.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import { learnedKey } from '../../src/proxy/state.js';
import { MockServer } from '../../bench/mock/server.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { assistantMessage, initialHistory, toolOutput, tools } from '../../bench/scenarios/reference.js';
import type { ChatMessage } from '../../src/types.js';
import { shrinkingEngine } from './fake-engine.js';
import { request, startProxy, testConfig, waitRecords } from './harness.js';
import { classifyHttpError } from './opencode-port.js';

function tokenizerPath(): string | null {
  const env = process.env['KITZUR_TEST_TOKENIZER'];
  if (env) return existsSync(env) ? env : null;
  for (let d = process.cwd(), i = 0; i < 8; i++, d = join(d, '..')) {
    const p = join(d, 'bench', '.cache', 'Qwen3.6-27B-tokenizer.json');
    if (existsSync(p)) return p;
  }
  return null;
}

const TOK = tokenizerPath();
const LIMIT = 60_000; // the mock's real window; kitzur is configured for 100k

test('Python mock styles through the proxy: vllm / llamacpp / tgi422 recover by learning the window; gateway502 is never resent larger', { skip: TOK ? false : 'dev tokenizer absent (scripts/fetch-tokenizer.sh)' }, async () => {
  const tok = loadTokenizerCached(TOK!, null, { stateDir: join(tmpdir(), 'kitzur-test-tokenizer-cache') });
  const cfgOver = { tokenizer: { template: { name: 'sim' as const } } };
  const cfg = testConfig(cfgOver);
  const counter = counterFromConfig(cfg, { tokenizer: tok });
  const prompt = new PromptCounter(tok);
  // the reference history until the sim count passes 40k tokens (max_tokens 32k: over the mock's 60k limit)
  const msgs: ChatMessage[] = initialHistory();
  const body = (): Record<string, unknown> => ({ model: 'qwen', messages: msgs, tools: tools(), max_tokens: 32_000, stream: false });
  for (let step = 0; counter.countRequest(body() as never) < 40_000; step++) {
    const a = assistantMessage(step, { capBytes: 51200 });
    msgs.push(a);
    for (const c of a.tool_calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(step, { capBytes: 51200 }) });
  }
  const own = counter.countRequest(body() as never);
  assert.equal(own, prompt.countBody(body() as never), 'our exact sim count equals the mock count ()');

  for (const style of ['vllm', 'llamacpp', 'tgi422', 'gateway502']) {
    const mock = new MockServer({ counter: prompt, limit: LIMIT, errorStyle: style, outDir: null });
    await mock.start(0);
    const f = await startProxy(mock.url, shrinkingEngine(cfg, counter), { counter, config: cfgOver });
    try {
      const r = await request(f.port, { body: body(), headers: { 'x-sim-step': '3' } });
      const recs = mock.records;
      assert.ok(recs.length <= cfg.errors.maxRetries + 1, style);
      for (let i = 1; i < recs.length; i++) assert.ok(recs[i]!.prompt_tokens < recs[i - 1]!.prompt_tokens, `${style}: attempt ${i + 1} smaller`);
      assert.ok(recs.every((x) => x.prompt_tokens <= own), `${style}: never larger than the client's request`);
      if (style === 'gateway502') {
        assert.equal(r.status, 502, 'a gateway error is never translated');
        assert.equal(classifyHttpError('opencode', r.status, r.text()).retried, true);
      } else {
        assert.equal(r.status, 200, `${style}: recovered`);
        assert.equal(recs.length, 2, `${style}: one retry`);
        assert.equal(recs[0]!.rejected_for_length, true);
        assert.equal(f.state.entry(learnedKey(mock.url, 'qwen')).window, LIMIT, `${style}: window learned`);
        const st = (await waitRecords(f, 1))[0]!;
        assert.equal(st.attempts[0]!.raw, recs[0]!.prompt_tokens, `${style}: attempt raw = the mock's prompt tokens`);
      }
    } finally {
      await f.close();
      await mock.stop();
    }
  }
});
