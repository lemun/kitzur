// Minimal HTTP/1.1 client over node:net for the simulated agent.
//
// Why not node:http: the harness must (1) send the exact request bytes Python's http.client sends
// (header order Host, Accept-Encoding, Content-Length, then the caller's headers) and (2) not start the
// next request before the SERVER has closed the connection. gobstopper observes usage for calibration
// after the last response byte is written and before it drops the socket (proxy.rs:1098-1101); a fast
// client that reconnects as soon as it has read the body can overtake that update and shift the
// compaction points [reference implementation, §7.4]. node:http's client destroys its own socket on
// response end, so its 'close' event says nothing about the server. Here the response is read until
// the server's FIN (with `connection: close` requested, which gobstopper strips before forwarding).

import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';

export interface HttpResponse {
  status: number;
  reason: string;
  /** lower-cased names, in wire order */
  headers: Array<[string, string]>;
  /** de-chunked body */
  body: Buffer;
  /** true when the server closed the connection (FIN) after the response */
  serverClosed: boolean;
  /** ms from connect to response complete, and to server close */
  msComplete: number;
  msClosed: number;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  /** caller headers, sent after Host / Accept-Encoding / Content-Length (Python http.client order) */
  headers?: Array<[string, string]>;
  body?: Buffer;
  /** add `Connection: close` (default true) */
  connectionClose?: boolean;
  /** after the response is complete, wait this long for the server's FIN before closing ourselves (default 10 s) */
  closeWaitMs?: number;
  /** false = return as soon as the response is complete (NOT safe with gobstopper; ablation only). Default true. */
  waitForServerClose?: boolean;
  /** overall timeout (default 600 s, like agent_client.py) */
  timeoutMs?: number;
}

export function header(res: HttpResponse, name: string): string | undefined {
  const n = name.toLowerCase();
  return res.headers.find(([k]) => k === n)?.[1];
}

/** Incremental response parser: returns true once the message is complete. */
class ResponseParser {
  private buf: Buffer = Buffer.alloc(0);
  status = 0;
  reason = '';
  headers: Array<[string, string]> = [];
  private headDone = false;
  private mode: 'length' | 'chunked' | 'eof' = 'eof';
  private remaining = 0;
  private readonly parts: Buffer[] = [];
  complete = false;

  feed(data: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    this.advance();
  }

  private advance(): void {
    for (;;) {
      if (!this.headDone) {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const lines = this.buf.subarray(0, end).toString('latin1').split('\r\n');
        this.buf = this.buf.subarray(end + 4);
        const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? '');
        if (!m) throw new Error(`bad status line ${JSON.stringify(lines[0])}`);
        const status = Number(m[1]);
        const headers: Array<[string, string]> = [];
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          if (i > 0) headers.push([l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]);
        }
        if (status >= 100 && status < 200) continue; // interim response (we never send Expect)
        this.status = status;
        this.reason = m[2] ?? '';
        this.headers = headers;
        this.headDone = true;
        const te = headers.find(([k]) => k === 'transfer-encoding')?.[1];
        const cl = headers.find(([k]) => k === 'content-length')?.[1];
        if (te && te.toLowerCase().includes('chunked')) this.mode = 'chunked';
        else if (cl !== undefined) {
          this.mode = 'length';
          this.remaining = Number(cl);
        } else this.mode = 'eof';
        if (this.mode === 'length' && this.remaining === 0) this.complete = true;
        continue;
      }
      if (this.complete) return;
      if (this.mode === 'length') {
        const take = Math.min(this.remaining, this.buf.length);
        if (take) {
          this.parts.push(this.buf.subarray(0, take));
          this.buf = this.buf.subarray(take);
          this.remaining -= take;
        }
        if (this.remaining === 0) this.complete = true;
        return;
      }
      if (this.mode === 'chunked') {
        if (this.remaining > 0) {
          const take = Math.min(this.remaining, this.buf.length);
          this.parts.push(this.buf.subarray(0, take));
          this.buf = this.buf.subarray(take);
          this.remaining -= take;
          if (this.remaining > 0) return;
          this.remaining = -2; // expect CRLF after the chunk data
        }
        if (this.remaining === -2) {
          if (this.buf.length < 2) return;
          this.buf = this.buf.subarray(2);
          this.remaining = 0;
        }
        const eol = this.buf.indexOf('\r\n');
        if (eol < 0) return;
        const size = parseInt(this.buf.subarray(0, eol).toString('latin1').split(';')[0]!.trim(), 16);
        if (!Number.isFinite(size)) throw new Error('bad chunk size');
        if (size === 0) {
          // last-chunk: optional trailers, then an empty line. From `eol` on, the first "\r\n\r\n" is the end
          // (with no trailers it is the size line's CRLF followed by the empty line).
          if (this.buf.indexOf('\r\n\r\n', eol) >= 0) this.complete = true;
          return;
        }
        this.buf = this.buf.subarray(eol + 2);
        this.remaining = size;
        continue;
      }
      // eof mode: everything until close
      if (this.buf.length) {
        this.parts.push(this.buf);
        this.buf = Buffer.alloc(0);
      }
      return;
    }
  }

  get body(): Buffer {
    return Buffer.concat(this.parts);
  }
  get headersDone(): boolean {
    return this.headDone;
  }
  get eofDelimited(): boolean {
    return this.mode === 'eof';
  }
}

