import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../../src/config/load.js';
import { DEFAULT_LEAVES, isInnerNode, LEAF_SPECS, suggestLeaf } from '../../src/config/spec.js';

/** The issues loadConfig reports for one file layer, without the source prefix. */
function fileIssues(layer: unknown): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-dym-'));
  try {
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify(layer));
    try {
      loadConfig({ configPath: file, env: {} });
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.issues.map((i) => i.slice(i.indexOf('unknown config key')));
    }
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a misspelled section gets a did-you-mean hint naming the section', () => {
  assert.deepEqual(fileIssues({ budgte: { window: 4096 } }), ['unknown config key budgte (did you mean budget?)']);
  assert.deepEqual(fileIssues({ Budget: { Window: 4096 } }), ['unknown config key Budget (did you mean budget?)']);
  assert.deepEqual(fileIssues({ tokenizer: { endpont: { style: 'vllm' } } }), [
    'unknown config key tokenizer.endpont (did you mean tokenizer.endpoint?)',
  ]);
  assert.throws(() => loadConfig({ env: {}, sets: ['Budget=1'] }), /unknown config key Budget \(did you mean budget\?\)/);
});

test('leaf typos keep their hints and far keys get none', () => {
  assert.deepEqual(fileIssues({ listen: { prot: 1 } }), ['unknown config key listen.prot (did you mean listen.port?)']);
  assert.deepEqual(fileIssues({ budget: { windw: 1 } }), ['unknown config key budget.windw (did you mean budget.window?)']);
  assert.deepEqual(fileIssues({ zzzzzzzz: 1 }), ['unknown config key zzzzzzzz']);
});

test('every suggestion for a mangled real path is a leaf or an inner node of the schema', () => {
  const inner = DEFAULT_LEAVES.map((l) => l.slice(0, l.lastIndexOf('.'))).filter((p) => p !== '');
  const real = [...new Set([...inner, ...DEFAULT_LEAVES])].filter((p) => p.length >= 5).slice(0, 10);
  assert.equal(real.length, 10);
  const mangled = real.flatMap((p) => {
    const i = Math.floor(p.length / 2);
    const drop = p.slice(0, i) + p.slice(i + 1);
    const swap = p.slice(0, i) + p[i + 1] + p[i] + p.slice(i + 2);
    const double = p.slice(0, i) + p[i] + p.slice(i);
    return [drop, swap, double];
  });
  assert.equal(mangled.length, 30);
  for (const m of mangled) {
    const s = suggestLeaf(m);
    if (s !== null) assert.ok(LEAF_SPECS[s] !== undefined || isInnerNode(s), `${m} -> ${s}`);
  }
});
