// Best-effort daily JSONL persistence. Each retained day is scanned lazily once;
// only the byte-bounded LRU index stays resident. Writes run asynchronously.
import { readdirSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../types.js';
import type { PlanPersistence } from './store.js';

export interface FilePersistenceOptions {
  dir: string;
  maxBytes?: number;
  /** Number of UTC calendar days to keep, including today. Default: 14. */
  retentionDays?: number;
  now?: () => Date;
}

export interface FilePersistence extends PlanPersistence {
  entries(): number;
  bytes(): number;
  /** Invalid lines encountered over the lifetime of this adapter. */
  corruptLines(): number;
  /** Wait for queued writes and retention cleanup (shutdown/tests). */
  flush(): Promise<void>;
}

const FILE_RE = /^plans-\d{4}-\d{2}-\d{2}\.jsonl$/;
const isPlan = (x: unknown): x is Plan => {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  return p['version'] === 2 && typeof p['n'] === 'number' && typeof p['cut'] === 'number' && typeof p['key'] === 'string' &&
    typeof p['rewrites'] === 'object' && typeof p['headRewrites'] === 'object';
};

/** The index and pending write queue each use at most maxBytes serialized bytes. */
export function createFilePersistence(o: FilePersistenceOptions): FilePersistence {
  const index = new Map<string, { plan: Plan; bytes: number; day: string }>();
  const scanned = new Set<string>();
  let files: string[] = [];
  const maxBytes = Math.max(0, o.maxBytes ?? 64 * 1024 * 1024);
  const retentionDays = Math.max(1, o.retentionDays ?? 14);
  const now = o.now ?? (() => new Date());
  let bytes = 0;
  let pendingBytes = 0;
  let corrupt = 0;
  let queue = Promise.resolve();
  let cleanupDay = '';
  const day = () => now().toISOString().slice(0, 10);
  const cutoff = () => {
    const d = new Date(`${day()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - retentionDays + 1);
    return d.toISOString().slice(0, 10);
  };
  const remember = (key: string, plan: Plan, sourceDay: string) => {
    const old = index.get(key);
    if (old) { bytes -= old.bytes; index.delete(key); }
    const size = Buffer.byteLength(JSON.stringify({ key, plan }));
    if (size > maxBytes) return;
    index.set(key, { plan, bytes: size, day: sourceDay });
    bytes += size;
    while (bytes > maxBytes) {
      const k = index.keys().next().value!;
      bytes -= index.get(k)!.bytes;
      index.delete(k);
    }
  };
  const cleanup = () => {
    if (cleanupDay === day()) return;
    cleanupDay = day();
    const oldest = cutoff();
    for (const [key, entry] of index) {
      if (entry.day < oldest) { bytes -= entry.bytes; index.delete(key); }
    }
    for (const date of scanned) if (date < oldest) scanned.delete(date);
    // Refresh the directory once per UTC day, never once per cache miss.
    try {
      files = readdirSync(o.dir).filter((f) => FILE_RE.test(f) && f.slice(6, 16) >= oldest).sort().reverse();
    } catch { files = []; }
    queue = queue.then(async () => {
      for (const name of await readdir(o.dir)) {
        if (FILE_RE.test(name) && name.slice(6, 16) < oldest) {
          await unlink(join(o.dir, name)).catch(() => undefined);
        }
      }
    }).catch(() => undefined);
  };
  return {
    load(key) {
      cleanup();
      const cached = index.get(key);
      if (cached) {
        index.delete(key);
        index.set(key, cached);
        return cached.plan;
      }
      try {
        for (const name of files) {
          const sourceDay = name.slice(6, 16);
          if (scanned.has(sourceDay)) continue;
          scanned.add(sourceDay);
          let text: string;
          try { text = readFileSync(join(o.dir, name), 'utf8'); } catch { continue; }
          let found: Plan | undefined;
          // Preserve newer days and queued appends already in the LRU.
          const protectedKeys = new Set(index.keys());
          // Later records within a day win; older days never overwrite a hit.
          for (const line of text.split('\n')) {
            if (!line) continue;
            try {
              const rec = JSON.parse(line) as { key?: unknown; plan?: unknown };
              if (typeof rec.key !== 'string' || !isPlan(rec.plan)) { corrupt++; continue; }
              if (rec.key === key) found = rec.plan;
              if (!protectedKeys.has(rec.key)) remember(rec.key, rec.plan, sourceDay);
            } catch { corrupt++; }
          }
          if (found) { remember(key, found, sourceDay); return found; }
        }
      } catch { /* cache misses are safe on I/O errors */ }
      return undefined;
    },
    append(key, plan) {
      cleanup();
      remember(key, plan, day());
      const line = JSON.stringify({ key, plan }) + '\n';
      const size = Buffer.byteLength(line);
      if (pendingBytes + size > maxBytes) return; // drop cache writes under pressure
      pendingBytes += size;
      const name = `plans-${day()}.jsonl`;
      queue = queue.then(async () => {
        await mkdir(o.dir, { recursive: true, mode: 0o700 });
        await appendFile(join(o.dir, name), line, { mode: 0o600 });
      }).catch(() => undefined).finally(() => { pendingBytes -= size; });
    },
    entries: () => index.size,
    bytes: () => bytes,
    corruptLines: () => corrupt,
    flush: () => queue,
  };
}
