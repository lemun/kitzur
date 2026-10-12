# Coding task evaluation

This runnable harness compares the same minimal tool agent directly with a Chat
Completions endpoint and through a fresh Kitzur proxy. Both use identical model,
temperature, output limit, tools, turn/time limits and **client compaction: none**.
Task order is fixed; arm order alternates across repetitions. Each run gets a fresh
workspace, learned state, plan cache and stats file. Initial histories are synthetic
long histories corresponding to the actual initial source file. Corrections arrive
after the first live tool turn, identically in both arms.

The fixtures cover English corrected requirements, Hebrew cancellation and tool
output pressure. Hidden executable acceptance checks grade exported behavior and
input preservation. They do not grade marker presence. File tools can only access
`solution.mjs`; they reject other paths and symlinks. Public `run_tests` checks
syntax only. A model's final response ends the run; hitting a turn/time/output limit
is incomplete, even if partial source happens to pass some checks.

## Local deterministic verification

```sh
npm run build
node --test --test-concurrency=2 dist/test/coding/evaluation.test.js
node dist/bench/coding/run.js --mock --repeats 2 --out /tmp/coding-mock.json
node dist/bench/coding/retention.js 3f9afb8 > /tmp/correction-comparison.json
```

The mock writes real source files and exercises the same HTTP/tool/grading path.
Mock outcomes verify the harness; they establish no real-model usefulness. Live
model validation is pending until model capacity becomes available.

## Future real runs

```sh
export KITZUR_EVAL_ENDPOINT='https://your-endpoint/v1/chat/completions'
export KITZUR_EVAL_API_KEY='your-key'
node dist/bench/coding/run.js --model your-model --repeats 3 \
  --window 32000 --output-tokens 2048 --max-turns 12 --timeout-ms 120000 \
  --pressure-chars 60000 --post-pressure-chars 12000 --out /tmp/coding-live.json
```

No live call occurs with `--mock`. Endpoint credentials stay in memory and are
never put in reports or child test environments. Use a model/endpoint with a real
context limit matching `--window`; the proxy currently uses conservative estimated
counting with the generic template, which is recorded as a harness limitation.
There is no automatic live fallback or default paid endpoint.

An observer records every upstream attempt, including recovery attempts, status,
body bytes, latency and server-reported prompt/completion usage. Missing usage is
`null`, with a coverage count, never silently zero. Per-run totals are unknown if
any attempt lacks usage. Overflow/timeout/harness error/incomplete runs remain
distinct from completed passing/failing runs. Reports include all per-run samples
to show variation; compare paired task/repetition outcomes. Do not compare partial
direct totals with complete proxy totals as savings. Request reduction and reported
usage are not automatically billing savings.

`--post-pressure-chars` adds synthetic diagnostic noise to tool results after the
correction, identically in both arms, so later compactions exercise correction
retention. The detailed original rule is a non-head user message. Reports record
post-correction compactions and mock prompt checks for the current/obsolete rule;
the previous summary can retain an old rule until the next compaction, while the
new correction remains in the verbatim tail. A first-turn final answer receives
the delayed correction and must continue before it can complete.

The separate retention comparison runs independently specified English/Hebrew
expected facts through the historical and current correction algorithms. It
reports exact per-case retained/superseded outcomes, not a model quality score.
This targets the supersession module; it uses the current unchanged configuration,
sentence splitting and stop words rather than replaying a full historical engine.
It requires the development TypeScript package and the selected local Git revision.

## Trust and isolation

This is a **trusted-code evaluation harness**, not an OS security sandbox. Task
workspaces and tool paths are isolated, but model-generated JavaScript runs in a
Node child process and could access the machine or network if malicious. Run live
evaluations in an expendable container/VM with no private files or credentials
before evaluating untrusted models. The grader's source is outside the writable
file-tool surface, but this does not stop malicious code from probing the OS.
The child environment is minimal and has no endpoint key. Temporary artifacts are
left for inspection under the system temp directory; the harness never deletes
existing project folders.
