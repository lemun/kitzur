// The state dir (DESIGN.md "State dir", §8 "Learned state is persisted", ):
//
//   <stateDir>/learned.json   LearnedState v2: one LearnedEntry per `${origin}|${model}`
//   <stateDir>/plans/*.jsonl  the optional plan store (store.persist): one append-only file per day
//
// Learned values are planning inputs (§5.3), so a change is written atomically (temp file + fsync +
// rename) *synchronously* inside StateStore.set: it is on disk before any later request can plan with
// it. Changes that do not affect planning (calibration samples) are written with a short debounce.
// Entries learned under another configured window or another counter id are discarded ().
// Directory creation avoids mkdirSync({recursive}) (it never returns for some /proc paths on Node 26).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LearnedEntry, LearnedState, Plan } from '../types.js';

// ---------------------------------------------------------------- paths and files

/** $XDG_STATE_HOME/kitzur, else ~/.local/state/kitzur. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const x = env['XDG_STATE_HOME'];
  return x && x.startsWith('/') ? join(x, 'kitzur') : join(home, '.local', 'state', 'kitzur');
}

/** mkdir -p, one level at a time (bounded depth). */
export function mkdirs(dir: string): void {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.push(d);
    if (dirname(d) === d || missing.length > 64) break;
  }
  for (let i = missing.length - 1; i >= 0; i--) {
    try {
      mkdirSync(missing[i]!);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Writes `data` to `path` atomically: unique temp file in the same dir, fsync, rename. */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirs(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o600);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already failing */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}

// ---------------------------------------------------------------- entries

/** The learned-state key of a request: `${origin}|${model}` (). */
export function learnedKey(origin: string, model: unknown): string {
  return `${origin}|${typeof model === 'string' ? model : ''}`;
}

/** A new, empty entry: nothing learned, correction 1. */
export function freshLearnedEntry(configuredWindow: number, counterId: string): LearnedEntry {
  return {
    configuredWindow, counterId, window: null, maxPrompt: null, maxBodyBytes: null, tighten: 0, tightenLog: [],
    correction: 1, samples: 0, meanRatio: 0, ratios: [], pendingTighten: [], includeUsageRejected: false, updatedAt: null,
  };
}

/** Fields that are planning inputs (§5.3) or change what is forwarded: written synchronously. */
export function planningChanged(a: LearnedEntry | undefined, b: LearnedEntry): boolean {
  if (!a) return b.window !== null || b.maxPrompt !== null || b.maxBodyBytes !== null || b.tighten !== 0 || b.correction !== 1 || b.includeUsageRejected;
  return a.window !== b.window || a.maxPrompt !== b.maxPrompt || a.maxBodyBytes !== b.maxBodyBytes || a.tighten !== b.tighten ||
    a.correction !== b.correction || a.includeUsageRejected !== b.includeUsageRejected;
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** A loaded entry with defaults for missing fields, or null when it is not an entry at all. */
function sanitize(x: unknown): LearnedEntry | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o['configuredWindow'] !== 'number' || typeof o['counterId'] !== 'string') return null;
  const arr = <T>(v: unknown, ok: (e: unknown) => e is T): T[] => (Array.isArray(v) ? v.filter(ok) : []);
  const isNum = (e: unknown): e is number => typeof e === 'number' && Number.isFinite(e);
  const isRec = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null;
  return {
    configuredWindow: o['configuredWindow'],
    counterId: o['counterId'],
    window: numOrNull(o['window']),
    maxPrompt: numOrNull(o['maxPrompt']),
    maxBodyBytes: numOrNull(o['maxBodyBytes']),
    tighten: num(o['tighten'], 0),
    tightenLog: arr(o['tightenLog'], isRec).map((t) => ({ rule: String(t['rule']), at: String(t['at']), rejectedRaw: num(t['rejectedRaw'], 0) })),
    correction: num(o['correction'], 1),
    samples: num(o['samples'], 0),
    meanRatio: num(o['meanRatio'], 0),
    ratios: arr(o['ratios'], isNum),
    pendingTighten: arr(o['pendingTighten'], isRec).map((t) => ({ chainKey: String(t['chainKey']), at: String(t['at']), rejectedRaw: num(t['rejectedRaw'], 0) })),
    includeUsageRejected: o['includeUsageRejected'] === true,
    updatedAt: typeof o['updatedAt'] === 'string' ? o['updatedAt'] : null,
  };
}

const clone = (e: LearnedEntry): LearnedEntry => ({
  ...e,
  tightenLog: e.tightenLog.map((t) => ({ ...t })),
  ratios: [...e.ratios],
  pendingTighten: e.pendingTighten.map((t) => ({ ...t })),
});

