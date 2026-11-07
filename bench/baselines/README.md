# Planner performance baseline

`engine-perf.json` is the baseline of `bench/perf-baseline.ts`: the compaction planner run in process with the
estimate counter (no tokenizer, no network, no listener) over deterministic synthetic coding-agent histories (the
seeded fuzz chains of `bench/fuzz/gen.ts`, concatenated, contents cut to 2 KB) at about 200, 1000 and 4000
messages and the 32k and 100k presets, about 40 evenly spaced requests per case. It is separate from the published-numbers golden test, and not part of `npm test` or CI.

It protects:

- **Planner output**: per case, the last request's tokens in and out, compactions, retention outcome counts and the
  request count. Any difference fails. If the change was meant to alter compaction, refresh the baseline in it.
- **Planner cost**: `relCost`, the median engine time of 5 runs divided by a fixed CPU-bound loop timed in the same
  process, so the figure is machine-relative, not milliseconds. A case fails above +50%. The band is deliberately
  loose: it catches algorithmic slowdowns, not noise. A faster result never fails.

Run `npm run bench:perf` (build, then `--check`; about ten minutes). Refresh on a quiet machine with
`npm run build && node dist/bench/perf-baseline.js --update` (refused when `CI=true` is set) and commit the file,
which holds sorted keys, the date and the numbers only, with the change that explains it.
