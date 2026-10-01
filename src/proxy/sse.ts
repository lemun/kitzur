// Server-sent events for the relay (DESIGN.md, ; reference implementation).
//
// SseParser splits a byte stream into events without decoding anything it does not need: each event
// keeps its exact bytes (`raw`, terminating blank line included), so relaying the raw events of a
// stream in order reproduces the upstream bytes exactly. Line ends are CRLF, LF or CR (a CR at the end
// of a chunk waits for the next byte). Fields: `data` (joined with \n), `event`, and the non-standard
// `error` field llama.cpp ≤ b6400 used for in-stream errors; comment lines (`:` keep-alives) are
// recognised and passed through untouched.
//
// SseRelay is the per-attempt state machine the server drives with upstream chunks:
//   - first-event hold (): until the first `data:`/`error:` event, comments are held (not written)
//     while the hold is on; the caller commits the client's status line when the first event arrives,
//     at the upstream end of body, when the hold timer fires, or once HOLD_MAX bytes of comments are
//     held, and then flushes the held comments;
//   - the first data event is checked for an in-stream error (a top-level `error` key, or an `error:`
//     field); an error is never written, so the ladder can still recover (§9);
//   - usage tap: the last non-null `usage` of any event, the last finish_reason, and `[DONE]`;
//   - strip: when kitzur injected include_usage, the `choices: []` usage chunk is not relayed (§9).
import { inspectChunk } from '../dialect/openai-chat.js';
import type { Usage } from '../types.js';

export interface SseEvent {
  /** the event's bytes, including its terminating blank line (unterminated at end of stream) */
  raw: Buffer;
  /** data lines joined with "\n"; null without a data field */
  data: string | null;
  event: string | null;
  /** value of an `error:` field (llama.cpp ≤ b6400 in-stream errors) */
  error: string | null;
  /** no data and no error field: comments, keep-alives, empty events */
  comment: boolean;
  terminated: boolean;
}

const LF = 0x0a;
const CR = 0x0d;

export class SseParser {
  // Linear in the stream length whatever the line and event sizes: `buf` holds only the current
  // (incomplete) line; the completed lines of the current event are kept as slices in `evParts` and
  // joined once, at dispatch; chunks with no line end at all wait in `lineParts` without being copied.
  // (Re-concatenating the pending event on every chunk made a 25 MB SSE line take seconds.)
  private buf: Buffer = Buffer.alloc(0);
  private scan = 0;
  private evParts: Buffer[] = [];
  private lineParts: Buffer[] = [];
  private data: string[] = [];
  private errorLines: string[] = [];
  private event: string | null = null;

  /** Feeds bytes; returns the events completed by them, in order. */
  push(chunk: Buffer): SseEvent[] {
    if (chunk.length === 0) return [];
    // mid-line (no CR waiting at the end of buf) and no line end in the chunk: nothing can complete
    if (this.scan === this.buf.length && chunk.indexOf(LF) < 0 && chunk.indexOf(CR) < 0) {
      this.lineParts.push(chunk);
      return [];
    }
    this.joinLine(chunk);
    const out: SseEvent[] = [];
    this.run(out, false);
    return out;
  }

  /** End of stream: the unterminated trailing event, if any bytes remain. */
  end(): SseEvent | null {
    this.joinLine(null);
    const out: SseEvent[] = [];
    this.run(out, true);
    let ev: SseEvent | null = out[0] ?? null; // a CR-terminated blank line completed at end
    if (this.buf.length) {
      this.addLine(this.buf.toString('utf8'));
      this.evParts.push(this.buf);
    }
    if (this.evParts.length) ev = this.dispatch(Buffer.concat(this.evParts), false);
    this.buf = Buffer.alloc(0);
    this.scan = 0;
    this.evParts = [];
    return ev;
  }

  /** Bytes received but not yet part of a completed event. */
  pending(): Buffer {
    return Buffer.concat([...this.evParts, this.buf, ...this.lineParts]);
  }

