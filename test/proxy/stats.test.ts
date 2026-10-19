import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsRecord } from '../../src/proxy/stats.js';
import { result } from './fake-engine.js';

test('stats persist typed retention outcome counts without request content', () => {
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'PRIVATE-REQUEST-CONTENT' }] };
  const engine = result(req, req, false);
  engine.stats.retention = { verbatim: 1, excerpted: 2, summarized: 3, dropped: 4 };
  const record = buildStatsRecord({
    seq: 1, ts: new Date('2026-01-01T00:00:00.000Z'), path: '/v1/chat/completions', first: engine, last: engine,
    action: 'passthrough', attempts: [], clientStatus: 200, tokensIn: 1, correction: 1, engineMs: 0, totalMs: 1,
    compacted: false, shadow: false, forwarded: 'engine', usage: null, usageMismatch: false, rewriteRejected: false,
  });
  assert.deepEqual(record.retention, { verbatim: 1, excerpted: 2, summarized: 3, dropped: 4 });
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-REQUEST-CONTENT/);
});
