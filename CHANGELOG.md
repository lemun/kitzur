# Changelog

All notable changes to Kitzur are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `deploy/verify-bundle.mjs`, shipped in the offline bundle and the Windows ZIP, verifies an extracted bundle on the target with Node.js alone: Node version, archive and per-file checksums, no unlisted or forbidden files, resolvable imports and a CLI smoke test.
- `kitzur doctor` warns when the running Node.js is older than 22 (`runtime.node`), and the README has a compatibility table for Node.js, Windows, macOS and Linux.
- `kitzur doctor` on Windows checks, without administrator rights, whether `listen.port` is in an excluded TCP port range (`windows.port`), whether state, log or config paths sit in a synced folder such as OneDrive (`windows.synced_folder`), and whether the autostart shortcut is installed (`windows.autostart`).
- [docs/JSON-OUTPUT.md](docs/JSON-OUTPUT.md) documents which `--json` keys of `status`, `doctor`, `count`, `state show`, `config validate`, `config show` and `tls-probe` are stable.
- `kitzur replay` and `kitzur count` use the model profile selected by each request's `model` field, as `serve` does, report it as `profile`, and accept `--model ID` to choose a profile.
- Optional `ledger.ranking` orders ledger items within each category using duplicate, error, later-reference and recency signals; `kitzur replay --explain` displays those signals.
- `kitzur replay --explain` prints a readable retention summary with a configurable detail limit.
- After startup metadata discovery returns 401 or 403, make one non-blocking authenticated `/v1/models` retry with the first eligible client's key when no upstream Authorization header is configured.
- `kitzur doctor --snapshot FILE` creates a shareable support snapshot with credentials omitted and hosts and home paths masked.
- Model profiles: an optional `models` map in the config gives each wire model ID (matched exactly) its
  own settings over the root defaults, such as its window, plan size, client limits and tokenizer. Unknown
  IDs use the root defaults with a warning; configs without `models` behave as before. Learned windows
  are kept per model and survive restarts independently.
- Per-model tokenizers are loaded at startup, and `kitzur doctor [--model ID]` checks the tokenizer and
  chat template of each profile (#57, #58).
- `/status` reports per-model counters (`model_counters`: actions, errors and retries), bounded to 64
  models plus an `other` bucket (#58).
- `kitzur doctor --client-config` checks each OpenCode wire model against its own Kitzur profile.
- `kitzur config export-opencode --model ID [--small-model ID]` prints a multi-model `opencode.jsonc`
  generated from the profiles.
- Limits declared by the upstream's `/v1/models` (`max_input_tokens`/`max_prompt_tokens`,
  `max_output_tokens`/`max_completion_tokens`) are read per model: the prompt cap bounds the learned
  maximum prompt, auto-window profiles use the declared window, and a startup warning names any configured
  output limit above the declared output cap.
- Each chat request's log line ends with an `outcome` (`ok`, `aborted`, `incomplete`, `upstream_error`
  or `refused`). Mid-stream failures are detected: the client closing early, a stream that ends without
  `[DONE]`, and an error event after the first chunk.
- `doctor`, `/status` (JSON and `kitzur status`) and the `serve` file log show the resolved config file,
  state directory and log file.
- `kitzur tls-probe [origin] [--ca-file FILE]` inspects the upstream's TLS certificate chain and names the
  failing link: missing intermediate (leaf only), unknown root, self-signed, expired or hostname mismatch,
  with a repair hint.
- `replay` JSON and the stats file record the final retention decisions of each compaction.
- Retention-quality bench scenarios (correction survival, evidence re-read and task acceptance at served
  32k and 64k windows), reported beside the compression ratio.
- `docs/GOBSTOPPER-INTEROP.md` and a synthetic fixture describe importing Kitzur's stats into Gobstopper's
  legacy importer.
- `config show` and `config validate` report every model profile (`--model ID` shows one, and validation
  errors name their model); `/status` lists the profiles and stats records carry a `profile` field.
