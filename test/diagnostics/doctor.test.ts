import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { doctor, renderDoctor } from '../../src/diagnostics/doctor.js';

test('doctor reports missing and invalid tokenizer with sanitized messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-doctor-'));
  try {
    const cfg = defaultConfig();
    cfg.tokenizer.path = join(dir, 'TOKEN_SECRET_PATH.json');
    const missing = await doctor(cfg);
    assert.equal(missing.exitCode, 0, 'missing tokenizer falls back to estimator');
    assert.ok(missing.checks.some((c) => c.code === 'tokenizer.path' && c.status === 'warn'));
    assert.doesNotMatch(renderDoctor(missing), /TOKEN_SECRET_PATH/);
    writeFileSync(cfg.tokenizer.path, '{"not":"a tokenizer"}');
    const invalid = await doctor(cfg);
    assert.ok(invalid.checks.some((c) => c.code === 'tokenizer.load' && c.status === 'error'));
    assert.doesNotMatch(renderDoctor(invalid), /not a tokenizer|TOKEN_SECRET_PATH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor flags unusable budget and an unreachable explicit upstream probe', async () => {
  const cfg = defaultConfig();
  cfg.budget.window = 100;
  cfg.budget.defaultMaxTokens = 90;
  cfg.budget.safetyMarginTokens = 50;
  cfg.upstream.origin = 'http://127.0.0.1:1';
  cfg.upstream.headers = { Authorization: 'Bearer TOKEN_SECRET_VALUE' };
  cfg.upstream.timeoutMs = 100;
  const result = await doctor(cfg, { upstreamCheck: true, timeoutMs: 150 });
  assert.equal(result.exitCode, 1);
  assert.ok(result.checks.some((c) => c.code === 'budget.compatible' && c.status === 'error'));
  assert.ok(result.checks.some((c) => c.code === 'upstream.reachable' && c.status === 'error'));
  assert.doesNotMatch(JSON.stringify(result), /ECONN|127\.0\.0\.1|TOKEN_SECRET_VALUE/);
});

test('doctor recognizes reachable auth and missing-route responses and bounds a stalled probe', async () => {
  const server = createServer((req, res) => {
    if (req.headers['x-diagnostic-route'] === '/auth') { res.writeHead(401); res.end(); }
    else if (req.headers['x-diagnostic-route'] === '/missing') { res.writeHead(404); res.end(); }
    // /stall deliberately leaves the response open until doctor times out.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const [path, expectedStatus] of [['/auth', 'warn'], ['/missing', 'warn'], ['/stall', 'error']] as const) {
      const cfg = defaultConfig(); cfg.upstream.origin = origin; cfg.upstream.timeoutMs = 80;
      // Upstream's GET probe path is fixed; route by request header for independent status cases.
      cfg.upstream.headers = { 'x-diagnostic-route': path };
      const result = await doctor(cfg, { upstreamCheck: true, timeoutMs: 80 });
      const check = result.checks.find((c) => c.code === 'upstream.reachable');
      assert.equal(check?.status, expectedStatus, path);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('doctor detects a regular file blocking a state directory without modifying paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-doctor-path-'));
  try {
    const blocker = join(dir, 'regular-file'); writeFileSync(blocker, 'sentinel');
    const cfg = defaultConfig(); cfg.stateDir = join(blocker, 'state');
    cfg.stats.path = join(blocker, 'stats.jsonl');
    const before = (await import('node:fs')).readFileSync(blocker, 'utf8');
    const result = await doctor(cfg);
    assert.ok(result.checks.some((c) => c.code === 'state.directory' && c.status === 'error'));
    assert.ok(result.checks.some((c) => c.code === 'stats.path' && c.status === 'error'));
    assert.equal((await import('node:fs')).readFileSync(blocker, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
