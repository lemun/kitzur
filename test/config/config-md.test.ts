import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { DEFAULT_LEAVES, getPath } from '../../src/config/spec.js';
import { ENV_MAP, LOADER_ENV } from '../../src/config/load.js';
import { computeBudget } from '../../src/config/derived.js';
import { loadConfig } from '../../src/config/load.js';
import { ROOT } from '../helpers.js';

const md = readFileSync(join(ROOT, 'CONFIG.md'), 'utf8');

/** The knob tables: `| \`key\` | default | … |` rows. */
function knobRows(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of md.split('\n')) {
    const m = /^\| `([A-Za-z0-9_.]+)` \| ([^|]*) \|/.exec(line);
    if (m && DEFAULT_LEAVES.includes(m[1]!)) rows.set(m[1]!, m[2]!.trim());
  }
  return rows;
}

test('CONFIG.md documents every key of DEFAULT_CONFIG in a knob table, once', () => {
  const rows = knobRows();
  const missing = DEFAULT_LEAVES.filter((k) => !rows.has(k));
  assert.deepEqual(missing, [], `undocumented keys: ${missing.join(', ')}`);
  for (const k of DEFAULT_LEAVES) {
    const n = md.split('\n').filter((l) => l.startsWith(`| \`${k}\` |`)).length;
    assert.equal(n, 1, `${k} documented ${n} times`);
  }
});

test('CONFIG.md defaults match DEFAULT_CONFIG for scalar keys', () => {
  const rows = knobRows();
  for (const k of DEFAULT_LEAVES) {
    const v = getPath(DEFAULT_CONFIG, k);
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) continue;
    const cell = rows.get(k)!;
    // regex defaults (cues, test commands) are described rather than quoted; the label pattern is quoted
    if (typeof v === 'string' && v.length > 60) {
      assert.ok(cell.length > 0, k);
      continue;
    }
    const shown = /^`([^`]*)`/.exec(cell)?.[1];
    assert.ok(shown !== undefined, `${k}: default cell ${cell} has no code value`);
    const expect = typeof v === 'string' ? v : String(v);
    assert.ok(shown === expect || (typeof v === 'number' && Number(shown) === v), `${k}: CONFIG.md says ${shown}, DEFAULT_CONFIG has ${expect}`);
  }
});

test('CONFIG.md lists every environment variable the loader reads', () => {
  for (const [name, path] of ENV_MAP) assert.ok(md.includes(`| \`${name}\` | \`${path}\` |`), name);
  for (const name of LOADER_ENV) assert.ok(md.includes(`\`${name}\``), name);
});

test('CONFIG.md preset table equals computeBudget on the presets', () => {
  const fmt = (n: number): string => n.toLocaleString('en-US');
  for (const p of ['32k', '64k', '100k', '128k']) {
    const cfg = loadConfig({ preset: p, env: {} }).config;
    const b = computeBudget(cfg);
    const row = md.split('\n').find((l) => l.startsWith(`| \`${p}\``));
    assert.ok(row, p);
    const cells = row!.split('|').map((c) => c.trim());
    assert.deepEqual(cells.slice(2, 10), [fmt(b.window), fmt(b.planMaxTokens), fmt(b.margin), fmt(b.budget), fmt(b.clientPoint), fmt(b.allowance), fmt(b.trigger), fmt(b.target)], p);
  }
});