- Stats records include content-free `retention` counts (`verbatim`, `excerpted`, `summarized`, `dropped`).
- `kitzur redact` copies captured request bodies with every text replaced by same-length filler, so a bug
  report keeps the request's shape and size without its content.
- Opt-in `debug.capture` writes a bounded number of raw upstream responses and the shape of each request
  (authorization redacted) to a new `0600` file, and stops at its request or size budget.
- `kitzur autostart install|remove|status|run` starts Kitzur at Windows login without administrator rights,
  using a Startup-folder shortcut, and refuses to start when the port is already in use.
- `serve` and `doctor` report the upstream's TLS chain and the failing link when verification fails.
- `/status` and `doctor` show the stats writer's dropped-record and write-failure counters (`stats.writer`).
- A documentation site built from the repository docs, with home, benchmarks and compare pages.
- `docs/TROUBLESHOOTING.md` maps symptoms to `doctor` checks and fixes, `docs/UPSTREAM-ROTATION.md` shows an
  external key rotator in front of the upstream, `docs/SETUPS.md` covers solo, shared-server and CI setups,
  and `docs/INTRANET.md` is a checklist for intranet operators.
- Each release ships a CycloneDX SBOM (`npm run sbom`) and `SHA256SUMS` beside the bundles; a version tag
  builds a draft release that a maintainer reviews before publishing.
- Benchmarks: a parallel-streams latency class (does a heavy compaction stall other streams?) and more
  coding-retention fixtures with per-arm pass rates.

### Changed

- Common first-run errors (missing or non-object config file, unknown option, bad `--set`, unknown `--model`, unreadable tokenizer, unwritable `stateDir`) now name the next step to take.
- Model profile validation now suggests allowed keys, explains global settings, and warns about empty or nearly duplicate IDs.
- `kitzur replay --explain` prints a readable table instead of raw JSON.
- `kitzur report` streams the stats file instead of loading it whole, so large logs stay within bounded
  memory. Its coverage section states when history completeness and the dropped-record total are unknown
  (`historyComplete` and `droppedRecords` are `null`).
- README and docs restructured: a first-success 32k path up top, a task-routed docs index, and
  compatibility, retention-limit and evidence tables.

### Fixed

- `kitzur doctor` no longer warns on the default setup: a Kitzur trigger that lands exactly on OpenCode's
  compaction point is accepted, and a 401 or 403 from `/v1/models` counts as reachable. Set
  `KITZUR_PROBE_TOKEN` to send a key with the upstream check only.
- The README's Node.js badge said 20 or newer; it now matches the required Node.js 22.
- An upstream error body is read with a deadline and a 64 KiB cap, so a slow or huge error response cannot
  hold a request open or exhaust memory.
- The stats writer holds at most 1,024 records or 4 MiB while its output is blocked, and counts what it drops.
- A truncated, corrupt or newer-version plan store file no longer breaks startup: damaged records are skipped
  with a warning and the file is left unchanged.
- The warning for a model with no discovered window is remembered for at most 100 model IDs.
- Kitzur's own `x-kitzur-*` response headers can no longer be overridden by headers from the upstream.

## [0.2.1] — 2026-10-19

Requires **Node.js 22 or newer**.

### Changed

