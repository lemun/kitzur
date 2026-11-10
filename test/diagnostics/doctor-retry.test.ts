import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/config/load.js';
import { doctor } from '../../src/diagnostics/doctor.js';

type Cfg = ReturnType<typeof defaultConfig>;

async function retryChecks(edit: (cfg: Cfg) => void) {
  const cfg = defaultConfig();
  cfg.listen.port = 0;
  edit(cfg);
  const report = await doctor(cfg);
  return report.checks.filter((c) => c.code === 'upstream.retry');
}

const longFirstWait = (jitter: boolean) => (cfg: Cfg) => {
  Object.assign(cfg.upstream.retry, { enabled: true, jitter, baseDelayMs: 5000, maxDelayMs: 8000, maxTotalDelayMs: 1000 });
};

test('doctor adds no upstream.retry check while retry is off', async () => {
  assert.deepEqual(await retryChecks(() => {}), []);
});

test('doctor warns when retry is on with maxAttempts 1', async () => {
  const checks = await retryChecks((cfg) => { cfg.upstream.retry.enabled = true; cfg.upstream.retry.maxAttempts = 1; });
  assert.deepEqual(checks, [{
    code: 'upstream.retry', status: 'warn',
    message: 'Upstream retry is on but maxAttempts is 1, so no request is ever retried.',
    fix: 'Set upstream.retry.maxAttempts to 2 or more, or turn upstream.retry.enabled off.',
  }]);
});

test('doctor warns when the first wait never fits and jitter is off', async () => {
  const [check] = await retryChecks(longFirstWait(false));
  assert.equal(check?.status, 'warn');
  assert.match(check?.message ?? '', /first wait \(5000 ms\) is longer than maxTotalDelayMs \(1000 ms\)/);
  assert.equal(check?.fix, 'Raise upstream.retry.maxTotalDelayMs or lower upstream.retry.baseDelayMs.');
});

test('doctor accepts the same settings with jitter on', async () => {
  const [check] = await retryChecks(longFirstWait(true));
  assert.equal(check?.status, 'ok');
});

test('doctor sums up the default retry settings once retry is on', async () => {
  const checks = await retryChecks((cfg) => { cfg.upstream.retry.enabled = true; });
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, 'ok');
  assert.equal(checks[0]?.message, 'Upstream retry is on: up to 3 attempts, each wait at most 8000 ms, at most 20000 ms of waiting in total.');
});
