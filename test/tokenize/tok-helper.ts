// Test helper: the dev tokenizer (test/helpers.ts testTokenizerPath), loaded once per test process
// through the compiled cache in the OS temp dir, so each test file pays ~0.1 s instead of ~1.3 s.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTokenizerCached, type LoadedTokenizer } from '../../src/tokenize/load.js';
import { testTokenizerPath } from '../helpers.js';

let tok: LoadedTokenizer | null | undefined;

export function testTokenizer(): LoadedTokenizer | null {
  if (tok !== undefined) return tok;
  const p = testTokenizerPath();
  tok = p ? loadTokenizerCached(p, null, { stateDir: join(tmpdir(), 'kitzur-test-tokenizer-cache') }) : null;
  return tok;
}
