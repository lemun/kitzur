#!/usr/bin/env node
// Full agreement check of the repo's tokenizer (dist/src/tokenize/tokenizer.js; run `npm run build`
// first) against Python `tokenizers` ids on the 13,333-text corpus of the tokenizer study
// (scripts/tokenizer/gen_corpus.py writes data/corpus.jsonl + data/ref.jsonl with a Python venv).
//
//   node scripts/tokenizer/verify-full.mjs [--data DIR] [--tok tokenizer.json] [--cache file.lctk] [--nfc tables|icu]
//
// DIR defaults to $KITZUR_TOKENIZER_DATA. Prints per-category and total agreement (exact id
// sequences) and throughput; exits 1 on any mismatch, 2 when the data is missing.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const data = arg('data', process.env.KITZUR_TOKENIZER_DATA ?? null);
const tokPath = arg('tok', process.env.KITZUR_TEST_TOKENIZER ?? join(ROOT, 'bench', '.cache', 'Qwen3.6-27B-tokenizer.json'));
const cachePath = arg('cache', null);
const nfc = arg('nfc', 'tables');
if (!data || !existsSync(join(data, 'corpus.jsonl')) || !existsSync(join(data, 'ref.jsonl'))) {
  console.error('verify-full: no corpus (pass --data DIR with corpus.jsonl and ref.jsonl, or set KITZUR_TOKENIZER_DATA)');
  process.exit(2);
}
const dist = join(ROOT, 'dist', 'src', 'tokenize', 'tokenizer.js');
if (!existsSync(dist)) {
  console.error('verify-full: run `npm run build` first');
  process.exit(2);
}
const { loadTokenizer } = await import(dist);

let t0 = performance.now();
const tok = loadTokenizer(tokPath, { nfc, ...(cachePath ? { cachePath } : {}) });
const loadMs = performance.now() - t0;
const corpus = readFileSync(join(data, 'corpus.jsonl'), 'utf8').trimEnd().split('\n');
const ref = readFileSync(join(data, 'ref.jsonl'), 'utf8').trimEnd().split('\n');
if (corpus.length !== ref.length) throw new Error(`corpus ${corpus.length} vs ref ${ref.length} lines`);

const cats = new Map();
let ok = 0;
let tokens = 0;
let chars = 0;
const bad = [];
t0 = performance.now();
for (let i = 0; i < corpus.length; i++) {
  const { cat, text } = JSON.parse(corpus[i]);
  const want = JSON.parse(ref[i]).ids;
  const got = tok.encode(text);
  const same = got.length === want.length && got.every((x, j) => x === want[j]);
  const c = cats.get(cat) ?? { n: 0, ok: 0, tokens: 0, chars: 0 };
  c.n++;
  c.tokens += want.length;
  c.chars += text.length;
  if (same) {
    c.ok++;
    ok++;
  } else if (bad.length < 10) bad.push({ i, cat, text: text.slice(0, 80) });
  cats.set(cat, c);
  tokens += want.length;
  chars += text.length;
}
const ms = performance.now() - t0;
console.log(`tokenizer ${tokPath} (nfc=${nfc}${cachePath ? ', compiled cache' : ''}); load ${loadMs.toFixed(0)} ms; node ${process.version}`);
console.log('category'.padEnd(20), 'texts'.padStart(7), 'agree'.padStart(7), 'chars'.padStart(10), 'tokens'.padStart(10));
for (const [cat, c] of cats) console.log(cat.padEnd(20), String(c.n).padStart(7), String(c.ok).padStart(7), String(c.chars).padStart(10), String(c.tokens).padStart(10));
console.log(`TOTAL ${ok}/${corpus.length} texts agree (${((100 * ok) / corpus.length).toFixed(3)}%), ${tokens} tokens, ${chars} chars; encode ${ms.toFixed(0)} ms (${(tokens / ms / 1000).toFixed(2)}M tok/s)`);
for (const b of bad) console.log('MISMATCH', b.i, b.cat, JSON.stringify(b.text));
process.exit(ok === corpus.length ? 0 : 1);
