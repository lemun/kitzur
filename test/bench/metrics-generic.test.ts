import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basics, retryMetrics, rewrites, stepViews } from '../../bench/metrics/generic.js';
import type { ClientRec, RunRecords, UpstreamRec } from '../../bench/metrics/records.js';

let seq = 0;
function up(x: Partial<UpstreamRec> & { step: number; digests: string[] }): UpstreamRec {
  return {
    seq: ++seq, session: 's', kind: 'main', status: 200, rejected: false, prompt: x.digests.length * 10, completion: 5, maxTokens: 1000,
    bytes: x.digests.length * 100, lcp: 0, lcpGlobal: null, msgTokens: x.digests.map(() => 10), overhead: 0,
    facts: x.digests.map(() => []), pairingError: null, pairingStrict: [], ...x,
  };
}
function cl(x: Partial<ClientRec> & { step: number; digests: string[] }): ClientRec {
  return {
    session: 's', kind: 'main', attempt: 1, facts: x.digests.map(() => []), prompt: x.digests.length * 10, bytes: null, status: 200,
    clientErrorKind: null, usage: null, maxTokens: 1000, pairingStrict: [], ...x,
  };
}

/** Steps 0..4 of one session:
 *  0  C=[a,b]            A=[a,b]
 *  1  C=[a,b,c,d]        A=[a,b,c,d]
 *  2  C=+[e,f]           A=[a,S,e,f]                 proxy rewrite
 *  3  C=+[g,h]           A1=[a,S,e,f,g,h] rejected, A2=[a,S2,g,h] accepted  proxy rewrite (b2b with 2)
 *     summarizer request (client side)
 *  4  C=[x,y] (client rewrote its history)  A=[x,y]  client rewrite, not a proxy compaction */
