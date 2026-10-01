import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../helpers.js';

/** Golden vectors produced by CPython 3.14.7 (see bench/tools/make-fixtures.ts). */
export function benchFixture<T = unknown>(name: string): T {
  return JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'bench', name))).toString('utf8')) as T;
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Collects mismatches instead of stopping at the first one, so a failing golden shows its extent. */
export class Checker {
  checks = 0;
  fails: string[] = [];
  eq(got: unknown, want: unknown, what: string): void {
    this.checks++;
    const a = typeof got === 'string' ? got : JSON.stringify(got);
    const b = typeof want === 'string' ? want : JSON.stringify(want);
    if (a !== b && this.fails.length < 1000)
      this.fails.push(`${what}\n   got  ${String(a).slice(0, 200)}\n   want ${String(b).slice(0, 200)}`);
  }
  summary(): string {
    return `${this.checks - this.fails.length}/${this.checks} checks passed` + (this.fails.length ? '\n' + this.fails.slice(0, 10).join('\n') : '');
  }
}
