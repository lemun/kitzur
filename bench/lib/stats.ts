// Small numeric / formatting helpers shared by the harness, with Python-compatible formatting where
// the reference scripts' text output is reproduced byte-for-byte (analyze.py, baseline.py).

export const sum = (xs: Iterable<number>): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

/** Python max(xs, default=d). */
export const maxOr = (xs: Iterable<number>, d = 0): number => {
  let m: number | null = null;
  for (const x of xs) if (m === null || x > m) m = x;
  return m ?? d;
};

/** Nearest-rank percentile (p in [0,100]) of an unsorted sample; NaN for an empty one. */
export function percentile(xs: readonly number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1]!;
}

/** Python f"{n:,}" for integers. */
export function fmtInt(n: number): string {
  if (!Number.isInteger(n)) throw new TypeError(`fmtInt expects an integer, got ${n}`);
  const neg = n < 0;
  const digits = (Math.abs(n) < 1e21 ? String(Math.abs(n)) : BigInt(Math.abs(n)).toString()).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? '-' + digits : digits;
}

/**
 * Python f"{x:.{d}f}": correctly rounded from the exact binary value, ties to even. JS toFixed picks
 * the larger candidate on exact ties (1.125 -> "1.13" in JS, "1.12" in Python); everything else agrees.
 */
export function pyFixed(x: number, d: number): string {
  const s = x.toFixed(d);
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return s;
  // toFixed(100) is the exact decimal expansion for every double >= 2**-47 or so; a tie at digit d needs
  // an expansion that ends right after it, which such a double always has.
  const exact = Math.abs(x).toFixed(100);
  const dot = exact.indexOf('.');
  const frac = exact.slice(dot + 1);
  const tail = frac.slice(d);
  if (tail[0] !== '5' || !/^0*$/.test(tail.slice(1))) return s;
  const kept = exact.slice(0, dot) + (d ? '.' + frac.slice(0, d) : '');
  const last = kept.charCodeAt(kept.length - 1) - 48;
  if (last % 2 === 0) return (x < 0 ? '-' : '') + kept; // tie: keep the even (truncated) candidate
  return s; // odd: toFixed already rounded away from zero, which is the even neighbour
}

/** Python round(x, d) for display (half-even on the exact value, like CPython). */
export function pyRound(x: number, d: number): number {
  return Number(pyFixed(x, d));
}

// Python str.isspace() characters (str.strip() with no argument). JS trim() differs: it strips U+FEFF
// but not \x1c-\x1f or U+0085.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
export const pyStrip = (s: string): string => s.replace(PY_STRIP, '');

const SPLITLINES = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');
/** Python str.splitlines() (no keepends): \r\n is one break; also \v \f \x1c-\x1e \x85 U+2028 U+2029. */
export function pySplitlines(s: string): string[] {
  const parts = s.split(SPLITLINES);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Python str.count(sub) for a non-empty sub (non-overlapping, left to right). */
export const pyCount = (s: string, sub: string): number => (sub ? s.split(sub).length - 1 : s.length + 1);

/** A column-aligned plain-text table (used by crosscheck and bench reports). */
export function textTable(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  return rows.map((r) => r.map((c, i) => c + ' '.repeat(widths[i]! - [...c].length)).join('  ').trimEnd()).join('\n');
}
