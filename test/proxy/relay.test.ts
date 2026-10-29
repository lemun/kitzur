import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { Config } from '../../src/config/schema.js';
import { relaySse, type Rest } from '../../src/proxy/relay.js';

test('SSE relay transfers ownership of a parked stream across the module boundary', async () => {
  const body = Readable.from([Buffer.from(`data: {"error":{"message":"context length exceeded","code":400}}\n\ndata: ${'x'.repeat((1 << 20) + 1)}\n\n`)]);
  const up = { status: 400, statusMessage: 'Bad Request', rawHeaders: ['content-type', 'text/event-stream'], headers: { 'content-type': 'text/event-stream' }, body };
  let parked: Rest | undefined;
  let relay: unknown;
  let ended = false;
  const outcome = await relaySse({
    attempt: { injectedUsage: false } as never,
    upstream: up as never,
    startedAt: performance.now(),
    requestConfig: { stream: { holdFirstEvent: false, firstEventTimeoutMs: 10 }, errors: { inStream: true }, upstream: { idleTimeoutMs: 10 } } as Config,
    response: { end: () => { ended = true; } } as ServerResponse,
    observation: { o: { relay: null, ended: false, outcome: 'ok' }, inspect: () => undefined, end: () => undefined, fields: () => '' },
    isCommitted: () => false,
    isClientGone: () => false,
    setFirstUpByte: () => undefined,
    commit: () => undefined,
    write: () => undefined,
    log: () => undefined,
    setRest: (value) => { parked = value; },
  });
  relay = (outcome as { type: string }).type;
  assert.equal(relay, 'error');
  assert.ok(parked);
  assert.equal(parked.outcome, outcome);
  assert.equal(parked.body, body);
  assert.equal(ended, false);
});