- Offline and Windows bundles leave out the README demo images and videos (`docs/assets`),
  reducing download size while keeping the documentation and runtime files (#31).

### Fixed

- `--help` and `-h` print usage for every subcommand, including `doctor`, `bench` and `version`,
  instead of rejecting the option or running the command. Commands that do not read configuration
  no longer show configuration options (#31).
- The configuration-options heading in `doctor --help` now names `doctor`, making clear that
  those options apply to it (#32).

## [0.2.0] — 2026-10-18

Kitzur 0.2.0 requires **Node.js 22 or newer** (`engines.node` is now `>=22`; CI covers Node 22, 24 and 26).
It makes the proxy safer to run unattended, makes compaction visible, and smooths the first run.

### Added

- Visible compaction: a per-request log line, `x-kitzur-*` response headers, and `last_compaction` plus a
  list of recent compactions in `/status`.
- The context window is learned from the upstream (`/v1/models` `max_model_len`, llama.cpp `n_ctx`), with a
  warning when it disagrees with the configured window; `budget.window: "auto"` discovers it per model. `/props` honours a base path, and
  `window_auto_fallback` is warned about once per model.
- Client input-limit budgeting (`client.inputLimit`, `client.reservedTokens`), applied the same way in
  reports and live requests. `kitzur config import-eval` maps OpenCode's `limit.input` and output
  reservation into these settings.
- `kitzur doctor --client-config opencode.json` detects a client that compacts first. `doctor` and
  `config validate` also check that the tokenizer and the chat template match, and `doctor` detects a hung
  instance (served by a new event-loop watchdog).
- An optional client token for the proxy, with a startup warning when `upstream.headers` carries
  credentials and no token is set.
- Request limits: a configurable maximum body size (`listen.maxRequestBytes`), an early `Content-Length`
  check, abort at the limit and correct HTTP status codes, plus a cap on concurrent requests
  (`listen.maxConcurrentRequests`; excess requests get 503 with `Retry-After`).
- First-run polish: `kitzur config init --upstream URL --tokenizer FILE` writes the gateway origin and the
  tokenizer path into the new config (a relative tokenizer path is resolved against the working
  directory), and `scripts/fetch-tokenizer.sh` explains a failed download.
- Config file discovery: without `--config` or `KITZUR_CONFIG`, `serve` and the other config-reading
  commands use `$XDG_CONFIG_HOME/kitzur/kitzur.jsonc` (else `~/.config/kitzur/kitzur.jsonc`, or
  `%APPDATA%\kitzur\kitzur.jsonc` on Windows) when that file exists.
- A macOS launchd template, `deploy/com.github.lemun.kitzur.plist`, documented in `deploy/README.md` and
  shipped in the offline bundle.
- A rewritten README with demos and diagrams.

### Changed

- **Node.js 22 or newer is required** (was 20).
- The server logs to a file and never blocks on its console, so a stalled or closed terminal can no longer
  freeze the proxy.
- Plan persistence is bounded in memory, and saved plans are loaded in fixed-size chunks rather than read
  whole.
- The test suite passes without the development tokenizer, and its timing bounds tolerate a loaded
  machine; the test runner prints a pass/skip summary.

### Fixed

- Browser cross-origin requests are rejected and `OPTIONS` is answered locally, so a web page cannot use
  the proxy or the configured upstream credentials.
- Head+tail truncation never collapses to the truncation notice alone.
- The SSE usage tap recognises keys spelled with JSON `\u` escapes.

### Security

- Cross-origin rejection, the optional client token and the request size limits above harden the proxy
  against use by web pages, other local users and oversized requests. See `SECURITY.md`.

### Removed

- The internal improvement-program work log (`IMPROVEMENT-PROGRAM.md`); its user-relevant results are
  listed under 0.1.0 below.

## [0.1.0] - 2026-10-12

### Added

- The compaction proxy: an OpenAI-compatible Chat Completions proxy that compacts the request history to
  fit the served context window, deterministically and without a summarizer model.
- Presets for 32k, 64k, 100k and 128k windows; JSONC configuration with `config init|show|validate` and
  `config import-eval` for gateway probe results.
- A systemd user service and an offline bundle (`scripts/pack-offline.sh`).
- Windows per-user installation, login startup, graceful stop and diagnostics, validated in CI on
  Node 20 and 22.
- `kitzur doctor` (read-only setup diagnostics) and `kitzur report` (aggregate request stats, sizes only).
- A coding-task evaluation harness with executable graders (`bench/coding`).
- Retention of additive instructions and conservative recognition of instruction cancellations.

[Unreleased]: https://github.com/lemun/kitzur/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/lemun/kitzur/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lemun/kitzur/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lemun/kitzur/releases/tag/v0.1.0
