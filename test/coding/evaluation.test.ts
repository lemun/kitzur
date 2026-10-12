import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, grade, type EvalOptions } from '../../bench/coding/runner.js';
import { TASKS } from '../../bench/coding/tasks.js';
const options: EvalOptions = { mock: true, model: 'deterministic-mock', repeats: 2, maxTurns: 8, timeoutMs: 15000, outputTokens: 256, window: 16000, pressureChars: 4000 };
test('mock matched runs edit real files and executable grading rejects wrong solutions', async () => {
    const result = await evaluate(options);
    assert.equal(result.liveValidation, 'pending');
    assert.equal(result.clientCompactionPolicy, 'none');
    assert.equal(result.runs.length, 12);
    for (const run of result.runs) {
        assert.equal(run.outcome, 'pass');
        assert.equal(run.checksPassed, run.checksTotal);
        assert.equal(run.attempts.length, 4);
        assert.equal(run.usageCoverage, 4);
        assert.ok(run.promptTokens! > 0);
    }
    assert.equal(new Set(result.runs.filter(r => r.task === TASKS[0]!.id).map(r => r.workspaceHash)).size, 1);
    const wrong = await evaluate({ ...options, repeats: 1, mockWrong: true });
    assert.ok(wrong.runs.every(r => r.outcome === 'fail' && r.checksPassed < r.checksTotal));
});
test('missing usage remains unknown; pressure overflow is distinct from completion', async () => {
    const unknown = await evaluate({ ...options, repeats: 1, mockMissingUsage: true }, [TASKS[0]!]);
    for (const run of unknown.runs) {
        assert.equal(run.promptTokens, null);
        assert.equal(run.usageCoverage, 0);
    }
    const pressure = await evaluate({ ...options, repeats: 1, maxTurns: 12, pressureChars: 60000, postPressureChars: 30000 }, [TASKS[0]!]);
    assert.equal(pressure.runs.find(r => r.arm === 'direct')!.outcome, 'overflow');
    assert.ok(pressure.runs.find(r => r.arm === 'kitzur')!.compactions! > 0);
    const compacted = pressure.runs.find(r => r.arm === 'kitzur')!;
    assert.equal(compacted.outcome, 'pass');
    assert.ok(compacted.postCorrectionCompactions! > 0);
    const prompts = compacted.attempts.filter(a => a.afterCorrection && a.compactedPrompt);
    assert.ok(prompts.length > 0);
    assert.ok(prompts.every(a => a.currentRulePresent));
    // Prefix stability retains the previous summary until the next compaction.
    // After post-correction compactions, the last forwarded history drops the old rule.
    assert.equal(prompts.at(-1)!.obsoleteRulePresent, false);
});
test('early completion receives correction; malformed finish/API400 are not successes or overflows', async () => {
    const early = await evaluate({ ...options, repeats: 1, mockEarlyFinal: true }, [TASKS[0]!]);
    assert.ok(early.runs.every(r => r.outcome === 'pass' && r.turns === 5));
    const bad = await evaluate({ ...options, repeats: 1, mockReject: true }, [TASKS[0]!]);
    assert.ok(bad.runs.every(r => r.outcome === 'harness-error'));
    const filtered = await evaluate({ ...options, repeats: 1, mockFinishReason: 'content_filter' }, [TASKS[0]!]);
    assert.ok(filtered.runs.every(r => r.outcome === 'harness-error'));
    const length = await evaluate({ ...options, repeats:1, mockLengthWithTools:true }, [TASKS[0]!]);
    assert.ok(length.runs.every(r=>r.outcome==='incomplete'&&r.turns===1));
});
test('timeout preserves dispatched attempts and retry accounting covers rejected attempt', async () => {
    const timeout = await evaluate({ ...options, repeats: 1, timeoutMs: 200, mockDelayMs: 1000 }, [TASKS[0]!]);
    assert.ok(timeout.runs.every(r => r.outcome === 'timeout' && r.attempts.length > 0 && r.attempts[0]!.bodyBytes > 0 && r.promptTokens === null));
    const retry = await evaluate({ ...options, repeats: 1, mockRetry: true, pressureChars: 40000 }, [TASKS[0]!]);
    const proxied = retry.runs.find(r => r.arm === 'kitzur')!;
    assert.equal(proxied.outcome, 'pass');
    assert.equal(proxied.attempts[0]!.status, 400);
    assert.ok(proxied.attempts.length > proxied.turns);
    assert.equal(proxied.promptTokens, null);
    const partial = await evaluate({ ...options, repeats: 1, mockPartialUsage: true }, [TASKS[0]!]);
    assert.ok(partial.runs.every(r => r.promptUsageCoverage === r.attempts.length && r.completionUsageCoverage === 0 && r.promptTokens === null));
    const invalid = await evaluate({...options,repeats:1,mockInvalidUsage:true},[TASKS[0]!]);
    assert.ok(invalid.runs.every(r=>r.promptUsageCoverage===0&&r.promptTokens===null));
    const laterTimeout = await evaluate({...options,repeats:1,timeoutMs:1000,pressureChars:60000,mockDelayMs:1500,mockDelayAfterTurn:1},[TASKS[0]!]);
    const lateProxy=laterTimeout.runs.find(r=>r.arm==='kitzur')!;
    assert.equal(lateProxy.outcome,'timeout');assert.ok(lateProxy.compactions!>0,'preserve compactions before timeout');
});
test('private grader rejects incorrect exports and symlink task files', () => {
    const root = mkdtempSync(join(tmpdir(), 'kitzur-grader-'));
    writeFileSync(join(root, 'solution.mjs'), 'export function solve(xs){return xs;}');
    assert.ok(grade(root, TASKS[0]!).passed < 3);
    const other = mkdtempSync(join(tmpdir(), 'kitzur-grader-link-'));
    symlinkSync(join(root, 'solution.mjs'), join(other, 'solution.mjs'));
    assert.throws(() => grade(other, TASKS[0]!));
});