function run(): RunRecords {
  seq = 0;
  const C = [['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['x', 'y']];
  const U: UpstreamRec[] = [
    up({ step: 0, digests: ['a', 'b'] }),
    up({ step: 1, digests: ['a', 'b', 'c', 'd'] }),
    up({ step: 2, digests: ['a', 'S', 'e', 'f'] }),
    up({ step: 3, digests: ['a', 'S', 'e', 'f', 'g', 'h'], status: 400, rejected: true, prompt: 900, bytes: 900 }),
    up({ step: 3, digests: ['a', 'S2', 'g', 'h'], prompt: 400, bytes: 400 }),
    up({ step: 4, kind: 'summarizer', digests: ['sys', 'u'], prompt: 50 }),
    up({ step: 4, digests: ['x', 'y'] }),
  ];
  // the client's own (uncompacted) request is larger than anything the proxy forwards
  return { up: U, client: C.map((d, i) => cl({ step: i, digests: d, prompt: 1000 + 100 * i })), steps: { s: 5 } };
}

test('rewrite detection: proxy rewrites vs client rewrites, b2b, compaction steps', () => {
  const rr = run();
  const v = stepViews(rr);
  assert.deepEqual(v.map((x) => [x.step, x.rewrite, x.clientRewrite, x.proxyRewrite]), [
    [0, 0, 0, 0], [1, 0, 0, 0], [2, 1, 0, 1], [3, 1, 0, 1], [4, 1, 1, 0],
  ]);
  assert.equal(v[3]!.A!.prompt, 400, 'A_k is the last attempt');
  assert.deepEqual(v[3]!.Pprev!.digests, ['a', 'S', 'e', 'f'], 'P_{k-1} is the last ACCEPTED main attempt before k');
  const w = rewrites(rr, v);
  assert.equal(w.compactions_generic, 2);
  assert.deepEqual(w.compaction_steps, [2, 3]);
  assert.equal(w.b2b, 1);
  assert.equal(w.client_rewrites, 1);
  assert.equal(w.client_compactions, 1, 'the summarizer burst and the client rewrite it caused count once');
  assert.equal(w.summarizer_requests, 1);
});

test('rejected attempts never become P; the next step compares with the last accepted one', () => {
  seq = 0;
  const rr: RunRecords = {
    up: [
      up({ step: 0, digests: ['a'] }),
      up({ step: 1, digests: ['a', 'b'], status: 400, rejected: true }),
      up({ step: 2, digests: ['a', 'b', 'c'] }),
    ],
    client: [cl({ step: 0, digests: ['a'] }), cl({ step: 1, digests: ['a', 'b'], status: 400, clientErrorKind: 'http_status' }), cl({ step: 2, digests: ['a', 'b', 'c'] })],
    steps: { s: 3 },
  };
  const v = stepViews(rr);
  assert.deepEqual(v[2]!.Pprev!.digests, ['a']);
  assert.equal(v[2]!.rewrite, 0);
});

test('basics: processed = every attempt (main accepted + rejected + summarizer/title), peak, steps_ok, pairing', () => {
  const rr = run();
  const b = basics(rr);
  const all = rr.up.reduce((a, r) => a + r.prompt, 0);
  assert.equal(b.processed, all);
  assert.equal(b.processed_main_rejected, 900);
  assert.equal(b.processed_aux, 50);
  assert.equal(b.processed_main_accepted + b.processed_main_rejected + b.processed_aux, b.processed);
  assert.equal(b.rejections, 1);
  assert.equal(b.rejected, 900);
  assert.equal(b.peak, 400);
  assert.equal(b.steps, 5);
  assert.equal(b.steps_ok, 5);
  assert.equal(b.client_errors, 0);
  assert.equal(b.pairing_errors, 0);
  assert.equal(b.aux_requests, 1);
  // a forwarded request with a defect its client request does not have
  rr.up[2]!.pairingStrict = ['unanswered:c1#0'];
  assert.equal(basics(rr).pairing_errors, 1);
  rr.client[2]!.pairingStrict = ['unanswered:c1#0'];
  assert.equal(basics(rr).pairing_errors, 0, 'a defect the client already had is allowed');
});

test('client errors end steps; steps_ok counts only accepted, error-free steps', () => {
  const rr = run();
  rr.client[4] = { ...rr.client[4]!, status: 200, clientErrorKind: 'length' };
  const b = basics(rr);
  assert.equal(b.steps_ok, 4);
  assert.equal(b.client_errors, 1);
  assert.deepEqual(b.client_error_kinds, { length: 1 });
  assert.deepEqual(b.failed_at, { session: 's', step: 4 });
});

test('client compactions: a summarizer burst with no client rewrite after it still counts', () => {
  seq = 0;
  const rr: RunRecords = {
    up: [
      up({ step: 0, digests: ['a'] }),
      up({ step: 1, kind: 'summarizer', digests: ['q'] }),
      up({ step: 1, kind: 'summarizer', digests: ['q2'] }),
      up({ step: 1, kind: 'title', digests: ['t'] }),
    ],
    client: [cl({ step: 0, digests: ['a'] })],
    steps: { s: 1 },
  };
  const w = rewrites(rr);
  assert.equal(w.client_compactions, 1, 'consecutive summarizer requests are one compaction; titles are ignored');
  assert.equal(w.title_requests, 1);
});

test('multi-session: views and rewrites are per session; labels carry the session', () => {
  seq = 0;
  const rr: RunRecords = {
    up: [
      up({ session: 'p', step: 0, digests: ['a'] }),
      up({ session: 'q', step: 0, digests: ['z'] }),
      up({ session: 'p', step: 1, digests: ['a', 'b'] }),
      up({ session: 'q', step: 1, digests: ['Z2'] }),
    ],
    client: [cl({ session: 'p', step: 0, digests: ['a'] }), cl({ session: 'q', step: 0, digests: ['z'] }), cl({ session: 'p', step: 1, digests: ['a', 'b'] }), cl({ session: 'q', step: 1, digests: ['z', 'y'] })],
    steps: { p: 2, q: 2 },
  };
  const w = rewrites(rr);
  assert.deepEqual(w.compaction_steps, ['q:1']);
});

test('retry metrics (benchmark contract ): recoveries, monotone attempts, the original resend is exempt', () => {
  const rr = run();
  let m = retryMetrics(stepViews(rr));
  assert.equal(m.recoveries, 1);
  assert.equal(m.retryMonotone, true);
  assert.equal(m.maxAttempts, 2);
  // a retry that grows
  rr.up[4]!.prompt = 950;
  m = retryMetrics(stepViews(rr));
  assert.equal(m.retryMonotone, false);
  assert.ok(m.monotoneViolations.some((x) => x.includes('s:3#2')), m.monotoneViolations.join());
  // equal tokens with a smaller max_tokens is monotone
  rr.up[4]!.prompt = 900;
  rr.up[4]!.maxTokens = 500;
  rr.client[3]!.prompt = 2000;
  m = retryMetrics(stepViews(rr));
  assert.equal(m.retryMonotone, true, m.monotoneViolations.join());
  // the  resend of the original is reported, not a violation
  rr.up[4]!.digests = [...rr.client[3]!.digests];
  rr.up[4]!.prompt = 2000;
  m = retryMetrics(stepViews(rr));
  assert.equal(m.originalResent, 1);
  assert.equal(m.retryMonotone, true);
  // an attempt larger than the client's original is a violation
  rr.up[3]!.prompt = 2500;
  m = retryMetrics(stepViews(rr));
  assert.ok(m.monotoneViolations.some((x) => x.includes("> the client's")));
});

test('retry metrics: the mock\'s hidden server overhead (benchmark contract hidden) is not counted against the client\'s original', () => {
  // regression: every passthrough of an err-*-hidden run was flagged "N tokens > the client's M" because the mock's
  // prompt_tokens include the 3% hidden overhead and the client's count does not
  const rr = run();
  for (const u of rr.up) {
    const h = Math.ceil(u.prompt * 0.03);
    u.prompt += h;
    u.hidden = h;
  }
  const m = retryMetrics(stepViews(rr));
  assert.equal(m.retryMonotone, true, m.monotoneViolations.join());
  rr.up[3]!.prompt += 5000; // really larger than the client's original
  assert.ok(retryMetrics(stepViews(rr)).monotoneViolations.some((x) => x.includes("> the client's")));
});
