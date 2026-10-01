import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, SseRelay, eventError, type SseEvent } from '../../src/proxy/sse.js';

const B = (s: string): Buffer => Buffer.from(s, 'utf8');

function parseAll(chunks: Buffer[]): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  const last = p.end();
  if (last) out.push(last);
  return out;
}

test('fields, comments, multi-line data, event: and error: fields', () => {
  const evs = parseAll([B(': keep-alive\n\nevent: sglext_ids\ndata: {"a":1}\ndata: {"b":2}\n\nerror: {"code":400}\n\n:\n\ndata:no-space\n\n')]);
  assert.equal(evs.length, 5);
  assert.equal(evs[0]!.comment, true);
  assert.deepEqual([evs[1]!.event, evs[1]!.data, evs[1]!.comment], ['sglext_ids', '{"a":1}\n{"b":2}', false]);
  assert.deepEqual([evs[2]!.error, evs[2]!.data, evs[2]!.comment], ['{"code":400}', null, false]);
  assert.equal(evs[3]!.comment, true);
  assert.equal(evs[4]!.data, 'no-space');
  assert.ok(evs.every((e) => e.terminated));
});

test('CRLF, CR and LF line ends, including a CRLF split across chunks', () => {
  const evs = parseAll([B('data: a\r\n\r'), B('\ndata: b\r\rdata: c\n\n'), B('data: d\r\n')]);
  assert.deepEqual(evs.map((e) => e.data), ['a', 'b', 'c', 'd']);
  assert.deepEqual(evs.map((e) => e.terminated), [true, true, true, false]);
  assert.equal(Buffer.concat(evs.map((e) => e.raw)).toString(), 'data: a\r\n\r\ndata: b\r\rdata: c\n\ndata: d\r\n');
  // a CR as the very last byte of the stream terminates the line
  const e2 = parseAll([B('data: x\r'), B('\r')]);
  assert.deepEqual([e2.length, e2[0]!.data, e2[0]!.terminated], [1, 'x', true]);
});

