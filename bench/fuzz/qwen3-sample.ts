// benchmark contract : "A sample of 2,000 qwen3 requests is also checked against Python jinja2 + tokenizers."
//
//   node dist/bench/fuzz/qwen3-sample.js make  OUT_CORPUS.json [--count 2000] [--base 700000]
//   python bench/mock/make-qwen3-goldens.py OUT_CORPUS.json TOKENIZER.json OUT_GOLDENS.json.gz   (QWEN_TEMPLATE=…)
//   node dist/bench/fuzz/qwen3-sample.js check OUT_CORPUS.json OUT_GOLDENS.json.gz [--out bench/results/fuzz.json]
//
// `make` grows qwen3 fuzz chains (exact counter) through the production engine and keeps both the client requests
// and the forwarded requests (half each) as JSON bodies. `check` compares, per body, the Python render (vLLM's
// preprocessing + the real Jinja template, rendered by jinja2) and its `tokenizers` count with
//   - the fuzz oracle: bench/mock/qwen3-render.ts + PromptCounter (render text sha256 and token count), and
//   - the engine's counter (src/tokenize/counter.ts qwen3 profile), whose images cost tokenizer.imageTokens: its
//     count minus images × (imageTokens − 3) must equal the Python count.
// Bodies whose text holds a lone surrogate are skipped (Python `tokenizers` refuses them).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatRequest } from '../../src/types.js';
import { counterFromConfig } from '../../src/tokenize/counter.js';
import { templateKwargs } from '../../src/engine/learned.js';
import { PromptCounter } from '../lib/render.js';
import { renderQwen3 } from '../mock/qwen3-render.js';
import { RESULTS_DIR } from '../lib/paths.js';
import { genChain } from './gen.js';
import { counterFor, engineFor } from './invariants.js';
import { fuzzTokenizer } from './run.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const LONE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

interface Case {
  name: string;
  body: string;
  /** the engine counter's raw count and the image count (for the imageTokens re-pricing) */
  counter: number | null;
  images: number;
  imageTokens: number;
}

function make(out: string): void {
  const count = Number(arg('count', '2000'));
  const base = Number(arg('base', '700000'));
  const tok = fuzzTokenizer();
  if (!tok) throw new Error('needs the dev tokenizer');
  const cases: Case[] = [];
  let skipped = 0;
  for (let seed = base; cases.length < count; seed++) {
    const c = genChain(seed, { exact: true, template: 'qwen3' });
    if (c.mode !== 'exact') continue;
    const counter = counterFor(c, tok);
    const e = engineFor(c.cfg, counter);
    for (let k = 0; k < c.requests.length && cases.length < count; k++) {
      const req = c.requests[k]!;
      const l = c.learned[k];
      const r = e.process(req, l ? { attempt: 1, learned: { ...l, counterId: counter.id } } : { attempt: 1 });
      for (const [tag, q] of [['in', req], ['out', r.request]] as const) {
        if (!q || (tag === 'out' && q === req)) continue;
        const kw = templateKwargs(c.cfg, q);
        const body: Record<string, unknown> = { messages: q.messages };
        if (q.tools !== undefined) body['tools'] = q.tools;
        if (Object.keys(kw).length) body['chat_template_kwargs'] = kw;
        const text = JSON.stringify(body);
        // JSON.stringify writes a lone surrogate as a \\udXXX escape (pairs stay raw)
        if (LONE_ESCAPE.test(text)) {
          skipped++;
          continue;
        }
        let cnt: number | null = null;
        try {
          cnt = counter.countRequest({ ...(q as ChatRequest), ...(Object.keys(kw).length ? { chat_template_kwargs: kw } : {}) });
        } catch {
          cnt = null;
        }
        const images = (text.match(/"type":"image_url"/g) ?? []).length;
        cases.push({ name: `s${seed}-r${k}-${tag}`, body: text, counter: cnt, images, imageTokens: c.cfg.tokenizer.imageTokens });
      }
    }
  }
  writeFileSync(out, JSON.stringify(cases));
  console.log(`qwen3 sample: ${cases.length} bodies (${skipped} skipped: lone surrogates) → ${out}`);
}

function check(corpus: string, goldens: string): void {
  const tok = fuzzTokenizer();
  if (!tok) throw new Error('needs the dev tokenizer');
  const pc = new PromptCounter(tok);
  const cases = JSON.parse(readFileSync(corpus, 'utf8')) as Case[];
  const gold = JSON.parse(gunzipSync(readFileSync(goldens)).toString('utf8')) as {
    template_sha256: string; jinja2: string; cases: Array<{ name: string; render_sha256?: string; tokens?: number; error: { type: string; message: string } | null }>;
  };
  const byName = new Map(gold.cases.map((g) => [g.name, g]));
  let rendered = 0;
  let renderEq = 0;
  let oracleEq = 0;
  let counterEq = 0;
  let counterN = 0;
  let bothErr = 0;
  const mismatches: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const g = byName.get(c.name);
    if (!g) continue;
    let text: string | null = null;
    let jsErr: string | null = null;
    try {
      text = renderQwen3(c.body);
    } catch (e) {
      jsErr = e instanceof Error ? e.message : String(e);
    }
    if (g.error !== null || jsErr !== null) {
      if (g.error !== null && jsErr !== null) bothErr++;
      else mismatches.push({ name: c.name, python: g.error, js: jsErr });
      continue;
    }
    rendered++;
    const sha = createHash('sha256').update(text!, 'utf8').digest('hex');
    if (sha === g.render_sha256) renderEq++;
    const n = pc.countText(text!);
    if (n === g.tokens) oracleEq++;
    else mismatches.push({ name: c.name, kind: 'oracle-count', python: g.tokens, oracle: n, renderEq: sha === g.render_sha256 });
    if (c.counter !== null) {
      counterN++;
      const adj = c.counter - c.images * (c.imageTokens - 3);
      if (adj === g.tokens) counterEq++;
      else mismatches.push({ name: c.name, kind: 'counter-count', python: g.tokens, counter: c.counter, adjusted: adj, images: c.images });
    }
  }
  const res = {
    bodies: cases.length, rendered, bothRejected: bothErr, renderShaEqual: renderEq, oracleCountEqual: oracleEq,
    counterChecked: counterN, counterCountEqual: counterEq, mismatches: mismatches.length, firstMismatches: mismatches.slice(0, 10),
    template_sha256: gold.template_sha256, jinja2: gold.jinja2,
  };
  const outPath = arg('out', join(RESULTS_DIR, 'fuzz.json'));
  let doc: Record<string, unknown> = {};
  if (existsSync(outPath)) {
    try {
      doc = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    } catch {
      doc = {};
    }
  }
  doc['qwen3Sample'] = res;
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(JSON.stringify(res, null, 1));
  process.exitCode = mismatches.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'make' && a) make(a);
  else if (mode === 'check' && a && b) check(a, b);
  else {
    console.error('usage: qwen3-sample.js make CORPUS.json | check CORPUS.json GOLDENS.json.gz');
    process.exitCode = 2;
  }
}
