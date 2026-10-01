#!/usr/bin/env node
// Runs every compiled *.test.js under dist/test (or the given dirs) with node:test.
// Passing explicit files works the same on Node 20, 22 and 26 (directory arguments are globs on 21+).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const files = [];
function walk(d) {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.js')) files.push(p);
  }
}
for (const r of roots.length ? roots : ['dist/test']) walk(r);
if (!files.length) { console.error('no test files found'); process.exit(1); }
const res = spawnSync(process.execPath, ['--test', ...flags, ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
