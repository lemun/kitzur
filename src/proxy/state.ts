// The state dir (DESIGN.md "State, scope and limitations"):
//
//   <stateDir>/learned.json   LearnedState v2: one LearnedEntry per `${origin}|${model}`
//   <stateDir>/plans/*.jsonl  the optional plan store (store.persist): one append-only file per day
//
// Learned entries update in memory immediately; persistence coalesces changes asynchronously.
// A crash can lose up to five seconds of learning, never request correctness.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import type { LearnedEntry, LearnedState } from '../types.js';
import { mkdirs } from '../util.js';

// ---------------------------------------------------------------- paths and files

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

/** Async atomic replacement. Antivirus scanners can temporarily deny Windows renames. */
export async function writeFileAtomicAsync(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, path); break; }
      catch (e) {
        if (!['EPERM', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || attempt >= 4) throw e;
        await delay(50 * 2 ** attempt);
      }
    }
  } finally { await unlink(tmp).catch(() => undefined); }
}

// ---------------------------------------------------------------- entries

export { learnedKey } from '../engine/learned.js';

/** A new, empty entry: nothing learned, correction 1. */
export function freshLearnedEntry(configuredWindow: number, counterId: string): LearnedEntry {
  return {
    configuredWindow, counterId, window: null, maxPrompt: null, maxBodyBytes: null, tighten: 0, tightenLog: [],
    correction: 1, samples: 0, meanRatio: 0, ratios: [], pendingTighten: [], includeUsageRejected: false, updatedAt: null,
  };
}

/** Fields that are planning inputs or change what is forwarded. */
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
  /** Per-key learned identity; omitted to preserve the legacy, constant identity. */
  identityFor?: (key: string) => { configuredWindow: number; counterId: string };
  now?: () => Date;
  /** Delay for sample-only checkpoints (default 5000 ms); planning changes take at most 250 ms. */
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
  /** entries dropped at load: learned under another window or counter */
  readonly discarded: string[] = [];
  /** last load or write error (the proxy keeps running on a read-only state dir) */
  lastError: string | null = null;
  writes = 0;
  private readonly entriesMap = new Map<string, LearnedEntry>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private scheduledAt = 0;
  private writing: Promise<void> | null = null;
  private readonly now: () => Date;
  private readonly identityFor: (key: string) => { configuredWindow: number; counterId: string };

  constructor(private readonly o: StateStoreOptions) {
    this.path = o.dir ? join(o.dir, 'learned.json') : null;
    this.now = o.now ?? (() => new Date());
    this.identityFor = o.identityFor ?? (() => ({ configuredWindow: o.configuredWindow, counterId: o.counterId }));
    if (!this.path) return;
    const { state, error } = readLearnedState(this.path);
    if (error) this.lastError = `learned.json: ${error}`;
    for (const [k, e] of Object.entries(state.entries)) {
      const identity = this.identityFor(k);
      if (e.configuredWindow !== identity.configuredWindow || e.counterId !== identity.counterId) this.discarded.push(k);
      else this.entriesMap.set(k, e);
    }
  }

  /** The valid entry for `key` (a copy), or a fresh one. */
  entry(key: string): LearnedEntry {
    const e = this.entriesMap.get(key);
    const identity = this.identityFor(key);
    return e ? clone(e) : freshLearnedEntry(identity.configuredWindow, identity.counterId);
  }

  has(key: string): boolean {
    return this.entriesMap.has(key);
  }

  /** Update memory immediately and schedule a coalesced async checkpoint. */
  set(key: string, e: LearnedEntry): void {
    const stored = clone({ ...e, updatedAt: e.updatedAt ?? this.now().toISOString() });
    const urgent = planningChanged(this.entriesMap.get(key), stored);
    this.entriesMap.set(key, stored);
    this.dirty = true;
    this.schedule(urgent);
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
    void this.flush();
    return gone;
  }

  /** Write a pending snapshot asynchronously, waiting for any existing write first. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.writing) await this.writing;
    if (!this.dirty || !this.path) return;
    const data = JSON.stringify({ version: 2, entries: Object.fromEntries(this.entriesMap) }, null, 1) + '\n';
    this.dirty = false;
    const writing = writeFileAtomicAsync(this.path, data).then(() => {
      this.writes++;
      this.lastError = null;
    }).catch((e: unknown) => {
      this.dirty = true;
      this.lastError = `write learned.json: ${e instanceof Error ? e.message : String(e)}`;
    });
    this.writing = writing;
    await writing;
    if (this.writing === writing) this.writing = null;
    if (this.dirty) this.schedule();
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private schedule(urgent = false): void {
    if (!this.path) return;
    const delay = urgent ? Math.min(250, this.o.debounceMs ?? 5000) : this.o.debounceMs ?? 5000;
    const deadline = Date.now() + delay;
    if (this.timer && this.scheduledAt <= deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledAt = deadline;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
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
