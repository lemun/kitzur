import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildStatsRecord, StatsWriter } from '../../src/proxy/stats.js';
import { result } from './fake-engine.js';

test('synthetic closed stats preserve the Gobstopper legacy contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-interop-'));
  try {
    const writer = new StatsWriter(join(dir, 'stats.jsonl'));
    const req = { model: 'synthetic', messages: [{ role: 'user' as const, content: 'synthetic' }] };
    for (const [i, action] of (['passthrough', 'compact', 'reuse', 'impossible'] as const).entries()) {
      const r = result(req, action === 'impossible' ? null : req, action === 'compact', {
        action, tokensIn: 100, tokensOut: action === 'passthrough' ? 100 : 40,
      });
      if (action === 'compact' || action === 'reuse') r.plan = {
        version: 2, engine: 'synthetic', n: 1, hEnd: 0, cut: 0, summary: null,
        headRewrites: {}, rewrites: {}, compactions: 1, fit: 'ok', key: 'synthetic',
      };
      writer.write(buildStatsRecord({ seq: i + 1, ts: new Date('2026-01-01T00:00:00Z'),
        path: '/v1/chat/completions', first: r, last: r, action, attempts: [],
        clientStatus: action === 'impossible' ? 400 : 200, tokensIn: 100, correction: 1,
        engineMs: 0, totalMs: 0, compacted: action === 'compact', shadow: false,
        forwarded: action === 'impossible' ? 'none' : 'engine', usage: null,
        usageMismatch: false, rewriteRejected: false,
      }));
    }
    await writer.close();
    const text = await readFile(join(dir, 'stats.jsonl'), 'utf8');
    assert.equal(text, await readFile('test/fixtures/stats/interop-legacy.jsonl', 'utf8'));
    for (const line of text.trim().split('\n')) {
      const row = JSON.parse(line);
      assert.ok(typeof row.ts === 'string' && Number.isFinite(Date.parse(row.ts)));
      assert.equal(typeof row.compacted, 'boolean');
      for (const key of ['est_tokens_in', 'est_tokens_out']) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
