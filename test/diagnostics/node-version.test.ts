import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { doctor } from '../../src/diagnostics/doctor.js';
import { ROOT } from '../helpers.js';

const nodeCheck = async (nodeVersion: string) => {
  const cfg = defaultConfig();
  cfg.listen.port = 0;
  return (await doctor(cfg, { nodeVersion, windows: { platform: 'linux' } })).checks.find((c) => c.code === 'runtime.node')!;
};

test('runtime.node warns below Node 22 and is ok on 22, 24 and 26', async () => {
  const old = await nodeCheck('20.18.0');
  assert.equal(old.status, 'warn');
  assert.match(old.message, /supports Node\.js 22 or later/);
  assert.match(old.fix!, /Install Node\.js 22 or later.*offline bundle.*README/);
  for (const v of ['22.0.0', '24.1.0', '26.0.0']) assert.equal((await nodeCheck(v)).status, 'ok', v);
});

test('README compatibility table minimum Node matches package.json engines.node', () => {
  const { engines } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const minimum = /^>=(\d+)$/.exec(engines.node)?.[1];
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const row = /^\| Node\.js \| ([\d, ]+) \|/m.exec(readme)?.[1];
  assert.ok(row, 'README must have a Node.js row in the compatibility table');
  assert.equal(row.split(',')[0]!.trim(), minimum, `README table minimum Node must match ${engines.node}`);
});
