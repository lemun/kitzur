#!/usr/bin/env node
// Runs every compiled *.test.js under dist/test (or the given dirs) with node:test.
// Passing explicit files works the same on Node 20, 22 and 26 (directory arguments are globs on 21+).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// A second, TAP reporter goes to a file so the run can end with a totals line; every reporter then needs a destination.
const reporters = flags.filter((a) => a.startsWith('--test-reporter='));
if (!reporters.length) reporters.push('--test-reporter=spec');
const dests = flags.some((a) => a.startsWith('--test-reporter-destination')) ? []
  : [...reporters.filter((a) => !flags.includes(a)), ...reporters.map(() => '--test-reporter-destination=stdout')];
const tap = join(mkdtempSync(join(tmpdir(), 'kitzur-tests-')), 'run.tap');
const own = ['--test-reporter=tap', `--test-reporter-destination=${tap}`];
const res = spawnSync(process.execPath, ['--test', ...flags, ...dests, ...own, ...files], { stdio: 'inherit' });
try {
  const summary = readFileSync(tap, 'utf8');
  const count = (k) => summary.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? '?';
  console.log(`\ntests: ${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped`);
} catch {}
rmSync(join(tap, '..'), { recursive: true, force: true });
process.exit(res.status ?? 1);
