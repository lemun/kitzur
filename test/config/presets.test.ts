import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { computeBudget } from '../../src/config/derived.js';
import { parseJsonc } from '../../src/config/jsonc.js';
import { ROOT } from '../helpers.js';

const dir = join(ROOT, 'presets');
/** Every preset file shipped, discovered from the directory rather than a fixed list. */
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const num = (s: string): number => Number(s.replace(/,/g, ''));

/** CONFIG.md's preset table rows: name → [window, defaultMaxTokens]. */
function tableRows(): Map<string, [number, number]> {
  const rows = new Map<string, [number, number]>();
  for (const line of readFileSync(join(ROOT, 'CONFIG.md'), 'utf8').split('\n')) {
    const m = /^\| `([^`]+)`[^|]* \| ([\d,]+) \| ([\d,]+) \|/.exec(line);
    if (m) rows.set(m[1]!, [num(m[2]!), num(m[3]!)]);
  }
  return rows;
}

test('presets/: there are preset files to check', () => {
  assert.ok(files.length >= 4, files.join(', '));
});

for (const f of files) {
  const name = f.slice(0, -5);
  test(`preset ${name}: loads, validates and derives a trigger in (W/2, W)`, () => {
    const l = loadConfig({ preset: name, env: {}, sets: ['upstream.origin=http://127.0.0.1:8000', 'tokenizer.path=null'], presetsDir: dir });
    assert.equal(l.preset, name);
    assert.equal(l.config.tokenizer.path, null);
    assert.deepEqual(validateConfig(l.config, { provenance: l.provenance }).errors, []);
    const W = l.config.budget.window as number;
    const b = computeBudget(l.config);
    assert.ok(b.trigger < W && b.trigger > W / 2, `trigger ${b.trigger} for window ${W}`);
  });

  test(`preset ${name}: the file name matches the declared window`, () => {
    const raw = parseJsonc(readFileSync(join(dir, f), 'utf8')) as { budget: { window: number } };
    assert.match(name, /^\d+k$/);
    assert.equal(raw.budget.window, parseInt(name, 10) * 1000);
  });

  test(`preset ${name}: the CONFIG.md preset table lists it with its window and T_plan`, () => {
    const row = tableRows().get(name);
    assert.ok(row, `${name} missing from the CONFIG.md preset table`);
    const c = loadConfig({ preset: name, env: {}, presetsDir: dir }).config;
    assert.deepEqual(row, [c.budget.window, c.budget.defaultMaxTokens]);
  });
}
