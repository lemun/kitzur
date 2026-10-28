import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config/schema.js';
import type { AttemptOutcome, ErrorOutcome, OutgoingAttempt } from './recovery.js';
import { SseRelay, type RelayStep } from './sse.js';
import type { UpstreamResponse } from './upstream.js';

/** State retained when an SSE error parks its upstream stream for a possible unchanged relay. */
export interface Rest {
  body: IncomingMessage;
  /** bytes that arrived after the park (a stray resume) */
  parked: Buffer[];
  ended: boolean;
  closed: boolean;
  /** the error outcome this rest belongs to */
  outcome: ErrorOutcome | null;
}

interface RelayObservation {
  o: { relay: SseRelay | null; ended: boolean; outcome: 'ok' | 'aborted' | 'incomplete' | 'upstream_error' | 'refused' };
  inspect(): void;
  end(): void;
  fields(): string;
}

/** Explicit server state and effects needed by the SSE transport relay. */
export interface SseRelayContext {
  attempt: OutgoingAttempt;
  upstream: UpstreamResponse;
  startedAt: number;
  requestConfig: Config;
  response: ServerResponse;
  observation: RelayObservation;
  isCommitted(): boolean;
  isClientGone(): boolean;
  setFirstUpByte(time: number): void;
  commit(status: number, message: string, headers: string[]): void;
  write(buffers: Buffer[], source: IncomingMessage): void;
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void;
  setRest(rest: Rest): void;
}

export function relaySse(ctx: SseRelayContext): Promise<AttemptOutcome> {
  const { attempt: a, upstream: up, startedAt: t0, requestConfig, response: res, observation, commit, write, log } = ctx;
  return new Promise((resolve) => {
    const committed = ctx.isCommitted();
    const hold = requestConfig.stream.holdFirstEvent && !committed;
    const relay = new SseRelay({ hold, strip: a.injectedUsage, committed, detectErrors: requestConfig.errors.inStream });
    observation.o.relay = relay;
    const hdrs = forwardHeaders(up.rawHeaders);
    let finished = false;
    let erroredAt: RelayStep['error'] | null = null;
    let holdTimer: NodeJS.Timeout | null = null;
    const apply = (step: RelayStep): void => {
      if (step.commit) commit(up.status, up.statusMessage, hdrs);
      write(step.writes, up.body);
      observation.inspect();
    };
    const finish = (o: AttemptOutcome): void => {
      if (finished) return;
      finished = true;
      if (holdTimer) clearTimeout(holdTimer);
      resolve(o);
    };
    const errorOutcome = (): ErrorOutcome => {
      const err = erroredAt!;
      const held = relay.heldBytes();
      return {
        type: 'error', status: inStreamErrorStatus(err.json, up.status), httpStatus: up.status, statusMessage: up.statusMessage,
        headers: up.rawHeaders, body: Buffer.from(err.payload, 'utf8'), inStream: true, committed: ctx.isCommitted(),
        streamBytes: Buffer.concat([held, err.event.raw, relay.tail()]), upstreamMs: performance.now() - t0,
      };
    };
    if (hold) {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        apply(relay.onHoldTimeout());
      }, requestConfig.stream.firstEventTimeoutMs);
      holdTimer.unref();
    } else {
      commit(up.status, up.statusMessage, hdrs);
    }
    let cut: NodeJS.Timeout | null = null;
    const park = (): void => {
      if (cut) clearTimeout(cut);
      cut = null;
      up.body.off('data', onData);
      const p: Rest = { body: up.body, parked: [], ended: false, closed: false, outcome: null };
      up.body.on('data', (d: Buffer) => p.parked.push(d));
      up.body.once('end', () => (p.ended = true));
      up.body.once('close', () => (p.closed = true));
      up.body.pause();
      const o = errorOutcome();
      p.outcome = o;
      ctx.setRest(p);
      finish(o);
    };
    const onData = (d: Buffer): void => {
      ctx.setFirstUpByte(performance.now());
      const step = relay.onChunk(d);
      if (erroredAt) {
        if (relay.tailFull) park();
        return;
      }
      if (step.error) {
        erroredAt = step.error;
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        apply({ ...step, error: undefined });
        if (relay.tailFull) return park();
        cut = setTimeout(park, Math.min(requestConfig.upstream.idleTimeoutMs, 2000));
        cut.unref();
        up.body.once('close', () => { if (cut) clearTimeout(cut); });
        return;
      }
      apply(step);
    };
    up.body.on('data', onData);
    up.body.on('end', () => {
      if (erroredAt) { finish(errorOutcome()); return; }
      const last = relay.onEnd();
      if (last.error) { erroredAt = last.error; finish(errorOutcome()); return; }
      apply(last);
      observation.end();
      res.end();
      finish({ type: 'ok', status: up.status, tap: { usage: relay.usage, finishReason: relay.finishReason }, complete: relay.complete, upstreamMs: performance.now() - t0 });
    });
    up.body.on('close', () => {
      if (erroredAt) { finish(errorOutcome()); return; }
      if (finished) return;
      if (ctx.isClientGone()) finish({ type: 'aborted', upstreamMs: performance.now() - t0 });
      else {
        observation.o.ended = true;
        observation.o.outcome = 'upstream_error';
        if (!relay.complete) log('warn', `upstream stream closed without [DONE]/finish_reason ${observation.fields()}`);
        finish({ type: 'unavailable', committed: ctx.isCommitted(), error: 'upstream stream failed', upstreamMs: performance.now() - t0 });
      }
    });
    up.body.on('error', () => undefined);
  });
}

import { forwardResponseHeaders } from './upstream.js';
import { inStreamErrorStatus } from '../dialect/openai-chat.js';

function forwardHeaders(raw: string[]): string[] {
  return forwardResponseHeaders(raw, { dropContentLength: true });
}
