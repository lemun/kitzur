import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Logger, LogLevel } from '../app.js';

const rank = { error: 0, warn: 1, info: 2, debug: 3 };

/** File output is asynchronous and bounded. Console writes run on a separate thread because
 * Windows console writes can block before Writable backpressure has a chance to run. */
export class RuntimeLog implements Logger {
  private stream: WriteStream | null = null;
  private consoleWorker: Worker | null = null;
  private consolePending = false;
  private closed = false;
  private queued = 0;
  private bytes = 0;
  private day = '';
  private chain = Promise.resolve();
  onLine: (() => void) | null = null;
  dropped = 0;
  consoleDropped = 0;
  lastLine = '';
  errorMessage: string | null = null;
  path: string;

  constructor(private readonly options: { dir: string; file?: string | null; console?: boolean; level: LogLevel; maxBytes?: number }) {
    this.path = options.file ?? join(options.dir, `kitzur-${new Date().toISOString().slice(0, 10)}.log`);
    if (options.console && process.stderr.isTTY) {
      this.consoleWorker = new Worker(`
        const { parentPort } = require('node:worker_threads');
        const { writeSync } = require('node:fs');
        parentPort.on('message', line => { try { writeSync(2, line); } catch {} parentPort.postMessage('done'); });
      `, { eval: true });
      this.consoleWorker.on('message', () => { this.consolePending = false; });
      this.consoleWorker.on('error', () => { this.consolePending = true; });
      this.consoleWorker.unref();
    }
  }

