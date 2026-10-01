// Timing summaries. Timing is never part of the deterministic results (bench/README.md§15): it goes in a separate
// `timing` object of a results file and in its own report section, so `bench verify` can diff the rest byte for byte.

export interface Dist {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

/** Nearest-rank percentile of a sample (p in [0, 100]); null for an empty sample. */
export function pct(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1]!;
}

export function dist(xs: readonly number[]): Dist {
  const r = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);
  return {
    n: xs.length,
    p50: r(pct(xs, 50)),
    p90: r(pct(xs, 90)),
    p99: r(pct(xs, 99)),
    max: r(xs.length ? Math.max(...xs) : null),
    mean: r(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null),
  };
}

export interface RunTiming {
  wallMs: number;
  /** per client step round-trip, as the client measured it */
  stepMs: Dist;
  /** system process wall time, when the system reports one */
  systemMs: number | null;
  startedAt: string;
}

export function runTiming(wallMs: number, stepMs: readonly number[], systemMs: number | null, startedAt: Date): RunTiming {
  return { wallMs: Math.round(wallMs), stepMs: dist(stepMs), systemMs, startedAt: startedAt.toISOString() };
}
