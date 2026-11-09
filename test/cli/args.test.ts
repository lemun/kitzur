import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, type OptSpec } from '../../src/cli/args.js';
import { UsageError } from '../../src/cli/io.js';

const spec: OptSpec = {
  config: { type: 'string', short: 'c' },
  preset: { type: 'string', short: 'p' },
  set: { type: 'string', multiple: true, short: 's' },
  port: { type: 'string' },
  json: { type: 'boolean' },
};

const usage = (re: RegExp) => (e: unknown) => e instanceof UsageError && re.test(e.message);

test('parseArgs: --name value, --name=value and an empty inline value', () => {
  assert.deepEqual(parseArgs(['--preset', '64k'], spec).values, { preset: '64k' });
  assert.deepEqual(parseArgs(['--preset=64k'], spec).values, { preset: '64k' });
  assert.deepEqual(parseArgs(['--preset='], spec).values, { preset: '' });
});

test('parseArgs: -s repeats into a list and ordered keeps argv order', () => {
  const p = parseArgs(['-s', 'a=1', '--port', '9', '--set', 'b=2'], spec);
  assert.deepEqual(p.values['set'], ['a=1', 'b=2']);
  assert.deepEqual(p.ordered, [{ name: 'set', value: 'a=1' }, { name: 'port', value: '9' }, { name: 'set', value: 'b=2' }]);
});

test('parseArgs: a boolean given a value and a value-taking option at the end are rejected', () => {
  assert.deepEqual(parseArgs(['--json'], spec).values, { json: true });
  assert.throws(() => parseArgs(['--json=1'], spec), usage(/--json takes no value/));
  assert.throws(() => parseArgs(['--preset'], spec), usage(/--preset needs a value/));
});

test('parseArgs: -- ends option parsing and - alone is a positional', () => {
  const p = parseArgs(['-', '--', '--json', '-weird.json', '-p=64k'], spec);
  assert.deepEqual(p.positionals, ['-', '--json', '-weird.json', '-p=64k']);
  assert.deepEqual(p.values, {});
});

test('parseArgs: a value that looks like a flag is consumed as the value', () => {
  // intended: keeps paths that begin with a dash usable as option values
  assert.deepEqual(parseArgs(['--config', '--port'], spec).values, { config: '--port' });
  assert.deepEqual(parseArgs(['-c', '-weird.json'], spec).values, { config: '-weird.json' });
});

test('parseArgs: an unknown one-letter option is rejected', () => {
  assert.throws(() => parseArgs(['-x'], spec), usage(/^unknown option -x;/));
});

test('parseArgs: a single-dash token longer than one letter is rejected, not taken as a positional', () => {
  for (const a of ['-p=64k', '-abc', '-c=foo', '-1.5']) {
    assert.throws(() => parseArgs([a], spec), usage(new RegExp(`^unknown option ${a.replace('.', '\\.')}; short options are one letter followed by a separate value \\(-p 64k\\) and long options use two dashes \\(--preset 64k\\)$`)), a);
  }
});