export function httpRequest(o: HttpRequestOptions): Promise<HttpResponse> {
  const u = new URL(o.url);
  const port = u.port ? Number(u.port) : 80;
  const hostHeader = u.port && port !== 80 ? `${u.hostname}:${port}` : u.hostname;
  const body = o.body ?? Buffer.alloc(0);
  let head = `${o.method} ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${hostHeader}\r\nAccept-Encoding: identity\r\n`;
  if (body.length || o.method === 'POST' || o.method === 'PUT' || o.method === 'PATCH') head += `Content-Length: ${body.length}\r\n`;
  for (const [k, v] of o.headers ?? []) head += `${k}: ${v}\r\n`;
  if (o.connectionClose ?? true) head += 'Connection: close\r\n';
  head += '\r\n';
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const sock = connect({ host: u.hostname, port });
    const p = new ResponseParser();
    let msComplete = -1;
    let closeTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const overall = setTimeout(() => fail(new Error(`timeout after ${o.timeoutMs ?? 600_000} ms`)), o.timeoutMs ?? 600_000);
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      if (closeTimer) clearTimeout(closeTimer);
      sock.destroy();
      reject(e);
    };
    const done = (serverClosed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      if (closeTimer) clearTimeout(closeTimer);
      sock.destroy();
      const msClosed = performance.now() - t0;
      resolve({ status: p.status, reason: p.reason, headers: p.headers, body: p.body, serverClosed, msComplete: msComplete < 0 ? msClosed : msComplete, msClosed });
    };
    sock.setNoDelay(true);
    sock.on('connect', () => {
      sock.write(head, 'latin1');
      if (body.length) sock.write(body);
    });
    sock.on('data', (d: Buffer) => {
      try {
        p.feed(d);
      } catch (e) {
        fail(e as Error);
        return;
      }
      if (p.complete && msComplete < 0) {
        msComplete = performance.now() - t0;
        if (o.waitForServerClose === false) done(false);
        else closeTimer = setTimeout(() => done(false), o.closeWaitMs ?? 10_000);
      }
    });
    sock.on('end', () => {
      // server FIN
      if (p.complete || (p.headersDone && p.eofDelimited)) done(true);
      else fail(new Error('connection closed before the response was complete'));
    });
    sock.on('error', (e) => fail(e));
    sock.on('close', () => {
      if (!settled) {
        if (p.complete || (p.headersDone && p.eofDelimited)) done(true);
        else fail(new Error('connection closed before the response was complete'));
      }
    });
  });
}
