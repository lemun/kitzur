// Small helpers shared across modules.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Escapes `s` for use as a literal inside a RegExp, with or without the `u` flag. `-` becomes `\x2d`:
 * `\-` is a syntax error outside a character class under `u`.
 */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/-/g, '\\x2d');

/**
 * mkdir -p, one level at a time (bounded depth), without { recursive: true }: Node's recursive
 * mkdirSync never returns for a path under /proc (ENOENT retried forever, seen on Node 26), and a
 * misconfigured path must not hang startup.
 */
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
