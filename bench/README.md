# Benchmarks

These are **simulated sessions with a mock server**. Scripted clients submit
browser-automation, code-editing and stress scenarios with planted facts. The mock
counts rendered prompts and returns scripted completions. OpenCode comparisons
simulate its compaction mechanics with placeholder summaries; they do not measure
an LLM's summarization quality or real task success.

## Run locally

```sh
npm ci
scripts/fetch-tokenizer.sh
npm run build
# A self-contained kitzur run; no gobstopper or Python required:
node dist/bench/run-all.js --phases matrix,report --only 'kitzur/*/100k' --workers 2
# A single scenario across selected systems:
node dist/bench/pool.js --systems kitzur --scenarios qa46 --windows 32k
# Full suite (comparisons require the optional inputs below):
npm run bench -- --snapshot --resume
```

Results go to ignored `bench/results/`; the generated report is the ignored root
`BENCHMARKS.md`. Full generated results and archives do not ship; the small README demonstration
excerpt is committed under `bench/examples/`. The `qa46`/`qa46-ref`
scenario IDs identify synthetic 46-step browser sessions, not captured user sessions.
The main README uses measurements from the public inputs. Historical comparison
figures below predate marker and scenario sanitation.

## README demonstration

The main README shows a fresh `qa46-ref` run at 100k/32k, measured October 2, 2026.
[The committed evidence](examples/readme-qa46.json) contains the three systems'
configuration, source and tokenizer hashes, metrics, fact checks and per-request
counts. It excludes request bodies and machine-dependent timings. This is a
synthetic scenario, not a recording of a real user or a real-model evaluation.

After installing dependencies and fetching the development tokenizer:

```sh
npm run build
node dist/bench/pool.js --systems kitzur,opencode-sim-compat,direct \
  --scenarios qa46-ref --windows 100k --workers 1 --keep-bodies
```

The harness starts isolated local mock servers and proxy processes. It needs
permission to listen on loopback. No model server or Gobstopper installation is
needed. Generated results remain under ignored `bench/results/`.

The session table uses main-request prompt counts at zero-based steps 0, 10, 22
and 45, displayed as steps 1, 11, 23 and 46. The direct arm stops after its first
rejection; later entries are deliberately absent. The full-session reduction is
`1 - 1,710,787 / 2,492,849 = 31.4%`, comparing Kitzur with the completed offline
OpenCode simulation. It includes all upstream attempts and auxiliary requests.
The direct arm's smaller total covers an incomplete session and is not a savings
baseline. The seven Kitzur fact checks all pass; the offline comparator does not
evaluate facts. Passing those checks establishes marker retention, not comprehension.

## Historical Gobstopper comparison

These older `qa46-ref` 100k/32k figures were transcribed from the pre-release
benchmark report. They use inputs from before marker renaming and scenario text
sanitation, so they must not be mixed with the fresh README measurements.

| System | Prompt tokens, all attempts | Compactions | Planted facts retained |
|---|---:|---:|---:|
| OpenCode compaction mechanics (offline simulation) | 2,492,784 | 6 | Not evaluated |
| gobstopper v0.7.2, tuned | 1,734,118 | 7 | 4/7 |
| kitzur predecessor, defaults | 1,710,746 | 7 | 7/7 |

Gobstopper used `--threshold 58000 --keep-recent 2 --carry-max-chars 40000`;
tool outputs were capped at 51,200 bytes. These are historical measurements of
simulated sessions with a mock server, not a comparison against current Gobstopper
or a real-model quality evaluation. At 32k, the historical Kitzur run used fewer
total tokens but had worse prefix reuse than the OpenCode comparator; no universal
cache-performance advantage is claimed.

## Optional comparisons

