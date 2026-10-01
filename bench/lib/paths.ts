// Locations the harness needs. Nothing session-specific is hard-coded: external inputs come from the
// environment (or CLI flags of the entry points).
//
//   KITZUR_BENCH_TOKENIZER  tokenizer.json for the mock/client counter
//                            (default: $KITZUR_TEST_TOKENIZER, then bench/.cache/Qwen3.6-27B-tokenizer.json)
//   KITZUR_REF_DIR          the Python reference harness layout: <ref>/sim/*.py, <ref>/venv/bin/python,
//                            <ref>/tok/Qwen_Qwen3.6-27B.json, <ref>/gobstopper/target/release/gobstopper,
//                            <ref>/runs/ (run.py writes there)
//   KITZUR_GOBSTOPPER_BIN   gobstopper v0.7.2 binary (default <ref>/gobstopper/target/release/gobstopper)

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTokenizer, type Tokenizer } from '../../src/tokenize/tokenizer.js';

/** Repository root (code runs from dist/bench/...). */
export const ROOT = (() => {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, 'package.json'))) {
    const up = dirname(d);
    if (up === d) throw new Error('repository root (package.json) not found');
    d = up;
  }
  return d;
})();

/** Raw per-run outputs (gitignored). */
export const RAW_RESULTS_DIR = join(ROOT, 'bench', 'results', 'raw');
export const RESULTS_DIR = join(ROOT, 'bench', 'results');

export function benchTokenizerPath(): string | null {
  const env = process.env['KITZUR_BENCH_TOKENIZER'] ?? process.env['KITZUR_TEST_TOKENIZER'];
  const p = env ?? join(ROOT, 'bench', '.cache', 'Qwen3.6-27B-tokenizer.json');
  return existsSync(p) ? p : null;
}

let tokMemo: Tokenizer | null = null;
/** The dev tokenizer, loaded once per process. Throws with a hint when it is missing. */
export function benchTokenizer(): Tokenizer {
  if (tokMemo) return tokMemo;
  const p = benchTokenizerPath();
  if (!p) throw new Error('no tokenizer.json: run scripts/fetch-tokenizer.sh or set KITZUR_BENCH_TOKENIZER');
  tokMemo = loadTokenizer(p);
  return tokMemo;
}

export interface RefHarness {
  dir: string;
  python: string;
  sim: string;
  runs: string;
}

/** The Python reference harness, when KITZUR_REF_DIR (or `dir`) points at a complete layout. */
export function refHarness(dir = process.env['KITZUR_REF_DIR']): RefHarness | null {
  if (!dir) return null;
  const python = join(dir, 'venv', 'bin', 'python');
  const sim = join(dir, 'sim');
  if (!existsSync(python) || !existsSync(join(sim, 'run.py')) || !existsSync(join(dir, 'tok', 'Qwen_Qwen3.6-27B.json'))) return null;
  return { dir, python, sim, runs: join(dir, 'runs') };
}

export function gobstopperBin(refDir = process.env['KITZUR_REF_DIR']): string | null {
  const p = process.env['KITZUR_GOBSTOPPER_BIN'] ?? (refDir ? join(refDir, 'gobstopper', 'target', 'release', 'gobstopper') : null);
  return p && existsSync(p) ? p : null;
}
