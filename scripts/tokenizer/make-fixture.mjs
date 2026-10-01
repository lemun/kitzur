// Build a compact committed fixture (text + Python ids) from data/corpus.jsonl + data/ref.jsonl.
import { readFileSync, writeFileSync } from 'node:fs';
const corpus = readFileSync('data/corpus.jsonl', 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
const ref = readFileSync('data/ref.jsonl', 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l).ids);
const limits = { fuzz: 600, 'nfc-order': 200, 'snapshot-300k': 0, 'rendered-request': 1 };
const seen = {};
const out = [];
for (let i = 0; i < corpus.length; i++) {
  const { cat, text } = corpus[i];
  const lim = limits[cat] ?? 25;
  if ((seen[cat] ?? 0) >= lim) continue;
  if (text.length > 60000 && cat !== 'rendered-request') continue;
  seen[cat] = (seen[cat] ?? 0) + 1;
  out.push(JSON.stringify({ cat, text, ids: ref[i] }));
}
writeFileSync('data/fixture-small.jsonl', out.join('\n') + '\n');
console.log(seen, out.length, 'cases', (out.join('\n').length / 1e6).toFixed(2), 'MB');
