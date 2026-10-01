// kitzur as a system under test: `node dist/src/cli.js serve` in a fresh child process per run, isolated per
// bench/README.md(own state dir, HOME, XDG_*, stats path; no inherited KITZUR_* variables). The config is
// passed as a preset plus `--set a.b=v` overrides; the port comes from the "listening on" stdout line.
// restart() (F13, RestartableSystem) stops the child with SIGTERM (graceful drain) or SIGKILL and starts a new one on
// the same upstream, keeping the state dir, or wiping it first ('fresh-state'); proxy.log and ledger.jsonl append.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { httpRequest } from '../client/http.js';
import { readJsonl } from './gobstopper.js';
import type { BenchSystem, SystemReport } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/src/cli.js relative to dist/bench/systems/ */
export const KITZUR_CLI = resolve(HERE, '..', '..', 'src', 'cli.js');

export interface KitzurOptions {
  name?: string;
  /** preset name: 32k | 64k | 100k | 128k */
  preset: string;
  /** extra config overrides, e.g. { 'tokenizer.template.name': 'sim' } */
  set?: Record<string, string | number | boolean | null>;
  tokenizer: string | null;
  readyTimeoutMs?: number;
  /** keep the state dir between start() calls (restart scenarios) */
  stateDir?: string;
}

export class Kitzur implements BenchSystem {
  readonly name: string;
  readonly args: string[];
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private runDir = '';
  private startedAt = 0;
  private upstream = '';
  /** restarts done so far (F13) */
  restarts: Array<{ kind: string; ms: number }> = [];
  port = 0;
  exitCode: number | null = null;

  constructor(private readonly o: KitzurOptions) {
    this.name = o.name ?? `kitzur-${o.preset}`;
    const sets = { 'tokenizer.template.name': 'sim', ...(o.set ?? {}) };
    this.args = ['--preset', o.preset, ...Object.entries(sets).flatMap(([k, v]) => ['--set', `${k}=${v === null ? 'null' : String(v)}`])];
  }

  private get stateDir(): string {
    return this.o.stateDir ?? join(this.runDir, 'state');
  }

  async start(upstream: string, runDir: string, append = false): Promise<string> {
    this.runDir = runDir;
    this.upstream = upstream;
    this.exitCode = null;
    const home = join(runDir, 'home');
    const stateDir = this.stateDir;
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(runDir, 'proxy.args'), this.args.join(' '));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith('XDG_') || k.startsWith('KITZUR_')) continue;
      env[k] = v;
    }
    env['HOME'] = home;
    const argv = [KITZUR_CLI, 'serve', ...this.args, '--upstream', upstream, '--port', '0',
      '--state-dir', stateDir, '--stats', join(runDir, 'ledger.jsonl'),
      ...(this.o.tokenizer ? ['--tokenizer', this.o.tokenizer] : []), '--log-level', 'warn'];
    this.log = createWriteStream(join(runDir, 'proxy.log'), { flags: append ? 'a' : 'w' });
    if (!append) this.startedAt = performance.now();
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.on('exit', (code) => (this.exitCode = code ?? -1)); // -1: killed by a signal
    this.port = await new Promise<number>((resolveP, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`kitzur did not print its port (see ${join(runDir, 'proxy.log')})`)), this.o.readyTimeoutMs ?? 60_000);
      child.stdout!.on('data', (d: Buffer) => {
        this.log!.write(d);
        out += d.toString('utf8');
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\b/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolveP(Number(m[1]));
        }
      });
      child.stderr!.on('data', (d: Buffer) => this.log!.write(d));
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`kitzur exited with ${code} before listening (see ${join(runDir, 'proxy.log')})`));
      });
      child.once('error', reject);
    });
    return `http://127.0.0.1:${this.port}`;
  }

  /** F13: stop the child (SIGTERM = graceful drain, SIGKILL = no drain) and start a new one; returns the new base URL. */
  async restart(kind: 'sigterm' | 'sigkill' | 'fresh-state'): Promise<string> {
    const t = performance.now();
    if (this.child && this.exitCode === null) {
      const exited = new Promise<void>((r) => this.child!.once('exit', () => r()));
      this.child.kill(kind === 'sigkill' ? 'SIGKILL' : 'SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>((r) => (timer = setTimeout(r, 30_000)))]);
      clearTimeout(timer);
      if (this.exitCode === null) {
        this.child.kill('SIGKILL');
        await exited;
      }
    }
    await new Promise<void>((r) => (this.log ? this.log.end(() => r()) : r()));
    if (kind === 'fresh-state') rmSync(this.stateDir, { recursive: true, force: true });
    const base = await this.start(this.upstream, this.runDir, true);
    this.restarts.push({ kind, ms: Math.round(performance.now() - t) });
    return base;
  }

  async stop(): Promise<SystemReport> {
    let status: unknown = null;
    if (this.child && this.exitCode === null) {
      try {
        const r = await httpRequest({ method: 'GET', url: `http://127.0.0.1:${this.port}/status`, timeoutMs: 5000 });
        writeFileSync(join(this.runDir, 'proxy_status.json'), r.body);
        status = JSON.parse(r.body.toString('utf8')) as unknown;
      } catch (e) {
        this.log?.write(`status failed ${String(e)}\n`);
      }
      let timer: NodeJS.Timeout | undefined;
      const exited = new Promise<void>((r) => this.child!.once('exit', () => r()));
      this.child.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => (timer = setTimeout(r, 10_000)))]);
      clearTimeout(timer);
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
