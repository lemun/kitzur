// Pins the engine-level compression and planted-fact survival of a fixed subset of bench scenarios against the
// committed golden file, so a change that silently moves the published numbers fails here. Runs in process with the
// estimate counter: no tokenizer, no network, no listener. Refresh: KITZUR_UPDATE_GOLDEN=1 npm test -- <this file>.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { simulateSession } from '../../bench/scenarios/common.js';
import { buildScenario } from '../../bench/scenarios/index.js';
import { WINDOWS } from '../../bench/scenarios/windows.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { createEngine } from '../../src/engine/engine.js';
import { createSummarizer } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import { ROOT } from '../helpers.js';

const GOLDEN = join(ROOT, 'test', 'fixtures', 'bench', 'published-numbers.json');
const SCENARIOS = ['qa46', 'talk80', 'code60', 'corr60'];
const WINDOW = WINDOWS['100k'];
const COUNTS = ['compactions', 'factsPlanted', 'factsSurvived', 'requests', 'tokensIn', 'tokensOut'] as const;
const REFRESH = 'refresh with: KITZUR_UPDATE_GOLDEN=1 npm test -- dist/test/bench/published-numbers.test.js';

type Metrics = Record<(typeof COUNTS)[number] | 'compressionRatio', number>;

function measure(id: string): Metrics {
  const scenario = buildScenario(id, WINDOW.id);
  const session = scenario.sessions[0]!;
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.budget.window = WINDOW.W;
  cfg.budget.defaultMaxTokens = WINDOW.O;
  cfg.tokenizer.mode = 'estimate';
  cfg.tokenizer.template.name = 'generic';
  const counter = counterFromConfig(cfg);
  const engine = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg) });
  const history = simulateSession(session);
  const facts = scenario.facts.filter(f => f.gate && f.expect === 'survive');
  const lost = new Set<string>();
  let tokensIn = 0, tokensOut = 0, compactions = 0;
  for (let k = 0; k < session.steps; k++) {
    // the client request of step k: everything appended before the assistant reply of step k
    const messages = history.filter(m => m.step < k).map(m => m.message);
    const result = engine.process({ model: 'deterministic-mock', messages, max_tokens: WINDOW.O }, { attempt: 1 });
    assert.ok(result.request, `${id} step ${k}: ${result.reason}`);
    tokensIn += result.stats.tokensIn;
    tokensOut += result.stats.tokensOut;
    compactions = result.stats.compactions;
    const sent = JSON.stringify(messages), forwarded = JSON.stringify(result.request.messages);
    for (const f of facts) if (sent.includes(f.marker) && !forwarded.includes(f.marker)) lost.add(f.id);
  }
  return {
    compactions, compressionRatio: Number((1 - tokensOut / tokensIn).toFixed(4)), factsPlanted: facts.length,
    factsSurvived: facts.length - lost.size, requests: session.steps, tokensIn, tokensOut,
  };
}

test('published compression and fact-survival numbers match the golden file', () => {
  const actual: Record<string, Metrics> = {};
  for (const id of SCENARIOS) actual[id] = measure(id);
  if (process.env['KITZUR_UPDATE_GOLDEN'] === '1') {
    assert.notEqual(process.env['CI'], 'true', 'KITZUR_UPDATE_GOLDEN=1 is not allowed when CI=true');
    const sorted = Object.fromEntries(Object.keys(actual).sort().map(id => [id,
      Object.fromEntries(Object.entries(actual[id]!).sort(([a], [b]) => (a < b ? -1 : 1)))]));
    writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Metrics>;
  assert.deepEqual(Object.keys(golden).sort(), [...SCENARIOS].sort(), `the golden scenario set changed; ${REFRESH}`);
  const moved: string[] = [];
  for (const id of SCENARIOS) {
    const got = actual[id]!, want = golden[id]!;
    for (const metric of COUNTS) {
      if (got[metric] !== want[metric]) moved.push(`${id} ${metric}: ${want[metric]} -> ${got[metric]} (${got[metric] - want[metric] > 0 ? '+' : ''}${got[metric] - want[metric]})`);
    }
    const delta = got.compressionRatio - want.compressionRatio;
    if (Math.abs(delta) > 0.005) moved.push(`${id} compressionRatio: ${want.compressionRatio} -> ${got.compressionRatio} (${delta > 0 ? '+' : ''}${delta.toFixed(4)}, band 0.005)`);
  }
  assert.deepEqual(moved, [], `published numbers moved:\n  ${moved.join('\n  ')}\nIf the change is intended, ${REFRESH}`);
});
