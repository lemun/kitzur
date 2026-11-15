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
// Proxy fixtures tag their temp dirs with this run id; any left behind after the run fail it.
const run = `r${process.pid}x${Date.now().toString(36)}`;
const res = spawnSync(process.execPath, ['--test', ...flags, ...dests, ...own, ...files], { stdio: 'inherit', env: { ...process.env, KITZUR_TEST_RUN: run } });
const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith(`kitzur-proxy-test-${run}-`));
for (const n of leaked) rmSync(join(tmpdir(), n), { recursive: true, force: true });
if (leaked.length) console.error(`tests left ${leaked.length} kitzur-proxy-test-* dir(s) in ${tmpdir()} (removed): ${leaked.join(' ')}`);
try {
  const summary = readFileSync(tap, 'utf8');
  const count = (k) => summary.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? '?';
  console.log(`\ntests: ${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped`);
  // under the m flag the trailing $ ends the match at the failureType line; error, code and stack follow it in the record
  const failures = [...summary.matchAll(/^ *not ok \d+ - (.*)(?:\n +---(?:\n +\w+: .*)*?\n +failureType: '(\w+)')?$/gm)];
  const todoFailures = failures.filter(([, name]) => / # TODO(?:\s|$)/.test(name));
  for (const [, name] of todoFailures) console.error(`todo test failing: ${name.replace(/ # TODO.*$/, '')}`);
  const reportedFailures = Number(count('fail')) || 0;
  const unaccounted = failures.length - reportedFailures;
  if (todoFailures.length || unaccounted > 0) {
    // node counts a cancelled test (timeout, abort, parent finished first) under "# cancelled", not "# fail"
    for (const f of failures) {
      if (/^(?:cancelledByParent|testAborted|testTimeoutFailure)$/.test(f[2]) && !todoFailures.includes(f)) console.error(`test failure missing from TAP fail count: ${f[1]}`);
    }
    process.exitCode = 1;
  }
} catch {}
rmSync(join(tap, '..'), { recursive: true, force: true });
process.exit(leaked.length || process.exitCode ? 1 : res.status ?? 1);
