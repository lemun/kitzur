import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { USAGE } from '../../src/cli/usage.js';
import { completionData, renderBash, renderFish, renderZsh } from '../../src/cli/commands/completions.js';

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

function hint(script: string): string {
  return script.split('\n').find((line) => line.startsWith('#') && !line.startsWith('#!') && !line.startsWith('#compdef'))!;
}

test('README explains how to install shell completion for each supported shell', () => {
  assert.match(readme, /^#+\s+Shell completion\s*$/m);
  for (const shell of ['bash', 'zsh', 'fish']) assert.ok(readme.includes(`kitzur completions ${shell}`), shell);
});

test('README install idioms match the hints the scripts print', () => {
  const data = completionData();
  const bash = hint(renderBash(data));
  const zsh = hint(renderZsh(data));
  const fish = hint(renderFish(data));
  assert.ok(bash.includes('source <(kitzur completions bash)'));
  assert.ok(readme.includes('source <(kitzur completions bash)'));
  assert.ok(zsh.includes('_kitzur') && zsh.includes('$fpath'));
  assert.ok(readme.includes('_kitzur') && readme.includes('$fpath'));
  const target = /kitzur completions fish > (\S+)/.exec(fish)![1]!;
  assert.ok(readme.includes(`kitzur completions fish > ${target}`), target);
});

test('README Commands block report line spells --by as USAGE does', () => {
  const by = /^ {2}report .*?(\[--by [^\]]+\])/m.exec(USAGE)![1]!;
  const line = readme.split('\n').find((l) => l.startsWith('kitzur report '))!;
  assert.ok(line.includes(by), `${line} lacks ${by}`);
});
