// Smoke run: the reference session (capBytes 51200) through a real `kitzur serve` child process over HTTP,
// counted by the bench mock. Usage: node dist/bench/smoke-kitzur.js [preset=100k] [steps=46] [chatty]
import { runExperiment } from './harness.js';
import { report } from './analyze.js';
import { Kitzur } from './systems/kitzur.js';
import { benchTokenizerPath } from './lib/paths.js';

const preset = process.argv[2] ?? '100k';
const steps = Number(process.argv[3] ?? 46);
const chatty = process.argv.includes('chatty');
const limits: Record<string, [number, number]> = { '32k': [32000, 8000], '64k': [64000, 16000], '100k': [100000, 32000], '128k': [128000, 32000] };
const [limit, maxTokens] = limits[preset]!;
const res = await runExperiment({
  name: `smoke_kitzur_${preset}${chatty ? '_chatty' : ''}`,
  system: new Kitzur({ preset, tokenizer: benchTokenizerPath() }),
  scenario: { capBytes: 51200, chatty },
  mock: { limit },
  client: { steps, maxTokens, saveOrigs: true },
});
const r = report(res.runDir);
console.log(r.text);
console.log(JSON.stringify(r.summary));
