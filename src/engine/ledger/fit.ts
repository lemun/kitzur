// The "longest prefix that fits" search used by the summary renderer and snapshot slimming.

/**
 * The largest k in [lo, hi] with fits(k), assuming fits is monotone (true up to some k*, false after) and
 * fits(lo) holds (the caller checks it). `guess` seeds a galloping search, so a good estimate costs about two
 * probes and a bad one O(log n). Each probe is an exact count, so this keeps the count calls few.
 */
export function maxFitting(lo: number, hi: number, guess: number, fits: (k: number) => boolean): number {
  if (hi <= lo) return lo;
  let g = Math.min(hi, Math.max(lo, guess));
  let good = lo; // fits(good) is known true
  let bad = hi + 1; // fits(bad) is known false (hi + 1 = sentinel)
  if (g > lo) {
    if (fits(g)) good = g;
    else bad = g;
  }
  if (bad === hi + 1) {
    // gallop up from `good`
    let step = 1;
    while (good + step <= hi) {
      const k = good + step;
      if (fits(k)) {
        good = k;
        step *= 2;
      } else {
        bad = k;
        break;
      }
    }
    if (bad === hi + 1) return good;
  } else {
    // gallop down from `bad`
    let step = 1;
    while (bad - step > good) {
      const k = bad - step;
      if (fits(k)) {
        good = k;
        break;
      }
      bad = k;
      step *= 2;
    }
  }
  while (bad - good > 1) {
    const mid = good + Math.floor((bad - good) / 2);
    if (fits(mid)) good = mid;
    else bad = mid;
  }
  return good;
}
