# Next phase: representative coding evaluation

Status: **queued; implementation and local validation may proceed now**. Only live
endpoint/model runs are deferred until adequate hardware and model capacity are
available and the target clients can be run reproducibly. This queue does not
authorize paid-model calls, and no automatic scheduler is configured.

The current harness in [bench/coding/README.md](bench/coding/README.md) is useful
for controlled paired proxy/direct runs, but its one-file task surface and
`client compaction: none` setting do not answer whether Kitzur helps on realistic
multi-file sessions or alongside a native coding client. The existing proxy
counting path also documents a generic-template estimate limitation. The work
below expands that evidence without treating mock outcomes as model quality.

## Roles and review

- **Sol — implementation and validation lead.** Own the harness and task changes,
  run deterministic/local checks, record environment and artifacts, and report
  unresolved limitations.
- **Astra — hard decisions and final review.** Resolve methodological disputes
  (fairness, scoring, counting, attribution), challenge the interpretation, and
  give the final review before results are described as evidence.
- **Luna — bounded work, reviewed by Sol.** Take scoped documentation, fixture,
  or analysis tasks with explicit acceptance criteria. Sol reviews and integrates
  each contribution; Luna does not independently broaden scope or run live models.

## Queue

### 1. Lock tokenizer and template controls

**Work:** Define reproducible counting settings for every arm and client: model
tokenizer identity and revision/hash, chat-template profile and source, tool
rendering, image/reasoning treatment if applicable, and whether counts are exact,
estimated, or server-reported. Capture client and proxy versions and relevant
configuration in each report. Keep estimated counts visibly distinct from exact
counts. Document how a native client's compaction affects the request observed by
Kitzur and how that is measured.

**Dependencies:** identify candidate model/tokenizer assets and native clients
with their supported compaction controls; Astra settles counting and attribution
rules before results are collected. Local implementation and fixture-based
validation do not require a live target server.

**Acceptance:** a clean checkout can reproduce the settings from a checked-in
manifest recording effective counting mode, tokenizer content hash, template
identity/options/hash, model, and context window. Exact mode fails when requested
assets are absent or mismatched; it never silently falls back while claiming an
exact count. All arms use the same underlying model, limits, task inputs, and tool
capabilities. Reports distinguish local rendered counts from provider-reported
accounting, and call out discrepancies that may come from hidden provider/client
wrappers. Sol and Astra review the manifest and a dry-run report.

### 2. Document and lock the correction baseline

**Work:** Add English and Hebrew correction fixtures that cover the current
heuristics and their limits: explicit labelled IDs, additive updates, cancellation,
negation, questions, quotations, presence markers, ambiguous targets, Hebrew
cues/morphology, and corrections that arrive while an old summary remains in the
verbatim-prefix epoch. State which cases are guaranteed by regressions and which
remain heuristic or unsupported. Avoid implying semantic understanding.

**Dependencies:** current correction rules and tests are reviewed. A language
reviewer checks Hebrew wording and expected interpretation; Astra reviews any
proposed behavior change.

**Acceptance:** each regression names the input, expected retained/superseded
facts, and reason, including positive and negative examples; immutable head facts,
repeated compaction, and multilingual punctuation are covered. English and Hebrew
cases run through the focused suite; docs
match actual engine behavior and identify known misses. Any engine behavior change
gets its own narrow cue/identity rationale and review increment, with tool pairing,
budget, and determinism checks. Do not relax overlap thresholds or suppress
disjoint IDs broadly to make a case pass. Include required algorithm
versioning, rather than being silently bundled into documentation. Freeze this
baseline before adding larger scenarios or comparing native compaction.

### 3. Add multi-file task scenarios and grading

**Work:** Extend the coding harness with representative tasks that require reading
and changing multiple related files, running project checks, and responding to a
correction after work has begun. Include at least one task with cross-file behavior
and one with a delayed English or Hebrew instruction correction. Keep graders
hidden from the model-facing tool surface and grade exported behavior, tests, and
input preservation rather than marker presence. Hash task inputs and graders for
reproducibility. Exercise allowed-path checks for read, write, and list operations,
including traversal and symlink attempts; retain the documented trusted-code
scope because generated code is not OS-sandboxed.

**Dependencies:** task repositories/fixtures can be isolated and reset; task
authors define objective executable graders; queue items 1 and 2 have fixed the
counting metadata and correction baseline. First validate with deterministic
mock agents.

**Acceptance:** each task has a documented intent, setup, allowed file surface,
input/grader hashes, grader, expected baseline behavior, and failure cases;
repeated mock runs prove workspace reset, grader isolation, correction delivery,
read/write/list path defenses (including symlinks), and report completeness; at
least one intentionally incorrect multi-file solution fails. Document that this
isolation is not an OS security sandbox. No live-model quality claim is inferred
from these checks.

### 4. Compare against native-client compaction

**Work:** Select and pin an actual native coding client and version, and verify
that its native compaction invokes its real model summarizer. Compare direct use
with client-native compaction against Kitzur in front of that same client with its
native compaction enabled. An optional no-client-compaction arm is a diagnostic
control. Use the same model endpoint, budgets, tasks, and repetitions across arms. Record
client compaction events, request/response accounting, task completion, executable
grade, retries, and per-attempt usage coverage, including summarizer calls and
retry usage. Pair task/repetition order and preserve every sample; do not compare
partial runs as token savings.

**Dependencies:** selected client/version exposes repeatable settings and can
target a chosen server; its real summarizer can be attributed and measured;
items 1–3 establish the counting/attribution contract, correction baseline, tasks
and graders; hardware/capacity for the later live phase. The existing
`bench/opencode-sim` is a scripted simulation and does not satisfy the native
client requirement. If a client cannot expose or disable a behavior needed for
matching, document it and omit that comparison.

**Acceptance:** harness tests establish arm parity and client compaction recording;
mock runs establish the path and report schema; a written protocol specifies
paired repetitions, stopping rules, exclusions, and analysis before any live run.
Reports include native summarizer and retry calls in usage coverage and incomplete
totals, with unknowns kept unknown.
Live results require adequate hardware, capacity, and a separate explicit go-ahead
at execution time. Report task success and token/accounting outcomes separately,
including uncertainty and all incomplete samples.

### 5. Later, optional: Responses and Anthropic support

**Work:** Consider OpenAI Responses and Anthropic Messages adapters only after
there is a confirmed target-client need and a written dialect contract. Assess
request/response and streaming semantics, tool-call/result pairing, usage and
overflow reporting, counting/template support, passthrough behavior, and parity
with current guards before implementation is proposed.

**Dependencies:** named target clients and real use cases are confirmed; primary
protocol contracts and representative captured fixtures are available; scope and
compatibility decisions are reviewed by Astra. This item is optional and is not
required to complete the evaluation phase.

**Acceptance:** first deliver a reviewed compatibility proposal with explicit
supported/unsupported semantics and tests needed. Implementation is a separate
decision and work item; do not advertise support based on an adapter sketch or
mock-only protocol coverage.

## Exit criteria for the evaluation phase

The phase can be called complete when items 1–4 have reviewed artifacts, all
deterministic harness checks pass, the protocol and limitations are documented,
and any live study is either executed under its separate explicit execution
authorization or remains clearly marked deferred. Do not schedule, trigger, or
imply future automatic endpoint/model runs.
