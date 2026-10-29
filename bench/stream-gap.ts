function gapsOf(times: number[]): number[] {
  return times.slice(1).map((time, i) => time - times[i]!);
}

function nearestRankP99(gaps: number[]): number {
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.min(gaps.length - 1, Math.ceil(gaps.length * 0.99) - 1)]!;
}

/** P99 of the elapsed time between consecutive chunks observed by one stream. */
export function p99InterChunkGap(times: number[]): number {
  return nearestRankP99(gapsOf(times));
}

/** P99 over the inter-chunk gaps of every stream pooled together (same nearest-rank rule). */
export function pooledP99InterChunkGap(sets: number[][]): number {
  return nearestRankP99(sets.flatMap(gapsOf));
}

export interface TimeInterval { start: number; end: number }

/** Count intervals with a positive-duration overlap with the query interval. */
export function countOverlappingIntervals(query: TimeInterval, intervals: TimeInterval[]): number {
  return intervals.filter((interval) => interval.start < query.end && query.start < interval.end).length;
}
