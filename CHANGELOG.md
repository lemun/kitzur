# Changelog

All notable changes to Kitzur are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
