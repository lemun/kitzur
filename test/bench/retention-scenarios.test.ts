import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceReread, retentionHistory } from '../../bench/scenarios/evidence-reread.js';
import { evaluateRetention, retentionScores } from '../../bench/coding/retention.js';
import { grade, type Run } from '../../bench/coding/runner.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import { createEngine } from '../../src/engine/engine.js';
import { createSummarizer } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { retentionQualityReport } from '../../bench/report.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('pinned evidence histories are deterministic, paired and pressure follows old evidence', () => {
  for (const window of [32000, 64000]) {
    const history = retentionHistory(evidenceReread, window * 2);
    assert.deepEqual(history, retentionHistory(evidenceReread, window * 2));
    assert.equal(history[5]!.content, evidenceReread.evidence!.content);
    assert.equal(history[5]!.tool_call_id, history[4]!.tool_calls![0]!.id);
    assert.ok(JSON.stringify(history.slice(6)).length > window * 2);
    assert.equal(digest(history), window === 32000 ? 'bd9edd18c62bf75649b504db0608e86d0fad0316cf616a59913b7d4523fe3231' : '4604150cfd89454d5ddebf58d1b823893e04c77bcff79b746f174b9fff6b9e8a');
  }
});
test('acceptance needs the old file value and the corrected operation', () => {
  const root = mkdtempSync(join(tmpdir(), 'retention-grade-'));
  for (const source of [evidenceReread.initial, 'export function solve(x) { return x + 731; }']) {
    writeFileSync(join(root, 'solution.mjs'), source);
    assert.equal(grade(root, evidenceReread).passed, 0);
  }
  writeFileSync(join(root, 'solution.mjs'), evidenceReread.solution);
  assert.deepEqual(grade(root, evidenceReread), { passed: 3, total: 3 });
});
test('scores distinguish partial acceptance, missing usage, correction loss and recovered overflow', () => {
  const run: Run = { task: evidenceReread.id, repeat: 0, arm: 'kitzur', outcome: 'incomplete', checksPassed: 3,
    checksTotal: 3, turns: 2, latencyMs: 7, promptTokens: null, completionTokens: null, usageCoverage: 0,
    promptUsageCoverage: 1, completionUsageCoverage: 0, compactions: 1, postCorrectionCompactions: 1, workspaceHash: '',
    evidenceReads: [{ sha256: 'same', evicted: true }, { sha256: 'same', evicted: false }],
    attempts: [{ status: 400, overflow: true, latencyMs: 1, promptTokens: null, completionTokens: null, bodyBytes: 10,
      afterCorrection: true, compactedPrompt: true, currentRulePresent: true, obsoleteRulePresent: true },
      { status: 200, latencyMs: 2, promptTokens: 8, completionTokens: null, bodyBytes: 20,
        afterCorrection: true, compactedPrompt: true, currentRulePresent: false, obsoleteRulePresent: true }] };
  const scores = retentionScores(run);
  assert.equal(scores.exactTaskAcceptance, false);
  assert.deepEqual(scores.correctionSurvival, { observed: 1, current: 0, obsolete: 1 });
  assert.equal(scores.repeatedReadsOfEvictedEvidence, 1);
  assert.equal(scores.overflow, false);
  assert.equal(scores.overflowAttempts, 1);
  assert.equal(scores.promptTokens, null);
  assert.deepEqual(scores.usageCoverage, { observed: 0, attempts: 2, prompt: 1, completion: 0 });
  const markdown = retentionQualityReport({ caveat: 'not model quality', reports: [32000, 64000].map(window => ({
    settings: { window }, fixtureHash: 'pinned', scores: [{ task: run.task, arm: run.arm, ...scores }] })) });
  for (const label of ['acceptance', 'correction', 'evicted rereads', 'overflow', 'latency', 'usage', '32000', '64000', 'unknown']) assert.ok(markdown.includes(label));
});
test('matrix refuses live settings before starting a model or listener', async () => {
  await assert.rejects(evaluateRetention({ mock: false }), /offline only/);
  await assert.rejects(evaluateRetention({ endpoint: 'http://example.invalid' }), /offline only/);
});
test('paired offline matrix reports every score at both served windows', async t => {
  const probe = http.createServer();
  const allowed = await new Promise<boolean>((resolve, reject) => {
    probe.once('error', (e: NodeJS.ErrnoException) => e.code === 'EPERM' ? resolve(false) : reject(e));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (!allowed) return t.skip('sandbox denies loopback listeners (EPERM)');
  const matrix = await evaluateRetention();
  assert.deepEqual(matrix.reports.map(r => r.settings.window), [32000, 64000]);
  for (const report of matrix.reports) {
    assert.equal(report.runs.length, 4);
    assert.match(report.fixtureHash, /^[a-f0-9]{64}$/);
    const evidence = report.runs.find(r => r.arm === 'kitzur' && r.task === 'evidence-reread')!;
    assert.equal(evidence.outcome, 'pass');
    assert.ok(evidence.postCorrectionCompactions! > 0);
    assert.ok(evidence.evidenceReads!.some(r => r.evicted));
    assert.equal(new Set(evidence.evidenceReads!.map(r => r.sha256)).size, 1);
  }
  const markdown = retentionQualityReport(matrix);
  for (const label of ['acceptance', 'correction', 'evicted rereads', 'overflow', 'latency', 'usage', '32000', '64000']) assert.ok(markdown.includes(label));
  assert.ok(markdown.includes('not model quality'));
});

test('served-window fixture pressure evicts old evidence while retaining the later correction', () => {
  for (const window of [32000, 64000]) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.budget.window = window;
    cfg.budget.defaultMaxTokens = 512;
    cfg.tokenizer.mode = 'estimate';
    cfg.tokenizer.template.name = 'generic';
    const counter = counterFromConfig(cfg);
    const engine = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg) });
    const messages = retentionHistory(evidenceReread, window * 2);
    messages.push({ role: 'user', content: evidenceReread.correction });
    let evicted = false;
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `log-${i}`, type: 'function', function: { name: 'run_tests', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `log-${i}`, content: 'Syntax check passed.\n' + 'Archived diagnostic log; no source changes. '.repeat(Math.ceil(window / 42)) });
      const result = engine.process({ model: 'deterministic-mock', messages, max_tokens: 512 }, { attempt: 1 });
      assert.ok(result.request, result.reason);
      const text = JSON.stringify(result.request.messages);
      assert.ok(text.includes(evidenceReread.currentRule));
      if (!text.includes(evidenceReread.evidence!.marker)) evicted = true;
      assert.ok(counter.countRequest(result.request) + 512 <= window);
    }
    assert.ok(evicted, `old evidence must be evicted at ${window}`);
  }
});