/** Reads learned.json; a missing file is an empty state, an unreadable one is reported. */
export function readLearnedState(path: string): { state: LearnedState; error: string | null } {
  const empty: LearnedState = { version: 2, entries: {} };
  if (!existsSync(path)) return { state: empty, error: null };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof j !== 'object' || j === null || (j as { version?: unknown }).version !== 2) return { state: empty, error: 'not a LearnedState v2 file' };
    const entries: Record<string, LearnedEntry> = {};
    const src = (j as { entries?: unknown }).entries;
    if (typeof src === 'object' && src !== null) {
      for (const [k, v] of Object.entries(src)) {
        const e = sanitize(v);
        if (e) entries[k] = e;
      }
    }
    return { state: { version: 2, entries }, error: null };
  } catch (e) {
    return { state: empty, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface StateStoreOptions {
  /** the state dir; null = memory only */
  dir: string | null;
  /** budget.window: entries learned under another value are discarded */
  configuredWindow: number;
  /** the counter id: entries learned with another counter are discarded */
  counterId: string;
  now?: () => Date;
  /** delay for writes that do not change planning (default 1000 ms) */
  debounceMs?: number;
}

/** Filter for show/reset: an exact key, or its origin part, or its model part. */
export function keyMatches(key: string, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  if (key === filter) return true;
  const bar = key.lastIndexOf('|');
  return key.slice(0, bar) === filter || key.slice(bar + 1) === filter;
}

export class StateStore {
  readonly path: string | null;
  /** entries dropped at load: learned under another window or counter () */
  readonly discarded: string[] = [];
  /** last load or write error (the proxy keeps running on a read-only state dir) */
  lastError: string | null = null;
  writes = 0;
  private readonly entriesMap = new Map<string, LearnedEntry>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly now: () => Date;

  constructor(private readonly o: StateStoreOptions) {
    this.path = o.dir ? join(o.dir, 'learned.json') : null;
    this.now = o.now ?? (() => new Date());
    if (!this.path) return;
    const { state, error } = readLearnedState(this.path);
    if (error) this.lastError = `learned.json: ${error}`;
    for (const [k, e] of Object.entries(state.entries)) {
      if (e.configuredWindow !== o.configuredWindow || e.counterId !== o.counterId) this.discarded.push(k);
      else this.entriesMap.set(k, e);
    }
  }

  /** The valid entry for `key` (a copy), or a fresh one. */
  entry(key: string): LearnedEntry {
    const e = this.entriesMap.get(key);
    return e ? clone(e) : freshLearnedEntry(this.o.configuredWindow, this.o.counterId);
  }

  has(key: string): boolean {
    return this.entriesMap.has(key);
  }

  /**
   * Stores an entry. A planning change is written before this returns (atomic), so no request can
   * plan with a value that is not on disk; other changes are written after `debounceMs`.
   */
  set(key: string, e: LearnedEntry): void {
    const prev = this.entriesMap.get(key);
    const stored = clone({ ...e, updatedAt: e.updatedAt ?? this.now().toISOString() });
    this.entriesMap.set(key, stored);
    this.dirty = true;
    if (planningChanged(prev, stored)) this.flush();
    else this.schedule();
  }

  /** All valid entries (copies), by key. */
  entries(): Record<string, LearnedEntry> {
    const out: Record<string, LearnedEntry> = {};
    for (const [k, e] of this.entriesMap) out[k] = clone(e);
    return out;
  }

  /** Removes the entries matching `filter` (all without one); returns the removed keys. */
  reset(filter?: string): string[] {
    const gone = [...this.entriesMap.keys()].filter((k) => keyMatches(k, filter));
    for (const k of gone) this.entriesMap.delete(k);
    this.dirty = true;
    this.flush();
    return gone;
  }

  /** Writes pending changes now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.path) {
      this.dirty = false;
      return;
    }
    const state: LearnedState = { version: 2, entries: Object.fromEntries(this.entriesMap) };
    try {
      writeFileAtomic(this.path, JSON.stringify(state, null, 1) + '\n');
      this.dirty = false;
      this.writes++;
    } catch (e) {
      this.lastError = `write ${this.path}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  close(): void {
    this.flush();
  }

  private schedule(): void {
    if (this.timer || !this.path) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.o.debounceMs ?? 1000);
    this.timer.unref();
  }
}

// ---------------------------------------------------------------- `kitzur state show|reset`

/** `state show [--key k]`: the learned entries on disk (no validation against a config). */
export function showState(dir: string, filter?: string): { path: string; state: LearnedState; error: string | null } {
  const path = join(dir, 'learned.json');
  const { state, error } = readLearnedState(path);
  const entries: Record<string, LearnedEntry> = {};
  for (const [k, e] of Object.entries(state.entries)) if (keyMatches(k, filter)) entries[k] = e;
  return { path, state: { version: 2, entries }, error };
}

/** `state reset [--key k]`: removes matching entries (all without a filter); returns the removed keys. */
export function resetState(dir: string, filter?: string): string[] {
  const path = join(dir, 'learned.json');
  const { state, error } = readLearnedState(path);
  if (error) throw new Error(`${path}: ${error}`);
  const gone = Object.keys(state.entries).filter((k) => keyMatches(k, filter));
  for (const k of gone) delete state.entries[k];
  if (gone.length) writeFileAtomic(path, JSON.stringify(state, null, 1) + '\n');
  return gone;
}

// ---------------------------------------------------------------- optional plan store persistence (§5.9)

/**
 * Append-only plan log for `store.persist`: `<stateDir>/plans/<YYYY-MM-DD>.jsonl`, one
 * `{"key","plan"}` per line. Plans of another ENGINE_ALGO_VERSION never match because the version is
 * part of the plan key. Plans contain summaries (user content): SECURITY.md documents this.
 */
export class PlanLog {
  readonly dir: string;
  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.dir = join(stateDir, 'plans');
  }

  append(key: string, plan: Plan): void {
    mkdirs(this.dir);
    appendFileSync(join(this.dir, `${this.now().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ key, plan }) + '\n', { mode: 0o600 });
  }

  /** Every stored (key, plan), oldest file first; unreadable lines are skipped. */
  *load(): Generator<[string, Plan]> {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      let text: string;
      try {
        text = readFileSync(join(this.dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const j = JSON.parse(line) as { key?: unknown; plan?: unknown };
          if (typeof j.key === 'string' && typeof j.plan === 'object' && j.plan !== null) yield [j.key, j.plan as Plan];
        } catch {
          /* a torn last line after a crash */
        }
      }
    }
  }
}
