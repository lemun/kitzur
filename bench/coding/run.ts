import { writeFileSync } from 'node:fs';
import { evaluate, type EvalOptions } from './runner.js';
const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const at = args.indexOf('--' + name); return at < 0 ? fallback : args[at + 1] ?? fallback; };
const opts: EvalOptions = { mock: args.includes('--mock'), model: value('model', 'deterministic-mock'), endpoint: process.env.KITZUR_EVAL_ENDPOINT, apiKey: process.env.KITZUR_EVAL_API_KEY, repeats: Number(value('repeats', '2')), maxTurns: Number(value('max-turns', '12')), timeoutMs: Number(value('timeout-ms', '30000')), outputTokens: Number(value('output-tokens', '512')), window: Number(value('window', '16000')), pressureChars: Number(value('pressure-chars', '50000')), postPressureChars: Number(value('post-pressure-chars', '12000')) };
try {
    const result = await evaluate(opts);
    const text = JSON.stringify(result, null, 2) + '\n';
    const out = value('out', '');
    if (out)
        writeFileSync(out, text);
    else
        process.stdout.write(text);
}
catch {
    process.stderr.write('Coding evaluation failed; check endpoint and limits.\n');
    process.exitCode = 1;
}
