import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runExperiment } from '../../bench/harness.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { buildScenario } from '../../bench/scenarios/index.js';
import { Kitzur } from '../../bench/systems/kitzur.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/bench/published-numbers.json');
const scenarioId = 'qa46-ref';
const scenario = buildScenario(scenarioId, '100k');

// The mock's counter deliberately uses a deterministic estimate so this regression never needs a tokenizer file.
const counter = new PromptCounter({
  vocabSize: 0,
  addedTokens: new Map(),
  count: text => Math.ceil(Array.from(text).length / 4),
  encode: text => Array.from({ length: Math.ceil(Array.from(text).length / 4) }, (_, i) => i),
  clearCache() {},
});

async function measure() {
  const runDir = join(dirname(fixture), `published-numbers-${process.pid}`);
  const result = await runExperiment({
    name: scenarioId,
    runDir,
    system: new Kitzur({ name: 'kitzur-estimate', preset: '100k', tokenizer: null, set: { 'tokenizer.mode': 'estimate' } }),
    scenario: scenario.reference!,
    counter,
    client: { steps: scenario.sessions[0]!.steps, maxTokens: 32000 },
  });
  const input = result.client.reduce((sum, record) => sum + Number(record.orig_est_tokens ?? 0), 0);
  const output = result.mock.reduce((sum, record) => sum + Number(record.prompt_tokens ?? 0), 0);
  const ledger = readFileSync(join(runDir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { action?: string });
  const facts = scenario.facts.filter(f => f.gate && f.expect === 'survive');
  const surviving = facts.filter(f => result.mock.filter(r => r.status === 200).every(r => JSON.stringify(r.facts).includes(f.marker))).length;
  return {
    compactions: ledger.filter(row => row.action === 'compacted').length,
    compressionRatio: Number((1 - output / input).toFixed(6)),
    factsSurvived: surviving,
    factsPlanted: facts.length,
    tokensIn: input,
    tokensOut: output,
  };
}

test('published benchmark numbers stay within their committed bounds', async () => {
  const actual = { [scenarioId]: await measure() };
  if (process.env['KITZUR_UPDATE_GOLDEN'] === '1') {
    assert.notEqual(process.env['CI'], 'true', 'golden refresh is forbidden when CI=true');
    writeFileSync(fixture, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, typeof actual[typeof scenarioId]>;
  const failures: string[] = [];
  for (const [scenarioName, metrics] of Object.entries(actual)) {
    const golden = expected[scenarioName];
    assert.ok(golden, `missing golden scenario ${scenarioName}; refresh with KITZUR_UPDATE_GOLDEN=1 npm test -- ...`);
    for (const metric of ['tokensIn', 'tokensOut', 'compactions', 'factsSurvived', 'factsPlanted'] as const) {
      if (metrics[metric] !== golden[metric]) failures.push(`${scenarioName} ${metric} moved by ${metrics[metric] - golden[metric]} (${golden[metric]} → ${metrics[metric]})`);
    }
    const delta = metrics.compressionRatio - golden.compressionRatio;
    if (Math.abs(delta) > 0.005) failures.push(`${scenarioName} compressionRatio moved by ${delta.toFixed(6)}`);
  }
  assert.deepEqual(failures, [], `${failures.join('; ')}. Refresh with: KITZUR_UPDATE_GOLDEN=1 npm test -- ...`);
});
