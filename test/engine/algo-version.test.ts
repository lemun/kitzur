// Ties ENGINE_ALGO_VERSION to the planner output: a fixed history is run request by request with the
// estimate counter and the actions, plan boundaries and forwarded-message hashes are compared with a
// committed golden. Persisted plans store the version, so a planning change must bump it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENGINE_ALGO_VERSION, type ChatMessage } from '../../src/types.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import { createEngine } from '../../src/engine/engine.js';
import { createSummarizer } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { presetConfig } from './stubs.js';
import { ROOT } from '../helpers.js';

const GOLDEN = join(ROOT, 'test', 'fixtures', 'engine', 'algo-version.json');
const REFRESH = 'the planner or summary output changed: bump ENGINE_ALGO_VERSION in src/types.ts and refresh with KITZUR_UPDATE_GOLDEN=1';
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function run() {
  const cfg = presetConfig('32k', { tokenizer: { mode: 'estimate', template: { name: 'generic' } } });
  const counter = counterFromConfig(cfg);
  const engine = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg) });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a coding agent working in a repository.' },
    { role: 'user', content: 'Fix the failing parser tests in src/parse.ts without changing the public API.' },
  ];
  const requests = [];
  for (let i = 0; i < 14; i++) {
    const name = i % 3 === 0 ? 'read_file' : 'run_tests';
    messages.push({ role: 'assistant', content: `Step ${i}: checking ${name}.`, tool_calls: [{ id: `call-${i}`, type: 'function',
      function: { name, arguments: JSON.stringify({ path: `src/module-${i % 4}.ts` }) } }] },
    { role: 'tool', tool_call_id: `call-${i}`, content: `result ${i}\n` + `line ${i} of the output for module ${i % 4}; `.repeat(250 + 20 * i) });
    if (i === 6) messages.push({ role: 'user', content: 'Correction: keep the old error messages, only fix the offsets.' });
    const r = engine.process({ model: 'fixed', messages: structuredClone(messages), max_tokens: 2000 }, { attempt: 1 });
    requests.push({ action: r.action, cut: r.plan?.cut ?? null, hEnd: r.plan?.hEnd ?? null, messages: sha(r.request?.messages ?? null), n: r.plan?.n ?? null });
  }
  return { digest: sha(requests), requests, version: ENGINE_ALGO_VERSION };
}

test('the planner output on a fixed history matches the golden of the current ENGINE_ALGO_VERSION', () => {
  const now = run();
  assert.ok(now.requests.some(r => r.action === 'compact'), 'the fixed history must provoke a compaction');
  assert.deepEqual(run(), now, 'the planner must be deterministic');
  if (process.env['KITZUR_UPDATE_GOLDEN'] === '1') {
    if (process.env['CI'] === 'true') throw new Error('KITZUR_UPDATE_GOLDEN=1 is refused when CI=true');
    mkdirSync(dirname(GOLDEN), { recursive: true });
    const lines = now.requests.map(r => '  ' + JSON.stringify(r)).join(',\n');
    writeFileSync(GOLDEN, `{"digest": "${now.digest}",\n "requests": [\n${lines}\n ],\n "version": "${now.version}"}\n`);
  }
  assert.ok(existsSync(GOLDEN), REFRESH);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof now;
  assert.equal(golden.version, ENGINE_ALGO_VERSION, `ENGINE_ALGO_VERSION changed; ${REFRESH}`);
  assert.deepEqual(now, golden, REFRESH);
});
