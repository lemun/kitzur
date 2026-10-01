// gobstopper v0.7.2 (the real Rust binary) as a system under test, launched exactly as
// reference implementation/§7 prescribes, so its decisions match the Python reference runs:
//
//  - a FRESH process per run: its prefix store and calibration are in memory and content-addressed, so a
//    warm proxy would reuse the previous run's compactions (reused_prefix instead of compacted);
//  - `proxy serve --port 0 --openai-upstream <mock> --anthropic-upstream <dead> --chatgpt-upstream <dead>
//    <args>`: unknown paths default to the Anthropic cloud upstream, so both other upstreams point at a
//    dead loopback port (127.0.0.1:1, nobody can listen there without root) — chat behaviour is unchanged;
//  - env: HOME=<run>/home, GOBSTOPPER_STATS_FILE=<run>/ledger.jsonl, every XDG_* removed (gobstopper
//    reads $XDG_CONFIG_HOME/gobstopper/config.toml at startup and aborts if it is invalid); PATH is kept
//    because gobstopper runs `curl` for every upstream call;
//  - readiness: GET /gobstopper/status == 200; the port comes from the "listening on" stdout line;
//  - stdout+stderr -> <run>/proxy.log, `proxy.args` = the args joined by spaces (analyze.py prints it),
//    the final status -> <run>/proxy_status.json, then SIGTERM.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { httpRequest } from '../client/http.js';
import type { BenchSystem, SystemReport } from './types.js';

export const DEAD_UPSTREAM = 'http://127.0.0.1:1';
export const GOB_TUNED_ARGS = ['--threshold', '58000', '--keep-recent', '2', '--carry-max-chars', '40000'];

export interface GobstopperOptions {
  bin: string;
  /** extra `proxy serve` flags, e.g. GOB_TUNED_ARGS; [] = defaults */
  args?: string[];
  name?: string;
  readyTimeoutMs?: number;
}

export function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Gobstopper implements BenchSystem {
  readonly name: string;
  readonly args: string[];
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private runDir = '';
  private startedAt = 0;
  port = 0;
  exitCode: number | null = null;

  constructor(private readonly o: GobstopperOptions) {
    this.args = o.args ?? [];
    this.name = o.name ?? (this.args.length ? 'gobstopper' : 'gobstopper-defaults');
  }

  private upstream = '';
  restarts: Array<{ kind: string; ms: number }> = [];

  async start(upstream: string, runDir: string, append = false): Promise<string> {
    this.runDir = runDir;
    this.upstream = upstream;
    this.exitCode = null;
    mkdirSync(join(runDir, 'home'), { recursive: true });
    writeFileSync(join(runDir, 'proxy.args'), this.args.join(' '));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('XDG_')) env[k] = v;
    env['HOME'] = join(runDir, 'home');
    env['GOBSTOPPER_STATS_FILE'] = join(runDir, 'ledger.jsonl');
    const argv = ['proxy', 'serve', '--port', '0', '--openai-upstream', upstream,
      '--anthropic-upstream', DEAD_UPSTREAM, '--chatgpt-upstream', DEAD_UPSTREAM, ...this.args];
    this.log = createWriteStream(join(runDir, 'proxy.log'), { flags: append ? 'a' : 'w' });
    if (!append) this.startedAt = performance.now();
    const child = spawn(this.o.bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.on('exit', (code) => (this.exitCode = code ?? -1)); // -1: killed by a signal
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('gobstopper did not print its port')), this.o.readyTimeoutMs ?? 30_000);
      child.stdout!.on('data', (d: Buffer) => {
        this.log!.write(d);
        out += d.toString('utf8');
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.stderr!.on('data', (d: Buffer) => this.log!.write(d));
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`gobstopper exited with ${code} before listening (see ${join(runDir, 'proxy.log')})`));
      });
      child.once('error', reject);
    });
    this.port = port;
    const deadline = performance.now() + (this.o.readyTimeoutMs ?? 30_000);
    for (;;) {
      try {
        const r = await httpRequest({ method: 'GET', url: `http://127.0.0.1:${port}/gobstopper/status`, timeoutMs: 2000, closeWaitMs: 1000 });
        if (r.status === 200) break;
      } catch {
        /* not up yet */
      }
      if (performance.now() > deadline) throw new Error('gobstopper status endpoint never answered');
      await sleep(50);
    }
    return `http://127.0.0.1:${port}`;
  }

  async status(): Promise<unknown> {
    const r = await httpRequest({ method: 'GET', url: `http://127.0.0.1:${this.port}/gobstopper/status`, timeoutMs: 5000 });
    return JSON.parse(r.body.toString('utf8')) as unknown;
  }

  /**
   * F13 comparator: gobstopper keeps its prefix store and calibration in memory, so every restart kind is a fresh
   * process (fresh-state = sigterm). The ledger (GOBSTOPPER_STATS_FILE) and proxy.log append.
   */
  async restart(kind: 'sigterm' | 'sigkill' | 'fresh-state'): Promise<string> {
    const t = performance.now();
    if (this.child && this.exitCode === null) {
      const exited = new Promise<void>((r) => this.child!.once('exit', () => r()));
      this.child.kill(kind === 'sigkill' ? 'SIGKILL' : 'SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>((r) => (timer = setTimeout(r, 5000)))]);
      clearTimeout(timer);
      if (this.exitCode === null) {
        this.child.kill('SIGKILL');
        await exited;
      }
    }
    await new Promise<void>((r) => (this.log ? this.log.end(() => r()) : r()));
    const base = await this.start(this.upstream, this.runDir, true);
    this.restarts.push({ kind, ms: Math.round(performance.now() - t) });
    return base;
  }

  async stop(): Promise<SystemReport> {
    let status: unknown = null;
    if (this.child && this.exitCode === null) {
      try {
        const r = await httpRequest({ method: 'GET', url: `http://127.0.0.1:${this.port}/gobstopper/status`, timeoutMs: 5000 });
        writeFileSync(join(this.runDir, 'proxy_status.json'), r.body);
        status = JSON.parse(r.body.toString('utf8')) as unknown;
      } catch (e) {
        this.log?.write(`status failed ${String(e)}\n`);
      }
      let timer: NodeJS.Timeout | undefined;
      const exited = new Promise<void>((r) => this.child!.once('exit', () => r()));
      this.child.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => (timer = setTimeout(r, 5000)))]);
      clearTimeout(timer); // a pending timer would keep the process alive
      if (this.exitCode === null) this.child.kill('SIGKILL');
    }
    await new Promise<void>((r) => (this.log ? this.log.end(() => r()) : r()));
    return {
      ledger: readJsonl(join(this.runDir, 'ledger.jsonl')),
      status,
      meta: { port: this.port, wall_ms: Math.round(performance.now() - this.startedAt), args: this.args.join(' '), restarts: this.restarts },
    };
  }
}