  /** buf := buf + deferred chunks (+ chunk); the deferred chunks hold no line end, so scanning resumes after them. */
  private joinLine(chunk: Buffer | null): void {
    if (!this.lineParts.length && !chunk) return;
    // deferred chunks exist only when buf was fully scanned (no CR waiting at its end)
    const deferred = this.lineParts.length > 0;
    const parts = [this.buf, ...this.lineParts];
    const scanned = parts.reduce((n, b) => n + b.length, 0);
    if (chunk) parts.push(chunk);
    this.buf = parts.length === 2 && parts[0]!.length === 0 ? parts[1]! : Buffer.concat(parts);
    this.lineParts = [];
    if (deferred) this.scan = scanned;
  }

  private run(out: SseEvent[], atEnd: boolean): void {
    const buf = this.buf;
    let lineStart = 0;
    let i = this.scan;
    while (i < buf.length) {
      const b = buf[i]!;
      if (b !== LF && b !== CR) {
        i++;
        continue;
      }
      let term = 1;
      if (b === CR) {
        if (i + 1 >= buf.length && !atEnd) break; // CRLF split across chunks: decide with the next byte
        if (buf[i + 1] === LF) term = 2;
      }
      const next = i + term;
      if (lineStart === i) {
        const blank = buf.subarray(lineStart, next);
        out.push(this.dispatch(this.evParts.length ? Buffer.concat([...this.evParts, blank]) : blank, true));
        this.evParts = [];
      } else {
        this.addLine(buf.toString('utf8', lineStart, i));
        this.evParts.push(buf.subarray(lineStart, next));
      }
      lineStart = next;
      i = next;
    }
    this.buf = lineStart ? buf.subarray(lineStart) : buf;
    this.scan = i - lineStart;
  }

  private addLine(line: string): void {
    if (line.startsWith(':')) return; // comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'error') this.errorLines.push(value);
    else if (field === 'event') this.event = value;
  }

  private dispatch(raw: Buffer, terminated: boolean): SseEvent {
    const ev: SseEvent = {
      raw,
      data: this.data.length ? this.data.join('\n') : null,
      event: this.event,
      error: this.errorLines.length ? this.errorLines.join('\n') : null,
      comment: this.data.length === 0 && this.errorLines.length === 0,
      terminated,
    };
    this.data = [];
    this.errorLines = [];
    this.event = null;
    return ev;
  }
}

/** An in-stream error found in the first event. */
export interface StreamError {
  event: SseEvent;
  /** the payload the classifier sees: the data JSON, or the `error:` field value */
  payload: string;
  /** parsed payload (undefined when not JSON) */
  json: unknown;
}

/** Parses an event payload; an in-stream error is a JSON object with a top-level `error` key, or any `error:` field. */
export function eventError(ev: SseEvent): StreamError | null {
  if (ev.error !== null) {
    let json: unknown;
    try {
      json = JSON.parse(ev.error);
    } catch {
      json = undefined;
    }
    return { event: ev, payload: ev.error, json };
  }
  if (ev.data === null || ev.data === '[DONE]') return null;
  if (!ev.data.includes('"error"')) return null;
  try {
    const json = JSON.parse(ev.data) as unknown;
    if (inspectChunk(json).error) return { event: ev, payload: ev.data, json };
  } catch {
    /* not JSON: relayed as is */
  }
  return null;
}

export interface RelayStep {
  /** bytes to write to the client, in order (after committing, when commit is set) */
  writes: Buffer[];
  /** commit the client's status line and headers before writing */
  commit: boolean;
  /** the first event is an error: nothing of it was written */
  error?: StreamError;
}

export interface SseRelayOptions {
  /** hold comments until the first event (stream.holdFirstEvent), only before the client is committed */
  hold: boolean;
  /** strip the `choices: []` usage chunk (kitzur injected include_usage) */
  strip: boolean;
  /** the client's status line is already sent (a retry after an in-stream error) */
  committed: boolean;
  /** check the first data event for an in-stream error (errors.inStream; default true) */
  detectErrors?: boolean;
}

/** Bytes of comments held during the first-event hold before it ends early. */
export const HOLD_MAX = 1 << 20;

/** Bytes of stream tail kept after a first-event error before the caller parks the upstream. */
export const TAIL_MAX = 1 << 20;

