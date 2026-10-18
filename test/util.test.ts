import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeRe, mkdirs } from '../src/util.js';

test('escapeRe: a literal under every flag set, including u inside and outside classes', () => {
  const lit = 'a-b.c*d+e?f^g$h{i}j(k)l|m[n]o\\p/q';
  for (const flags of ['', 'g', 'u', 'gu', 'i']) {
    const re = new RegExp(escapeRe(lit), flags);
    assert.ok(re.test(`x${lit}y`), flags);
    assert.ok(!re.test(lit.replace('-', '_')), flags);
    assert.ok(new RegExp(`[${escapeRe('-a')}]`, flags).test('-'), `class ${flags}`);
  }
  assert.equal(new RegExp(['<|fim-pre|>', '<|im_end|>'].map(escapeRe).join('|'), 'gu').exec('x<|fim-pre|>')?.[0], '<|fim-pre|>');
});

test('mkdirs: creates every missing level, idempotent', () => {
  const d = join(mkdtempSync(join(tmpdir(), 'kitzur-util-')), 'a', 'b', 'c');
  mkdirs(d);
  mkdirs(d);
  assert.ok(existsSync(d));
});