  private async output(line: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const path = this.options.file ?? join(this.options.dir, `kitzur-${day}.log`);
    const cap = this.options.maxBytes ?? 10 * 1024 * 1024;
    if (!this.stream || day !== this.day || this.bytes + Buffer.byteLength(line) > cap) {
      if (this.stream) await new Promise<void>((resolve) => this.stream!.end(resolve));
      this.stream = null;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (day !== this.day) {
        // Only manage our own dated logs, never unrelated files in a custom log directory.
        const cutoff = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
        for (const name of await readdir(dirname(path))) {
          const match = /^kitzur-(\d{4}-\d{2}-\d{2})\.log(?:\.1)?$/.exec(name);
          if (match && match[1]! < cutoff) await unlink(join(dirname(path), name)).catch(() => undefined);
        }
        this.bytes = (await stat(path).catch(() => null))?.size ?? 0;
      }
      if (this.bytes + Buffer.byteLength(line) > cap) {
        await unlink(`${path}.1`).catch(() => undefined);
        await rename(path, `${path}.1`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
        this.bytes = 0;
      }
      this.path = path;
      this.day = day;
      this.stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
      this.stream.on('error', (e) => { this.errorMessage = e.message; });
    }
    await new Promise<void>((resolve, reject) => this.stream!.write(line, (e) => e ? reject(e) : resolve()));
    this.bytes += Buffer.byteLength(line);
  }

  private write(level: LogLevel, msg: string): void {
    if (this.closed || rank[level] > rank[this.options.level]) return;
    const line = `${new Date().toISOString()} kitzur: ${level}: ${msg.slice(0, 8192)}\n`;
    this.lastLine = line.trimEnd();
    this.onLine?.();
    if (this.consoleWorker) {
      if (this.consolePending) this.consoleDropped++;
      else { this.consolePending = true; this.consoleWorker.postMessage(line); }
    }
    if (this.queued >= 256) { this.dropped++; return; }
    this.queued++;
    this.chain = this.chain.then(() => this.output(line)).catch((e: unknown) => {
      this.errorMessage = e instanceof Error ? e.message : String(e);
      if (this.stream?.destroyed) this.stream = null;
    }).finally(() => { this.queued--; });
  }
  error(msg: string): void { this.write('error', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  info(msg: string): void { this.write('info', msg); }
  debug(msg: string): void { this.write('debug', msg); }
  reopen(): void {
    this.chain = this.chain.then(async () => {
      if (this.stream && !this.stream.destroyed) await new Promise<void>((resolve) => this.stream!.end(resolve));
      this.stream = null;
      this.day = '';
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.chain;
    if (this.stream && !this.stream.destroyed) await new Promise<void>((resolve) => this.stream!.end(resolve));
    void this.consoleWorker?.terminate();
  }
}

/** The worker reads shared heartbeat memory even while the main thread cannot run callbacks. */
export class LoopWatchdog {
  private readonly shared = new BigInt64Array(new SharedArrayBuffer(16));
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private readonly worker: Worker;
  private readonly timer: NodeJS.Timeout;
  readonly ready: Promise<void>;
  private context = { request_id: 'none', phase: 'idle' };
  constructor(private readonly log: RuntimeLog, options: { thresholdMs?: number; heartbeatMs?: number } = {}) {
    const heartbeatMs = options.heartbeatMs ?? 1000;
    Atomics.store(this.shared, 0, BigInt(Date.now()));
    this.worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const { appendFile, mkdir, stat, unlink, rename } = require('node:fs/promises');
      const { dirname } = require('node:path');
      const shared = new BigInt64Array(workerData.shared);
      let details = workerData.details, stalled = false, writing = false;
      parentPort.on('message', x => { details = x; });
      setInterval(async () => {
        const start = Number(Atomics.load(shared, 0));
        const duration = Date.now() - start;
        if (duration <= workerData.threshold) {
          if (stalled) { stalled = false; }
          return;
        }
        if (!stalled) { stalled = true; Atomics.add(shared, 1, 1n); }
        if (writing) return;
        writing = true;
        try {
          await mkdir(dirname(details.path), { recursive: true, mode: 0o700 });
          if (((await stat(details.path).catch(() => null))?.size ?? 0) >= 10 * 1024 * 1024) {
            await unlink(details.path + '.1').catch(() => {});
            await rename(details.path, details.path + '.1');
            parentPort.postMessage('rotated');
          }
          await appendFile(details.path, JSON.stringify({ event: 'event_loop_stall', stall_start: new Date(start).toISOString(), duration_ms: duration, ...details.context, last_log_line: details.lastLine }) + '\\n', { mode: 0o600 });
        } catch {} finally { writing = false; }
      }, workerData.interval);
      parentPort.postMessage('ready');
    `, { eval: true, workerData: { shared: this.shared.buffer, threshold: options.thresholdMs ?? 10_000, interval: heartbeatMs, details: this.details() } });
    this.ready = new Promise((resolve) => {
      this.worker.on('message', (message: string) => {
        if (message === 'ready') resolve();
        if (message === 'rotated') log.reopen();
      });
      this.worker.once('error', () => resolve());
    });
    this.worker.on('error', (e) => log.error(`event-loop watchdog: ${e.message}`));
    log.onLine = () => this.worker.postMessage(this.details());
    this.worker.unref();
    this.histogram.enable();
    this.timer = setInterval(() => {
      Atomics.store(this.shared, 0, BigInt(Date.now()));
      this.worker.postMessage(this.details());
    }, heartbeatMs);
    this.timer.unref();
  }
  private details(): object { return { path: this.log.path, lastLine: this.log.lastLine, context: this.context }; }
  phase(requestId: string, phase: string): void {
    this.context = { request_id: requestId, phase };
    this.worker.postMessage(this.details());
  }
  snapshot(): Record<string, unknown> {
    return { loop_lag_ms: Math.round(this.histogram.percentile(99) / 1e6 * 10) / 10, stalls_total: Number(Atomics.load(this.shared, 1)), log: { path: this.log.path, error: this.log.errorMessage, dropped: this.log.dropped, console_dropped: this.log.consoleDropped } };
  }
  close(): void {
    this.log.onLine = null;
    clearInterval(this.timer);
    this.histogram.disable();
    void this.worker.terminate();
  }
}
