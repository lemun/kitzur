# Changelog

All notable changes to Kitzur are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `kitzur config init --upstream URL --tokenizer FILE` writes the gateway origin and the tokenizer path
  into the new config (a relative tokenizer path is resolved against the working directory).
- Config file discovery: without `--config` or `KITZUR_CONFIG`, `serve` and the other config-reading
  commands use `$XDG_CONFIG_HOME/kitzur/kitzur.jsonc` (else `~/.config/kitzur/kitzur.jsonc`, or
  `%APPDATA%\kitzur\kitzur.jsonc` on Windows) when that file exists.
- A macOS launchd template, `deploy/com.github.lemun.kitzur.plist`, documented in `deploy/README.md` and shipped in the offline bundle.
- The context window is learned from the upstream (`/v1/models` `max_model_len`, llama.cpp `n_ctx`), with a
  warning when it disagrees with the configured window.
- Client input-limit budgeting (`client.inputLimit`, `client.reservedTokens`), applied the same way in
  reports and live requests; `kitzur config import-eval` maps OpenCode's `limit.input` and output reservation.
- `kitzur doctor --client-config opencode.json` detects a client that compacts first; `doctor` and
  `config validate` check that the tokenizer and the chat template match.
- Visible compaction: a per-request log line, `x-kitzur-*` response headers, and `last_compaction` plus a
  recent list in `/status`.
- An optional client token for the proxy, with a startup warning when `upstream.headers` carries
  credentials and no token is set.
- Request limits: a configurable maximum body size, an early `Content-Length` check, abort at the limit and
  correct status codes.
- An event-loop watchdog; `doctor` detects a hung instance.

### Changed

- The server logs to a file and never blocks on its console.
- Plan persistence is bounded.

### Fixed

- Browser cross-origin requests are rejected and `OPTIONS` is answered locally, so a web page cannot use
  the proxy or the configured upstream credentials.
- Head+tail truncation never collapses to the truncation notice alone.
- `/props` honours a base path; `window_auto_fallback` is warned about once per model.
- The SSE usage tap recognises keys spelled with JSON `\u` escapes.

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

[Unreleased]: https://github.com/lemun/kitzur/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lemun/kitzur/releases/tag/v0.1.0