For gobstopper comparisons, build [gobstopper v0.7.2](https://github.com/hraness/gobstopper)
separately and set `KITZUR_GOBSTOPPER_BIN` to its executable. Rust is required to
build gobstopper, but is not required by kitzur.

```sh
export KITZUR_GOBSTOPPER_BIN=/path/to/gobstopper
node dist/bench/run-all.js --quick
```

The optional Python parity cross-check uses the independent reference code in
`bench/reference/sim/`. It needs Python, a virtual environment with `tokenizers`
and the same tokenizer as the TypeScript harness:

```sh
python -m venv bench/reference/venv
bench/reference/venv/bin/pip install tokenizers==0.23.2 jinja2
mkdir -p bench/reference/tok
cp bench/.cache/Qwen3.6-27B-tokenizer.json bench/reference/tok/Qwen_Qwen3.6-27B.json
export KITZUR_REF_DIR="$PWD/bench/reference"
export KITZUR_GOBSTOPPER_BIN=/path/to/gobstopper
npm run crosscheck
# Only the direct and OpenCode baseline cases:
node dist/bench/crosscheck.js --cases c,d
# Disable the optional Python side:
node dist/bench/crosscheck.js --no-python
```

An external reference layout can also be selected with `KITZUR_REF_DIR`; it must
contain `sim/*.py`, `venv/bin/python`, `tok/Qwen_Qwen3.6-27B.json` and a writable
`runs/` directory. Use matching sanitized scenario text on both sides.
`KITZUR_BENCH_TOKENIZER` overrides the tokenizer location; it otherwise falls back
to `KITZUR_TEST_TOKENIZER` and then the development cache. Optional
`KITZUR_EVAL_RESULTS` points to external reference result files for comparison.

## Systems and scenarios

| System ID | Behavior |
|---|---|
| `direct` | Scripted client directly against the mock |
| `opencode` | Simulated OpenCode HTTP client, truthful context/output limits |
| `opencode-sim`, `opencode-sim-compat` | Offline OpenCode mechanics, long/short continuation text |
| `gobstopper-default` | gobstopper v0.7.2 defaults |
| `gobstopper-tuned` | Scaled threshold, `--keep-recent 2 --carry-max-chars 40000` |
| `kitzur`, `opencode-kitzur` | Scripted client or OpenCode simulation through kitzur |
| `kitzur-<ablation>`, `kitzur-sweep-*` | Individual policy ablations and configuration sweep |

Scenarios cover browser sessions, long assistant replies, code edits, huge tool
outputs, Hebrew, reasoning, parallel calls, session interleaving, user corrections,
client compactions, server error formats, missing usage, proxy restarts and prompts
that cannot fit. Context/output pairs are 32k/8k, 64k/16k, 100k/32k and 128k/32k.

Each matrix cell has a content-derived run key containing the code version, config,
scenario, window and tokenizer hash. Workers isolate state and stats per run.
`--snapshot` freezes compiled benchmark code during long runs.

| Option | Effect |
|---|---|
| `--quick` | Reduced selection of scenarios and comparators; skips cross-check |
| `--phases crosscheck,matrix,ablations,sweep,fuzz,latency,report` | Select phases |
| `--only 'system/scenario/window'` | Glob filter for matrix phases |
| `--tier T1,T2,T3` | Matrix, ablations, sweep |
| `--workers N` | Bound worker concurrency |
| `--resume` | Reuse results with matching run keys |
| `--keep-bodies` | Retain request bodies in local result directories |
| `--prune` | Move stale cells under the ignored raw-results directory |

## Metrics and interpretation

Processed prompt tokens include accepted and rejected upstream requests, including
simulated summarizer/title requests. Prefix hit rate is the sum of token longest
common prefixes divided by accepted prompt tokens. Reports also show uncached tokens,
fresh content and repeated prefill: a better hit ratio alone does not imply less work.

Fact checks test presence, latest values and whether superseded facts reappear.
They measure mechanical retention, not comprehension. Pairing checks verify that
retained calls and results remain compatible. Client errors include HTTP failures,
in-stream errors, incomplete streams and unusable length-limited completions.

The report computes gates for completion, facts, token cost, prefix reuse, large
outputs, recovery, latency, small windows, fuzz invariants and restart equivalence.
A missing comparator or phase is `NOT RUN`, never `PASS`. Historical numerical
reference targets describe earlier inputs; parity with matching current Python
inputs is the independent correctness check.

## Golden fixtures

Committed `.json.gz` and `.jsonl.gz` files hold synthetic text and expected results;
they are compressed data, not executables or tokenizer distributions. The Python
reference and `tokenizers` provide independent expected counts and hashes.

```sh
bench/reference/venv/bin/python scripts/tokenizer/regenerate-fixtures.py
# Qwen template corpus (after building):
node dist/bench/mock/qwen3-corpus.js bench/.cache/qwen-corpus.json
bench/reference/venv/bin/python bench/mock/make-qwen3-goldens.py \
  bench/.cache/qwen-corpus.json bench/.cache/Qwen3.6-27B-tokenizer.json \
  test/fixtures/bench/qwen3-render.json.gz
```

Other focused generators live under `scripts/tokenizer/`. Generated tables preserve
upstream notices in `LICENSES/`. See `test/` for the corresponding assertions.
