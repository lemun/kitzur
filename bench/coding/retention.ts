// Compare explicit expected retained facts against a historical algorithm. This
// is mechanical correction evaluation, separate from real model task success.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import * as current from '../../src/engine/ledger/supersede.js';
import { CORRECTION_CASES } from './correction-cases.js';
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
