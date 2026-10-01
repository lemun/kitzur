// JSONL persistence for the plan store (DESIGN.md, store.persist): one append-only file per day,
// `plans-YYYY-MM-DD.jsonl` in the given directory (the proxy passes stateDir/plans), each line
// `{"key": <plan key>, "plan": <plan>}`. Files are read lazily on the first lookup; later lines win.
// Corrupt lines and I/O errors are ignored: persistence only saves CPU, the fold recomputes any plan.
// Used only when injected into MemoryPlanStore; the engine itself does no I/O.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../types.js';
import type { PlanPersistence } from './store.js';

export interface FilePersistenceOptions {
  /** directory of the JSONL files (created on the first append) */
  dir: string;
  /** clock for the file name (default: now) */
  now?: () => Date;
}

export interface FilePersistence extends PlanPersistence {
  /** entries known after the lazy load (diagnostics) */
  entries(): number;
  /** lines that failed to parse during the load (diagnostics) */
  corruptLines(): number;
}

const FILE_RE = /^plans-\d{4}-\d{2}-\d{2}\.jsonl$/;

const isPlan = (x: unknown): x is Plan => {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  return p['version'] === 2 && typeof p['n'] === 'number' && typeof p['cut'] === 'number' && typeof p['key'] === 'string' &&
    typeof p['rewrites'] === 'object' && typeof p['headRewrites'] === 'object';
};

/** The JSONL adapter. */
export function createFilePersistence(o: FilePersistenceOptions): FilePersistence {
  let index: Map<string, Plan> | null = null;
  let corrupt = 0;
  const now = o.now ?? (() => new Date());

  const loadAll = (): Map<string, Plan> => {
    if (index) return index;
    index = new Map();
    try {
      if (!existsSync(o.dir)) return index;
      for (const name of readdirSync(o.dir).filter((f) => FILE_RE.test(f)).sort()) {
        let text: string;
        try {
          text = readFileSync(join(o.dir, name), 'utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as { key?: unknown; plan?: unknown };
            if (typeof rec.key === 'string' && isPlan(rec.plan)) index.set(rec.key, rec.plan);
            else corrupt++;
          } catch {
            corrupt++; // e.g. a torn last line after a crash
          }
        }
      }
    } catch {
      /* unreadable directory: behave as empty */
    }
    return index;
  };

  return {
    load(key) {
      return loadAll().get(key);
    },
    append(key, plan) {
      const d = now();
      const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      try {
        if (!existsSync(o.dir)) mkdirSync(o.dir, { recursive: true });
        appendFileSync(join(o.dir, `plans-${day}.jsonl`), JSON.stringify({ key, plan }) + '\n', { mode: 0o600 }); // summaries are user content
      } catch {
        /* persistence is best effort */
      }
      if (index) index.set(key, plan);
    },
    entries: () => loadAll().size,
    corruptLines: () => corrupt,
  };
}
