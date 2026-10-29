import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, type SseEvent } from '../../src/proxy/sse.js';
import { mulberry32 } from '../config/rng.js';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

function parse(chunks: Buffer[]): SseEvent[] {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  const last = parser.end();
  if (last) events.push(last);
  return events;
}

function signature(events: SseEvent[]) {
  return events.map((event) => ({
    data: event.data,
    event: event.event,
    error: event.error,
    comment: event.comment,
    terminated: event.terminated,
    raw: event.raw.toString('hex'),
  }));
}

function chunksAt(input: Buffer, offsets: number[]): Buffer[] {
  const cuts = [0, ...offsets, input.length].sort((a, b) => a - b);
  return cuts.slice(1).map((end, index) => input.subarray(cuts[index]!, end));
}

test('SSE events and pass-through bytes are invariant under every byte split', () => {
  const streams = [
    ': ping\r\n\r\nevent: message\r\ndata: שלום 🌿\r\ndata: second line\r\n\r\n' +
      'data: first event\n\nerror: {"code":400}\r\n\r\ndata: [DONE]\n\n',
    ': ping\r\n\r\nevent: message\r\ndata: שלום 🌿\r\ndata: second line\r\n\r\n' +
      'data: first event\n\nerror: {"code":400}\r\n\r\ndata: [DONE]',
  ];

  for (const stream of streams) {
    const input = bytes(stream);
    const whole = parse([input]);
    const expected = signature(whole);
    assert.deepEqual(Buffer.concat(whole.map((event) => event.raw)), input);

    // Each two-way split, including positions inside the UTF-8 encoding of שלום.
    for (let offset = 1; offset < input.length; offset++) {
      const split = parse(chunksAt(input, [offset]));
      assert.deepEqual(signature(split), expected, `two-way split at byte ${offset}`);
      assert.deepEqual(Buffer.concat(split.map((event) => event.raw)), input, `pass-through at byte ${offset}`);
    }

    const random = mulberry32(0x5eed);
    for (let trial = 0; trial < 200; trial++) {
      const offsets: number[] = [];
      for (let offset = 1; offset < input.length; offset++) {
        if (random() < 0.08) offsets.push(offset);
      }
      const split = parse(chunksAt(input, offsets));
      assert.deepEqual(signature(split), expected, `random multi-way split ${trial}`);
      assert.deepEqual(Buffer.concat(split.map((event) => event.raw)), input, `random pass-through ${trial}`);
    }
  }
});