/** A small deterministic PRNG for the property tests. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: any chunking gives the same events, and the raw bytes concatenate to the input', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const eols = ['\n', '\r\n', '\r'];
    let text = '';
    const nEv = 1 + Math.floor(r() * 8);
    for (let i = 0; i < nEv; i++) {
      const eol = eols[Math.floor(r() * 3)]!;
      const kind = Math.floor(r() * 4);
      if (kind === 0) text += `: ping ${i}${eol}${eol}`;
      else if (kind === 1) text += `data: {"i":${i},"s":"héllo ✓ ${'x'.repeat(Math.floor(r() * 40))}"}${eol}${eol}`;
      else if (kind === 2) text += `event: e${i}${eol}data: line1${eol}data: line2${eol}${eol}`;
      else text += `data: [DONE]${eol}${eol}`;
    }
    if (r() < 0.3) text += 'data: trailing'; // unterminated
    const bytes = B(text);
    const whole = parseAll([bytes]);
    // random split points, including inside multi-byte characters and between CR and LF
    const chunks: Buffer[] = [];
    let i = 0;
    while (i < bytes.length) {
      const n = 1 + Math.floor(r() * 9);
      chunks.push(bytes.subarray(i, i + n));
      i += n;
    }
    const split = parseAll(chunks);
    const strip = (e: SseEvent) => ({ data: e.data, event: e.event, error: e.error, comment: e.comment, terminated: e.terminated, raw: e.raw.toString('hex') });
    assert.deepEqual(split.map(strip), whole.map(strip), `seed ${seed}`);
    assert.ok(Buffer.concat(whole.map((e) => e.raw)).equals(bytes), `seed ${seed}: raw bytes`);
  }
});

test('eventError: top-level error key in data, or any error: field', () => {
  const [a, b, c, d, e] = parseAll([B('data: {"error":{"message":"x","code":400}}\n\ndata: {"choices":[{"delta":{"content":"error"}}]}\n\nerror: not json\n\ndata: [DONE]\n\ndata: {"error":null}\n\n')]);
  assert.ok(eventError(a!));
  assert.equal(eventError(b!), null, 'the word "error" in content is not an error event');
  assert.equal(eventError(c!)?.payload, 'not json');
  assert.equal(eventError(d!), null);
  assert.equal(eventError(e!), null);
});

test('relay: comments are held until the first data event, then flushed before it', () => {
  const r = new SseRelay({ hold: true, strip: false, committed: false });
  let s = r.onChunk(B(': ping\n\n'));
  assert.deepEqual([s.commit, s.writes.length], [false, 0]);
  s = r.onChunk(B(':\n\ndata: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
  assert.equal(s.commit, true);
  assert.equal(Buffer.concat(s.writes).toString(), ': ping\n\n:\n\ndata: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
  s = r.onChunk(B('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  assert.equal(s.commit, false);
  assert.equal(s.writes.length, 2);
  assert.equal(r.onEnd().writes.length, 0);
  assert.deepEqual([r.complete, r.finishReason, r.done], [true, 'stop', true]);
});

test('relay: hold timeout commits and flushes held comments; a later first-event error is still caught', () => {
  const r = new SseRelay({ hold: true, strip: false, committed: false });
  r.onChunk(B(': ping\n\n'));
  const t = r.onHoldTimeout();
  assert.deepEqual([t.commit, Buffer.concat(t.writes).toString()], [true, ': ping\n\n']);
  const s = r.onChunk(B('data: {"error":{"message":"The input (9 tokens) is longer than the model\'s context length (8 tokens).","code":400}}\n\ndata: [DONE]\n\n'));
  assert.ok(s.error);
  assert.equal(s.writes.length, 0);
  assert.equal(r.tail().toString(), 'data: [DONE]\n\n');
});

test('relay: a first-event error is never written; later chunks go to the tail in order', () => {
  const r = new SseRelay({ hold: true, strip: false, committed: false });
  r.onChunk(B(': c\n\n'));
  const s = r.onChunk(B('error: {"code":400,"message":"the request exceeds the available context size"}\n\ndata: [DO'));
  assert.ok(s.error);
  assert.equal(s.commit, false);
  assert.equal(s.writes.length, 0);
  r.onChunk(B('NE]\n\n'));
  assert.equal(r.tail().toString(), 'data: [DONE]\n\n');
  assert.equal(r.heldBytes().toString(), ': c\n\n');
});

test('relay: without hold, comments are written at once; a mid-stream error is relayed', () => {
  const r = new SseRelay({ hold: false, strip: false, committed: false });
  const s = r.onChunk(B(': ping\n\n'));
  assert.deepEqual([s.commit, s.writes.length], [true, 1]);
  r.onChunk(B('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
  const e = r.onChunk(B('data: {"error":{"message":"boom"}}\n\n'));
  assert.equal(e.error, undefined, 'only the first data event is checked');
  assert.equal(e.writes.length, 1);
  assert.equal(r.complete, false);
});

test('relay: strip removes only the choices:[] usage chunk; the tap sees the last usage of any event', () => {
  const stream = 'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}],"usage":{"prompt_tokens":1}}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
  for (const strip of [true, false]) {
    const r = new SseRelay({ hold: true, strip, committed: false });
    const s = r.onChunk(B(stream));
    const out = Buffer.concat(s.writes).toString();
    assert.equal(out.includes('"choices":[]'), !strip);
    assert.equal(r.stripped, strip ? 1 : 0);
    assert.equal(r.usage?.prompt_tokens, 1234);
    assert.equal(r.finishReason, 'tool_calls');
    if (!strip) assert.equal(out, stream, 'unstripped relay is byte-exact');
  }
});

test('relay: end of body without events commits; incomplete streams are detected', () => {
  const r = new SseRelay({ hold: true, strip: false, committed: false });
  r.onChunk(B(': only a comment\n\n'));
  const s = r.onEnd();
  assert.deepEqual([s.commit, Buffer.concat(s.writes).toString()], [true, ': only a comment\n\n']);
  assert.equal(r.complete, false);
  const r2 = new SseRelay({ hold: true, strip: false, committed: false });
  r2.onChunk(B('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n'));
  r2.onEnd();
  assert.equal(r2.complete, false, 'no [DONE] and no finish_reason: upstream_incomplete');
  const r3 = new SseRelay({ hold: false, strip: false, committed: true });
  const s3 = r3.onChunk(B('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n'));
  assert.equal(s3.commit, false, 'already committed (a retry on the same response)');
});
