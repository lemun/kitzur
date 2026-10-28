import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientCompactionPoint } from '../../src/config/client-point.js';
import { loadConfig } from '../../src/config/load.js';

const config = (sets: string[] = []) => loadConfig({ env: {}, sets }).config;

test('clientCompactionPoint: configured point and derived defaults', () => {
  assert.equal(clientCompactionPoint(config(['client.compactionPointTokens=1234']), 9000, 3000), 1234);
  assert.equal(clientCompactionPoint(config(['client.outputLimit=2500', 'client.outputTokenMax=2000']), 9000, 3000), 7000);
  assert.equal(clientCompactionPoint(config(['client.inputLimit=8000', 'client.reservedTokens=1200']), 9000, 3000), 6800);
  assert.equal(clientCompactionPoint(config(['client.inputLimit=8000', 'client.outputLimit=3000', 'client.outputTokenMax=2500']), 9000, 4000), 5500);
  assert.equal(clientCompactionPoint(config(['client.inputLimit=1000', 'client.reservedTokens=2000']), 9000, 3000), 0);
  assert.equal(clientCompactionPoint(config(['client.outputLimit=null', 'client.outputTokenMax=2500']), 9000, 3000), 6500);
});
