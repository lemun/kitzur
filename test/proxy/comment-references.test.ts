import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../helpers.js';

// Comments and messages in the proxy, dialect, CLI and tokenizer code must stand alone: no numbered
// section signs, ADR numbers or invariant tags that no repository document defines, and no empty
// parentheses left behind where such a reference was removed.

const PATHS = ['src/proxy', 'src/dialect', 'src/cli', 'src/cli.ts', 'src/app.ts', 'src/tokenize', 'test/proxy', 'test/cli', 'test/rules'];
const TAG = new RegExp('\\u00a7|\\bADR-?[0-9]+\\b|\\bI[0-9]\\b');
// an empty '()' in comment text that is not a call (`f()`) or an arrow function (`() =>`)
const EMPTY_PARENS = /(^|[ ,;:])\(\s*\)(?!\s*(=>|\{|:))|\(\s*[,;:]/;

test('no dangling specification references or empty parentheses in comments', (t) => {
  const git = spawnSync('git', ['ls-files', '-z', '--', ...PATHS], { cwd: ROOT, encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    t.skip('git or a git checkout is unavailable; cannot list tracked files');
    return;
  }
  const hits: string[] = [];
  for (const file of git.stdout.split('\0').filter(Boolean)) {
    let text: string;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; } // deleted in the working tree
    text.split('\n').forEach((line, i) => {
      const at = line.indexOf('//');
      const trimmed = line.trimStart();
      const comment = trimmed.startsWith('*') || trimmed.startsWith('/*') ? trimmed : at >= 0 ? line.slice(at + 2) : '';
      if (TAG.test(line) || EMPTY_PARENS.test(comment)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], 'state the rule in words instead of citing an undefined section or tag');
});
