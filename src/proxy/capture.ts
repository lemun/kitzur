import { openSync, writeSync, closeSync, fchmodSync } from 'node:fs';
import type { Config } from '../config/schema.js';
import type { UpstreamRequest, UpstreamResponse } from './upstream.js';

// Fixed keys only: neither arbitrary property names nor string values from requests reach disk.
const PARAMS = ['temperature', 'top_p', 'top_k', 'min_p', 'max_tokens', 'max_completion_tokens',
  'stream', 'seed', 'n', 'presence_penalty', 'frequency_penalty', 'repetition_penalty',
  'logprobs', 'top_logprobs', 'parallel_tool_calls'];
const TEMPLATE_PARAMS = ['enable_thinking', 'preserve_thinking', 'thinking_budget'];
function scalars(value: unknown, keys: string[]): Record<string, number | boolean | null> {
  const out: Record<string, number | boolean | null> = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key];
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
function shape(body: Buffer): unknown {
  try {
    const v = JSON.parse(body.toString('utf8')) as Record<string, unknown> | null;
    return { params: scalars(v, PARAMS), chat_template_kwargs: scalars(v?.['chat_template_kwargs'], TEMPLATE_PARAMS),
      messages: Array.isArray(v?.['messages']) ? v['messages'].length : 0,
      tools: Array.isArray(v?.['tools']) ? v['tools'].length : 0 };
  } catch { return { unparsed: true }; }
}

/** Opt-in JSONL. Base64 keeps arbitrary chunk bytes (including split UTF-8) exact. */
export class RawCapture {
  private fd: number | null = null;
  private bytes = 0;
  private started = 0;
  private pending = 0;
  private stopped = false;
  private error: string | null = null;
  private readonly redacted: Set<string>;
  constructor(private readonly cfg: Config['debug']['capture'], headers: Record<string, string>) {
    this.redacted = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key',
      ...Object.keys(headers).map(k => k.toLowerCase())]);
    if (cfg.path !== null) {
      try {
        // Exclusive creation refuses existing files and symlinks; never truncate another file.
        this.fd = openSync(cfg.path, 'wx', 0o600);
        fchmodSync(this.fd, 0o600);
      } catch { this.error = 'capture file unavailable (requires a new writable path)'; this.close(); }
    }
  }
  snapshot(): Record<string, unknown> {
    return { active: this.fd !== null && !this.stopped && this.started < this.cfg.requests,
      remaining: this.cfg.path === null || this.stopped ? 0 : this.cfg.requests - this.started,
      in_flight: this.pending, bytes: this.bytes, error: this.error };
  }
  private write(record: object, terminal = false): boolean {
    if (this.fd === null) return false;
    const line = Buffer.from(JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    // Reserve space for a final budget marker, including when the next chunk is huge.
    if (this.bytes + line.length + (terminal ? 0 : 128) > this.cfg.maxBytes) {
      this.write({ type: 'end', reason: 'maxBytes' }, true);
      this.close();
      return false;
    }
    try {
      let offset = 0;
      while (offset < line.length) offset += writeSync(this.fd, line, offset);
      this.bytes += line.length;
      return true;
    } catch { this.error = 'capture write failed'; this.close(); return false; }
  }
  async request(send: () => Promise<UpstreamResponse>, req: UpstreamRequest): Promise<UpstreamResponse> {
    if (this.fd === null || this.stopped || this.started >= this.cfg.requests) return send();
    const id = ++this.started;
    this.pending++;
    let ended = false;
    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      this.pending--;
      this.write({ type: 'end', id, reason });
      if (this.started >= this.cfg.requests && this.pending === 0) this.close();
    };
    this.write({ type: 'request', id, shape: shape(req.body) });
    try {
      const up = await send();
      const headers = up.rawHeaders.map((v, i, raw) => i % 2 && this.redacted.has(raw[i - 1]!.toLowerCase()) ? '[REDACTED]' : v);
      this.write({ type: 'response', id, status: `HTTP/${up.body.httpVersion} ${up.status} ${up.statusMessage}`, headers });
      // Observe emission rather than adding a data listener: the body must remain paused until
      // the consumer attaches. Capture runs before every parser, even for held/parked errors.
      const emit = up.body.emit;
      up.body.emit = (event: string, ...args: unknown[]): boolean => {
        if (event === 'data' && this.fd !== null) this.write({ type: 'chunk', id, base64: (args[0] as Buffer).toString('base64') });
        if (event === 'end') end('end');
        else if (event === 'error') end(req.signal?.aborted ? 'aborted' : 'upstream_error');
        else if (event === 'close') end(req.signal?.aborted ? 'aborted' : 'closed');
        return emit.call(up.body, event, ...args);
      };
      return up;
    } catch (e) { end(req.signal?.aborted ? 'aborted' : 'upstream_error'); throw e; }
  }
  close(): void {
    this.stopped = true;
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { this.error = 'capture close failed'; }
      this.fd = null;
    }
  }
}