export class SseRelay {
  private readonly parser = new SseParser();
  private phase: 'first' | 'relay' | 'errored' = 'first';
  private held: Buffer[] = [];
  private heldSize = 0;
  private committed: boolean;
  private tailBytes: Buffer[] = [];
  private tailSize = 0;
  usage: Usage | null = null;
  finishReason: string | null = null;
  done = false;
  /** events relayed (data or error events; comments excluded) */
  events = 0;
  stripped = 0;

  constructor(private readonly o: SseRelayOptions) {
    this.committed = o.committed;
  }

  /** The stream ended with [DONE] or a finish_reason (: otherwise upstream_incomplete). */
  get complete(): boolean {
    return this.done || this.finishReason !== null;
  }

  get isCommitted(): boolean {
    return this.committed;
  }

  /** Bytes after an in-stream error event (kept to relay the error unchanged). Nothing is dropped: the caller stops reading once tailFull. */
  tail(): Buffer {
    return Buffer.concat(this.tailBytes);
  }

  /** The kept tail passed TAIL_MAX bytes: the caller parks the upstream stream (no more onChunk). */
  get tailFull(): boolean {
    return this.tailSize > TAIL_MAX;
  }

  onChunk(chunk: Buffer): RelayStep {
    if (this.phase === 'errored') {
      this.keepTail(chunk);
      return { writes: [], commit: false };
    }
    return this.process(this.parser.push(chunk), false);
  }

  onEnd(): RelayStep {
    if (this.phase === 'errored') return { writes: [], commit: false };
    const last = this.parser.end();
    return this.process(last ? [last] : [], true);
  }

  /** The hold timer fired: commit and flush the held comments; error detection still applies. */
  onHoldTimeout(): RelayStep {
    if (this.committed || this.phase !== 'first') return { writes: [], commit: false };
    this.committed = true;
    const writes = this.held;
    this.held = [];
    this.heldSize = 0;
    return { writes, commit: true };
  }

  private keepTail(b: Buffer): void {
    this.tailBytes.push(b);
    this.tailSize += b.length;
  }

  private process(events: SseEvent[], atEnd: boolean): RelayStep {
    const step: RelayStep = { writes: [], commit: false };
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (this.phase === 'first') {
        if (ev.comment) {
          if (this.o.hold && !this.committed && this.heldSize + ev.raw.length <= HOLD_MAX) {
            this.held.push(ev.raw);
            this.heldSize += ev.raw.length;
          } else {
            // past HOLD_MAX the hold ends as if its timer fired (a server streaming comments only
            // would otherwise grow this buffer without bound for firstEventTimeoutMs)
            this.commitInto(step);
            step.writes.push(ev.raw);
          }
          continue;
        }
        const err = this.o.detectErrors === false ? null : eventError(ev);
        if (err) {
          this.phase = 'errored';
          for (let j = i + 1; j < events.length; j++) this.keepTail(events[j]!.raw);
          const rest = this.parser.pending();
          if (rest.length) this.keepTail(Buffer.from(rest));
          step.error = err;
          return step;
        }
        this.commitInto(step);
        this.phase = 'relay';
      }
      this.tap(ev, step);
    }
    if (atEnd && this.phase === 'first') this.commitInto(step);
    return step;
  }

  /** Commits (once) and flushes held comments into this step. */
  private commitInto(step: RelayStep): void {
    if (!this.committed) {
      this.committed = true;
      step.commit = true;
    }
    if (this.held.length) {
      step.writes.push(...this.held);
      this.held = [];
      this.heldSize = 0;
    }
  }

  /** Held comments not yet written (relayed with an error event when the error goes back unchanged). */
  heldBytes(): Buffer {
    return Buffer.concat(this.held);
  }

  private tap(ev: SseEvent, step: RelayStep): void {
    if (ev.comment) {
      step.writes.push(ev.raw);
      return;
    }
    this.events++;
    let strip = false;
    if (ev.data === '[DONE]') this.done = true;
    else if (ev.data !== null) {
      try {
        const info = inspectChunk(JSON.parse(ev.data) as unknown);
        if (info.usage) this.usage = info.usage;
        if (info.finishReason) this.finishReason = info.finishReason;
        strip = this.o.strip && info.usageOnly;
      } catch {
        /* not JSON: relayed untouched */
      }
    }
    if (strip) this.stripped++;
    else step.writes.push(ev.raw);
  }
}
