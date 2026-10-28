import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as cli from '../../src/cli.js';
import * as io from '../../src/cli/io.js';
import * as args from '../../src/cli/args.js';
import { ROOT } from '../helpers.js';

const entry = join(ROOT, 'dist', 'src', 'cli.js');
const run = (...argv: string[]) => spawnSync(process.execPath, [entry, ...argv], { encoding: 'utf8' });

test('compiled entry: version and help exit 0', () => {
  const v = run('version');
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^kitzur \S+ \(node /);
  const h = run('help');
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /^usage: kitzur <command>/);
});

test('compiled entry: no arguments prints usage on stderr and exits 2', () => {
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^usage: kitzur <command>/);
});

test('compiled entry: an unknown command exits 2', () => {
  const r = run('frobnicate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command 'frobnicate'/);
});

test('src/cli.js re-exports the bindings of src/cli/io.js and src/cli/args.js', () => {
  assert.equal(cli.defaultIO, io.defaultIO);
  assert.equal(cli.UsageError, io.UsageError);
  assert.equal(cli.parseArgs, args.parseArgs);
  assert.equal(cli.CONFIG_OPTS, args.CONFIG_OPTS);
  assert.equal(cli.setOpsOf, args.setOpsOf);
});
