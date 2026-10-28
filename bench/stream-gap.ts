/** P99 of the elapsed time between consecutive chunks observed by one stream. */
export function p99InterChunkGap(times: number[]): number {
  if (times.length < 2) return 0;
  const gaps = times.slice(1).map((time, i) => time - times[i]!);
  gaps.sort((a, b) => a - b);
  return gaps[Math.min(gaps.length - 1, Math.ceil(gaps.length * 0.99) - 1)]!;
}
