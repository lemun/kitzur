// Paths referenced inside tool outputs (DESIGN.md, ).
//
// The candidate is the §6.2 pattern `(?:[\w.@-]+/)+[\w.@-]+\.[A-Za-z0-9]{1,8}`, extended with an optional
// leading `/`, `./`, `../` or `~/` so absolute paths keep their root, and required to end at a token boundary.
// A match that directly follows `:` or `/` is part of a URL (https://host/app.js) and is skipped.
//
// Every character of a match is in [\w.@/~-], so the pattern only runs inside maximal runs of that alphabet which
// hold both a `/` and a `.x`; runs longer than MAX_RUN_CHARS (base64, minified blobs) are skipped. This bounds the
// regex's per-start-position backtracking without changing a single match in any shorter run.

const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?![\w@/-])/g;
/** Maximal runs of the path alphabet. */
const RUN_RE = /[\w.@/~-]+/g;
/** A run longer than this is not a path worth listing (and scanning it costs O(length²)). */
export const MAX_RUN_CHARS = 512;
/**
 * A line "starts with a path" (): optional list/tree glyphs, then a path with at least one `/`; the same lines as
 * `/^[\s│├└─┬┼|`*•+>-]*(?:~\/|\.{1,2}\/|\/)?(?:[\w.@-]+\/)+/`. That regex backtracks quadratically on a long
 * run of `-` (the glyph class and the path class share it): a 40,000-dash line in a tool output took 5 s. Here the
 * glyph run is skipped once; a `-` that ends it may also start the path's first segment.
 */
const GLYPHS = new Set([...' \t\r\f\v\u00a0│├└─┬┼|`*•+>-']);
const PATH_START = /^(?:~\/|\.{1,2}\/|\/)?[\w.@-]+\//;
const SEGMENT_REST = /^[\w.@-]*\//;
export function startsWithPath(line: string): boolean {
  let g = 0;
  while (g < line.length && (GLYPHS.has(line[g]!) || /\s/.test(line[g]!))) g++;
  const rest = line.slice(g);
  return PATH_START.test(rest) || (g > 0 && line[g - 1] === '-' && SEGMENT_REST.test(rest));
}
const CONFIG_LIKE = /\.(?:ya?ml|json|toml|ini|env|conf|cfg|properties)$/i;

export const isConfigLike = (p: string): boolean => CONFIG_LIKE.test(p);

/** True when more than half of the non-empty lines start with a path (ls / glob / grep / find output). */
export function isListingOutput(text: string): boolean {
  let lines = 0;
  let paths = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    lines++;
    if (startsWithPath(l)) paths++;
  }
  return lines > 0 && paths * 2 > lines;
}

/**
 * `a` and `b` name the same file when equal (ignoring a leading `./`) or when one is a `/`-suffix of the other
 * and the shorter one has a directory part (a bare `index.ts` would match every `…/index.ts`).
 */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (p: string): string => p.replace(/^(?:\.\/)+/, '');
  const x = strip(a);
  const y = strip(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.includes('/') && long.endsWith('/' + short);
}

/**
 * A bucket key with samePath(a, b) ⇒ pathKey(a) === pathKey(b): the last two `/`-segments after a leading `./`
 * (the whole path when it has no `/`). Ledger builds look spellings up by it instead of comparing every pair
 * (a session that touched 1,000 files spent most of a restart's fold in samePath).
 */
export function pathKey(p: string): string {
  const x = p.replace(/^(?:\.\/)+/, '');
  const last = x.lastIndexOf('/');
  if (last < 0) return x;
  const prev = x.lastIndexOf('/', last - 1);
  return prev < 0 ? x : x.slice(prev + 1);
}

/** Items bucketed by pathKey, each bucket in insertion order. */
export class PathIndex<T> {
  private readonly m = new Map<string, T[]>();
  add(path: string, v: T): void {
    const k = pathKey(path);
    const b = this.m.get(k);
    if (b) b.push(v);
    else this.m.set(k, [v]);
  }
  /** the items added under a path that may name the same file as `path` (callers still check samePath) */
  near(path: string): readonly T[] {
    return this.m.get(pathKey(path)) ?? [];
  }
}

/**
 * Of two spellings of one file (samePath), the more specific one: the longer after a leading `./`, else the first
 * (`/repo/src/a.ts` over `src/a.ts`; `./src/a.ts` and `src/a.ts` keep whichever came first).
 */
export function longerSpelling(first: string, second: string): string {
  const strip = (p: string): string => p.replace(/^(?:\.\/)+/, '');
  return strip(second).length > strip(first).length ? second : first;
}

/**
 * Candidate paths of one tool output in rank order (config-like first, then first appearance), at most
 * `maxPerResult`. Excludes the tool's own target paths, OpenCode's `Full output saved to:` pointer, and
 * every path of a listing output.
 */
export function outputPaths(text: string, own: readonly string[], maxPerResult: number): string[] {
  if (maxPerResult <= 0 || !text.includes('/')) return [];
  if (isListingOutput(text)) return [];
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('/') || line.includes('Full output saved to:')) continue;
    RUN_RE.lastIndex = 0;
    for (let r = RUN_RE.exec(line); r !== null; r = RUN_RE.exec(line)) {
      const run = r[0];
      if (run.length > MAX_RUN_CHARS || !run.includes('/') || !/\.[A-Za-z0-9]/.test(run)) continue;
      PATH_RE.lastIndex = 0;
      for (let m = PATH_RE.exec(run); m !== null; m = PATH_RE.exec(run)) {
        // the character before the match in the line (the run's start follows a character outside the alphabet)
        const at = r.index + m.index;
        const prev = at > 0 ? line[at - 1]! : '';
        if (prev === ':' || prev === '/' || /[\w@.-]/.test(prev)) continue;
        const p = m[0];
        if (own.some((o) => samePath(o, p))) continue;
        // the same file named twice (checkout/a.spec.ts, tests/e2e/checkout/a.spec.ts): first place, longest form
        const dup = found.findIndex((q) => samePath(q, p));
        if (dup >= 0) {
          found[dup] = longerSpelling(found[dup]!, p);
          continue;
        }
        found.push(p);
      }
    }
  }
  const ranked = [...found.filter(isConfigLike), ...found.filter((p) => !isConfigLike(p))];
  return ranked.slice(0, maxPerResult);
}
