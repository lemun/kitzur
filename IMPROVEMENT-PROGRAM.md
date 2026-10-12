# Improvement program

Branch: `feat/improvement-program`. Original main: `3f9afb8`.
All four existing folders and ignored data are preserved.

- [x] Coding evaluation: matched minimal tool agent, executable grading, isolated
  workspaces/state, deterministic mock validation, repeat/variation reporting.
  User explicitly deferred live runs due unavailable model capacity; live validation
  remains pending. Future endpoint/model/run-limit instructions are documented.
- [x] Doctor: Luna diagnostics reviewed and CLI integrated; 9 diagnostic/CLI tests.
- [x] Instruction corrections: English/Hebrew expected facts, conservative changes,
  algorithm version bump, budget/pairing/determinism regressions.
- [x] Session report: reviewed aggregation, coverage/accounting and CLI integration.
- [x] Windows implementation: reused `ef3e0ec`, focused fixes and CI/package checks. Windows runner
  execution pending; do not claim Windows validation until executed.

## Decisions and evidence

2026-10-12: read handoff, parent AGENTS and README/DESIGN/CONFIG/SECURITY/
CONTRIBUTING. Astra advised a standalone coding runner with same tool loop in
both arms, client compaction explicitly `none`, paired repetitions, per-attempt
observer accounting, unknown usage coverage, hidden executable graders and
trusted-code security scope. Accepted; mock measurements are not model quality.

Baseline build passed. Sandboxed bounded suite produces network failures.
Focused upstream test with `--test-isolation=none` exposes `listen EPERM` on
loopback; rerun bounded suite outside sandbox with approval. Detailed logs in
`/tmp/kitzur-baseline-unsandboxed.log`: 577 tests, 574 passed, 1 preexisting
wall-clock ReDoS threshold failure, 2 skipped. Focused unchanged ReDoS case passed;
individual regex measurements 1207 ms/951 ms versus 2000 ms threshold. Sandboxed
network failures were environmental, not regressions.

Astra correction advice: additive exclusion before ID deletion, narrow anchored
cancellation/negation cues, no globally relaxed overlap threshold. Preserve
immutable head facts and annotate amendments; bump algorithm version.

First integration: 621 tests, 616 passed, 2 failed, 3 skipped. Both failures were
the existing corr60 correction scenarios: a broad disjoint-ID veto incorrectly
treated presence markers as instruction identities. Astra recommended syntactic
instruction labels (`POLICY-A1:`), keeping shared-ID matching unchanged. Accepted,
added arbitrary-label and English/Hebrew marker regression cases. Engine version
advanced from 3 to 4, then 5 because the version-4 review commit can create cached
plans. Focused ledger/summary/diagnostics checks: 88/88 passed. Final full rerun
in `/tmp/kitzur-integration-final.log`: **626 tests, 623 passed, 0 failed,
3 skipped** (282 seconds, bounded concurrency 2). Skips are two optional Gobstopper
binary comparisons (binary absent) and the actual Windows lifecycle (requires a
Windows runner); no unexpected skips remain.

Mechanical expected-fact comparison against `3f9afb8`: 14/25 correct before,
25/25 after. This is a targeted supersession comparison, not a historical full
engine or model-quality score. Evidence: `bench/coding/examples/retention-comparison.json`.
34 initial retention/invariant checks passed; later focused suite includes the
extra labelled-ID cases. Five coding-harness tests passed, including all fixtures,
wrong grading, post-correction pressure, forced retries, timeouts with prior
compactions, partial/invalid usage and final-response classification. Nine
diagnostics tests passed with explicit unknown-attempt accounting.

Astra diagnostics advice: no buildApp side effects; explicit bounded models
probe only; fixed redacted errors. Report last-forwarded reduction separately
from all-attempt raw counts and final-only usage; exclude local rejects and
separate shadow records; never emit session IDs.

Astra completion reviews approved evaluation, retention, doctor and report within
their documented heuristic/trust/accounting scope; final integration checks now
pass. No release, merge or live endpoint work is authorized.

Final deterministic mock evidence: `bench/coding/examples/mock-report.json`,
engine 5, three tasks × two repetitions × two arms. Kitzur completes 6/6; the
direct arm overflows in 6/6 pressure runs. Direct incomplete totals are not a
savings baseline. Low-pressure tests separately establish both arms can pass;
deliberately wrong solutions fail executable grading.

Windows local evidence: 5 pure deployment tests passed; actual Windows lifecycle
skipped. Final clean package artifacts in `/tmp/kitzur-improvement-final-pack3`:
107 ZIP SHA entries verified, bundled diagnostic docs equal source, engine 5
verified, tokenizer excluded. Staged ZIP and actual offline npm installation
under paths with spaces passed version/config/doctor/report, redaction,
unknown-attempt and hostile-action checks. Manifest SHA256:
`e099964607727a9207c40226aaaa72800290f1c97585bb538ec05e64053e5013`.

## Reviewable increments

- `06cd720`: reuse Windows installation branch commit.
- `bd4a9f6`: Windows packaging, profile/path fixes and Linux/Windows CI.
- `a8b5cd5`: matched coding harness and executable graders.
- `a87d86b`: conservative retention/cancellation rules and regressions.
- `bdbebe4`: doctor and session reports.
- `a44aad3`: labelled-ID integration fix and safe malformed-report handling.
- Final evidence/checklist commit: see branch tip.

## External follow-up

- Run actual Windows CI Node 20/22 and lifecycle checks; until executed, Windows
  validation remains pending. Linux unit/package evidence does not establish it.
- Run real-model paired repetitions using `bench/coding/README.md` after capacity
  becomes available; mock success does not establish comprehension or savings.
- Review the branch for merge. Nothing has been merged, pushed or published.
