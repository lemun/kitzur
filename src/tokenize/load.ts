// Tokenizer loading with the compiled cache (DESIGN.md: cold start ~1.3 s from tokenizer.json,
// ~120 ms from the 3 MB compiled cache). The cache is keyed by the sha256 of the tokenizer.json bytes
// (checked inside the file), written atomically (unique tmp + rename) and rebuilt when stale or corrupt.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { serializeCompiled, tokenizerFromCompiled, tokenizerFromJson, type Tokenizer, type TokenizerOptions } from './tokenizer.js';

export interface LoadedTokenizer extends Tokenizer {
  /** sha256 (hex) of the tokenizer.json bytes: the tokenizer identity for counter ids */
  readonly sha256: string;
  /** true when built from the compiled cache */
  readonly fromCache: boolean;
  /** 'written' | 'fresh' (cache used) | 'unwritable' | 'none' (no cache path) */
  readonly cacheStatus: 'written' | 'fresh' | 'unwritable' | 'none';
  readonly loadMs: number;
}

/**
 * mkdir -p without { recursive: true }: Node's recursive mkdirSync never returns for a path under
 * /proc (ENOENT retried forever, seen on Node 26), and a misconfigured cachePath must not hang startup.
 */
function mkdirs(dir: string): void {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.push(d);
    if (dirname(d) === d || missing.length > 64) break;
  }
  for (let i = missing.length - 1; i >= 0; i--) mkdirSync(missing[i]!);
}

/** Default cache file: <stateDir>/tokenizer-<sha16>.lctk (config tokenizer.cachePath = null). */
export function defaultTokenizerCachePath(stateDir: string, sha256Hex: string): string {
  return join(stateDir, `tokenizer-${sha256Hex.slice(0, 16)}.lctk`);
}

/**
 * Loads tokenizer.json through the compiled cache. `cachePath` null/undefined with `stateDir` set
 * uses defaultTokenizerCachePath; with neither, no cache is used. Cache I/O errors never fail the
 * load. Throws TokenizerUnsupportedError for unsupported tokenizer.json features.
 */
export function loadTokenizerCached(
  path: string,
  cachePath: string | null | undefined,
  opts: TokenizerOptions & { stateDir?: string | null } = {},
): LoadedTokenizer {
  const t0 = performance.now();
  const bytes = readFileSync(path);
  const shaBuf = createHash('sha256').update(bytes).digest();
  const sha = shaBuf.toString('hex');
  const cp = cachePath ?? (opts.stateDir ? defaultTokenizerCachePath(opts.stateDir, sha) : null);
  const done = (tok: Tokenizer, fromCache: boolean, cacheStatus: LoadedTokenizer['cacheStatus']): LoadedTokenizer =>
    Object.assign(tok, { sha256: sha, fromCache, cacheStatus, loadMs: performance.now() - t0 });
  if (cp) {
    try {
      const t = tokenizerFromCompiled(readFileSync(cp), shaBuf, opts);
      if (t) return done(t, true, 'fresh');
    } catch {
      /* missing, stale or corrupt: rebuild */
    }
  }
  const json = JSON.parse(bytes.toString('utf8')) as unknown;
  const tok = tokenizerFromJson(json, opts);
  if (!cp) return done(tok, false, 'none');
  const tmp = `${cp}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirs(dirname(cp));
    writeFileSync(tmp, serializeCompiled(json, shaBuf));
    renameSync(tmp, cp);
    return done(tok, false, 'written');
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    return done(tok, false, 'unwritable');
  }
}
