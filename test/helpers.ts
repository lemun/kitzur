import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (tests run from dist/test/...). */
export const ROOT = (() => {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, 'package.json'))) d = dirname(d);
  return d;
})();

/** Dev tokenizer: $KITZUR_TEST_TOKENIZER or bench/.cache/Qwen3.6-27B-tokenizer.json (see scripts/fetch-tokenizer.sh). */
export function testTokenizerPath(): string | null {
  const p = process.env['KITZUR_TEST_TOKENIZER'] ?? join(ROOT, 'bench', '.cache', 'Qwen3.6-27B-tokenizer.json');
  return existsSync(p) ? p : null;
}
