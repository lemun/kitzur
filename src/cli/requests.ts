import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isPlainObject } from '../config/spec.js';
import type { ChatRequest } from '../types.js';
import { UsageError } from './io.js';
import { parseNoEcho } from './format.js';

function readRequestFile(path: string): unknown[] {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return text.split('\n').flatMap((l, i) => (l.trim() ? [parseNoEcho(l, i + 1)] : []));
  }
  const j = parseNoEcho(text);
  return Array.isArray(j) ? j : [j];
}

/** A chat request from a captured record: the body itself, or {body}/{request} holding it (object or JSON text). */
export function asRequest(x: unknown): ChatRequest | null {
  if (isPlainObject(x) && Array.isArray(x['messages'])) return x as unknown as ChatRequest;
  if (isPlainObject(x)) {
    for (const k of ['body', 'request']) {
      const v = x[k];
      const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
      if (isPlainObject(o) && Array.isArray(o['messages'])) return o as unknown as ChatRequest;
    }
  }
  return null;
}

/** Captured request files in replay order: directories sorted by name (numeric-aware), then files as given. */
export function collectRequests(paths: string[], cwd: string): Array<{ label: string; req: ChatRequest | null }> {
  const out: Array<{ label: string; req: ChatRequest | null }> = [];
  const collator = new Intl.Collator('en', { numeric: true });
  for (const p0 of paths) {
    const p = resolve(cwd, p0);
    if (!existsSync(p)) throw new UsageError(`not found: ${p0}`);
    const files = statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).sort(collator.compare).map((f) => join(p, f))
      : [p];
    for (const f of files) {
      let items: unknown[];
      try {
        items = readRequestFile(f);
      } catch (e) {
        throw new UsageError(`${f}: not JSON (${(e as Error).message.split('\n')[0]})`);
      }
      items.forEach((it, i) => out.push({ label: items.length > 1 ? `${basename(f)}:${i + 1}` : basename(f), req: asRequest(it) }));
    }
  }
  return out;
}
