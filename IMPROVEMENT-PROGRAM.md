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
- [x] Windows implementation: reused `ef3e0ec`, focused fixes and CI/package checks. Windows Node 20/22
  portable, packaged CLI and actual installation/lifecycle checks passed in GitHub CI.

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

- `32874e3`: reuse Windows installation branch commit.
- `7c39df6`: Windows packaging, profile/path fixes and Linux/Windows CI.
- `2683fb0`: matched coding harness and executable graders.
- `a17b923`: conservative retention/cancellation rules and regressions.
- `3c33b48`: doctor and session reports.
- `8438f4a`: labelled-ID integration fix and safe malformed-report handling.
- Final evidence/checklist commit: see branch tip.

## External follow-up

- Windows CI Node 20/22 and actual lifecycle validation completed successfully;
  linked remote results below provide platform evidence.
- Run real-model paired repetitions using `bench/coding/README.md` after capacity
  becomes available; mock success does not establish comprehension or savings.
- Review draft PR #3 for merge: https://github.com/lemun/kitzur/pull/3.
  The branch is pushed for review; no merge or release has been performed.

## Remote validation follow-up

2026-10-12: user authorized branch review/push and GitHub CI. GitHub blocked
the first push under its private-email protection. Original commits were preserved
locally under `backup/improvement-program-before-email-privacy`; unpublished
author/committer email headers were normalized to the account's GitHub noreply
address with identical file trees, messages and dates. Review commit hashes above
now refer to the pushed history. Repository-local email uses that noreply address
for future commits. Email privacy protection was kept enabled.

Draft PR: https://github.com/lemun/kitzur/pull/3. PR CI run:
https://github.com/lemun/kitzur/actions/runs/38239225527. Duplicate push-event CI
was cancelled; the PR run validates Linux Node 20/22, packaging, and Windows
Node 20/22.

First remote run passed Linux Node 20/22 and packaging. Windows portable suites
found checkout CRLF conversion of the byte-exact upstream template. Converting the
committed template to CRLF reproduced the failing hash exactly. Commit `7a3f74d`
pins only that template to LF via `.gitattributes`; an isolated Windows-style Git
checkout and the unchanged golden assertion passed.

Second PR run: https://github.com/lemun/kitzur/actions/runs/38239852124.
Linux Node 20/22, packaging and Windows portable suites passed. Both Windows
lifecycle tests reached installation and exposed PowerShell 7 module-path
inheritance through Node into Windows PowerShell 5.1 (`Get-FileHash` unavailable).
Microsoft documents this intermediate-process behavior and recommends removing
`PSModulePath` from the child environment so Windows PowerShell restores native
module paths: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6.
Commit `e313d8c` adds a narrow cloned child-environment helper that removes only
case-insensitive `PSModulePath` entries for Windows PowerShell children. Parent
environment, certificate settings, execution policy and checksum verification are
unchanged. Local focused tests passed (6 pure tests, Windows lifecycle skipped on
Linux). Actual lifecycle now verifies native `Get-FileHash`, two manual-startup
installs, and an installed-manager startup-enabled reinstall under the actual
inherited PowerShell 7 module directories. Astra reviewed this process-environment
choice and regression coverage.

Third PR run: https://github.com/lemun/kitzur/actions/runs/38245119653.
The module fix advanced installation on Node 22; the installer then revealed that
`Get-Command node` can return multiple executable matches on PATH. Its collection
of Source paths was incorrectly invoked as one executable. Node 20's native module
probe hit its 10-second cold-start timeout in the PR run; the duplicate push run
passed that probe and reproduced the same multiple-Node-path failure.

Commit `2f6b1b4` selects the first application match, preserving PATH precedence.
The lifecycle asserts `node-path.txt` matches the active matrix Node before any
direct-Node reinstall could mask selection. The native diagnostic probe now uses
the same bounded 60-second allowance as other PowerShell calls.

Final runtime CI: https://github.com/lemun/kitzur/actions/runs/38245999885,
head `2f6b1b415820fb2f71ae153b1b584b8a22b85e46`. All five jobs passed:
Linux Node 20 and 22, clean packaging, Windows Node 20 and 22. Each Windows job
passed **241 portable tests and 7 deployment tests, with zero skips or failures**.
The actual lifecycle verifies native module loading, trusted-manifest installation,
configuration-preserving reinstall, installer startup registration, active Node
selection, exact-tokenizer background startup, repeated start/status, proxied
synthetic Chat Completions, redacted diagnostics, isolated shortcut arguments,
graceful stop and uninstall retaining configuration.

Both push- and PR-triggered workflows are retained for the final source revision.
The checklist/doc-only follow-up records already-passed runtime evidence; live
model evaluation remains the only deferred evaluation step.

Astra independently reviewed the successful Windows logs and final source changes
and approved Windows completion for runtime commit `2f6b1b4`. This establishes
the tested per-user installation/lifecycle on GitHub Windows runners; it does not
establish every Windows deployment environment or real-model task quality.
