// Compare explicit expected retained facts against a historical algorithm. This
// is mechanical correction evaluation, separate from real model task success.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluate, type EvalOptions, type Run } from './runner.js';
import { TASKS } from './tasks.js';
import { evidenceReread, retentionHistory } from '../scenarios/evidence-reread.js';
import ts from 'typescript';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import * as current from '../../src/engine/ledger/supersede.js';
import { CORRECTION_CASES } from './correction-cases.js';
async function compareRevision() {
    const ref = process.argv[2] ?? '3f9afb8';
    if (!/^[a-zA-Z0-9_/.~-]+$/.test(ref))
        throw Error('Invalid comparison revision');
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const prior = spawnSync('git', ['show', `${ref}:src/engine/ledger/supersede.ts`], { cwd: root, encoding: 'utf8', maxBuffer: 100000 });
    if (prior.status !== 0)
        throw Error('Comparison revision unavailable');
    const source = prior.stdout.replaceAll("'./stopwords.js'", JSON.stringify(new URL('../../src/engine/ledger/stopwords.js', import.meta.url).href)).replaceAll("'./text.js'", JSON.stringify(new URL('../../src/engine/ledger/text.js', import.meta.url).href));
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const before = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as typeof current;
    const results = CORRECTION_CASES.map(f => {
        const run = (algo: typeof current) => { const r = algo.supersede([{ index: 1, text: f.older, head: false }, { index: 2, text: f.later, head: false }], algo.supersedeRules(DEFAULT_CONFIG.ledger), new Set()); return r.sentences.get(1)!.flatMap((s, i) => s.supersededBy === 2 ? [i] : []); };
        const old = run(before), now = run(current);
        const equal = (x: number[]) => JSON.stringify(x) === JSON.stringify(f.superseded);
        return { case: f.name, expectedSuperseded: f.superseded, beforeSuperseded: old, afterSuperseded: now, beforeCorrect: equal(old), afterCorrect: equal(now) };
    });
    process.stdout.write(JSON.stringify({ kind: 'mechanical-correction-fixtures', beforeRevision: ref, cases: results.length, beforeCorrect: results.filter(x => x.beforeCorrect).length, afterCorrect: results.filter(x => x.afterCorrect).length, results }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await compareRevision();

export function retentionScores(run: Run) {
    const corrected = run.attempts.filter(a => a.afterCorrection && a.status === 200);
    const reads = run.evidenceReads ?? [];
    return {
        exactTaskAcceptance: run.outcome === 'pass' && run.checksPassed === run.checksTotal,
        correctionSurvival: { observed: corrected.length, current: corrected.filter(a => a.currentRulePresent).length,
            obsolete: corrected.filter(a => a.obsoleteRulePresent).length },
        repeatedReadsOfEvictedEvidence: reads.filter(r => r.evicted).length,
        evidenceReads: reads.length,
        evidenceObservationCoverage: run.attempts.filter(a => a.evidencePresent !== undefined).length,
        overflow: run.outcome === 'overflow',
        overflowAttempts: run.attempts.filter(a => a.overflow === true).length,
        latencyMs: run.latencyMs,
        usageCoverage: { observed: run.usageCoverage, attempts: run.attempts.length,
            prompt: run.promptUsageCoverage, completion: run.completionUsageCoverage },
        promptTokens: run.promptTokens, completionTokens: run.completionTokens,
    };
}

// Offline only. Independent implementation of pinned/bounded comparison, no
// Gobstopper code copied. Real model evaluation uses evaluate() in a separately
// authorized expendable environment; see bench/coding/README.md's Future real runs.
export async function evaluateRetention(overrides: Partial<EvalOptions> = {}) {
    if (overrides.mock === false || overrides.endpoint || overrides.apiKey) throw Error('Retention matrix is offline only');
    const tasks = [TASKS[0]!, evidenceReread];
    const reports = [];
    for (const window of [32000, 64000]) {
        const options: EvalOptions = { model: 'deterministic-mock', repeats: 1, maxTurns: 12, timeoutMs: 15000,
            outputTokens: 512, pressureChars: window * 2, postPressureChars: window,
            ...overrides, mock: true, window };
        const report = await evaluate(options, tasks);
        const fixtureHash = createHash('sha256').update(JSON.stringify({ tasks,
            histories: tasks.map(t => retentionHistory(t, options.pressureChars ?? 18000)),
            evidence: evidenceReread.evidence, settings: report.settings })).digest('hex');
        reports.push({ ...report, fixtureHash, scores: report.runs.map(run => ({ task: run.task, repeat: run.repeat,
            arm: run.arm, ...retentionScores(run) })) });
    }
    return { kind: 'offline-retention-quality', baseline: 'direct (no client compaction)', candidate: 'current ledger',
        caveat: 'Stub decisions validate the harness, not model quality. Usage is synthetic; latency is local wall time.', reports };
}
