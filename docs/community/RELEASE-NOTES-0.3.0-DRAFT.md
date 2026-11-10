**DRAFT**: GitHub release text for maintainer review. Nothing is published and the version is not bumped.

# Kitzur 0.3.0

## Summary

Kitzur 0.3.0 lets one proxy serve several models with their own settings, and makes each request's outcome, the upstream's TLS chain and the retention decisions visible. It also adds non-admin Windows autostart, support tools that keep request content out of bug reports, and checksums plus an SBOM for every release asset.

## Highlights

- **Model profiles.** An optional `models` map gives each exact wire model ID its own window, plan size, client limits and tokenizer over the root defaults; try `kitzur config init --model ID=WINDOW --dry-run`, then `kitzur config show --model ID`.
- **Request outcomes.** Each chat request's log line ends with an `outcome` (`ok`, `aborted`, `incomplete`, `upstream_error` or `refused`), and a client closing early, a stream ending without `[DONE]` or an error after the first chunk is detected; `kitzur status` shows the outcome counts.
- **TLS chain reports.** `kitzur tls-probe [origin] --ca-file FILE` names the failing link of the upstream's certificate chain with a repair hint, and `serve` and `doctor` report the same when verification fails.
- **Windows autostart without administrator rights.** `kitzur autostart install` adds a Startup-folder shortcut, and `kitzur autostart status` and `kitzur autostart remove` check and undo it.
- **Retention explanations and support bundles.** `kitzur replay --explain` prints a readable table of what each compaction kept, excerpted, summarized or dropped (`--explain-limit N` sets the detail), `kitzur doctor --snapshot FILE` writes a shareable snapshot with credentials omitted and hosts and home paths masked, and `kitzur redact <file|dir>` replaces every captured text with same-length filler.
- **Opt-in upstream retry.** With `upstream.retry.enabled` set, a 429, 502, 503 or 504 that arrives before any response byte is repeated after a capped backoff that honours `Retry-After`; it is off by default. Non-chat paths listed in `upstream.retry.paths` are retried too, `/status` reports the totals in `transient_retries`, a retried request's stats record carries `transient_retries` and `transient_retry_delay_ms`, and `kitzur status` shows an `Upstream retries` line. [examples/config/flaky-gateway-retry.jsonc](../../examples/config/flaky-gateway-retry.jsonc) is a ready-to-copy starting point.

* `kitzur doctor` checks the opt-in retry settings (`upstream.retry`): it warns when the retry is on but can never retry, and sums up its limits when it can.
* `kitzur doctor` warns when the running Node.js is older than 22 (`runtime.node`).
* `kitzur doctor` on Windows checks, without administrator rights, for a `listen.port` in an excluded TCP port range (`windows.port`), state, log or config paths in a synced folder such as OneDrive (`windows.synced_folder`) and the autostart shortcut (`windows.autostart`).
* New guides: a [security review checklist](../SECURITY-REVIEW.md) for teams that vet Kitzur before allowing it on an internal network, [ready-to-copy example configs](../../examples/config/README.md) and the [JSON output guide](../JSON-OUTPUT.md) listing the stable `--json` keys.
* `kitzur config init --dry-run` prints the target path, the config text and the next steps without creating anything.
* `--set` and `KITZUR_SET` can set one model profile's leaf, for example `models["<id>"].budget.window=64000`.
* `kitzur replay` and `kitzur count` use the model profile selected by each request's `model` field, as `serve` does, and accept `--model ID` to choose one.

## Upgrade notes

No manual step is needed: configs without `models` behave as before, and Node.js 22 or newer is still required.

Behaviour changes:

- `kitzur status` prints readable groups (uptime, warnings, per-model budgets, outcome counts); scripts should keep using `kitzur status --json`, which is unchanged.
- `kitzur replay --explain` prints a table instead of raw JSON.
- `kitzur report` streams the stats file; `historyComplete` and `droppedRecords` in its coverage section can now be `null` when they are unknown.
- `kitzur doctor` no longer warns on the default setup, and a 401 or 403 from `/v1/models` counts as reachable. Set `KITZUR_PROBE_TOKEN` to send a key with the upstream check only.
- A damaged or newer-version plan store file no longer breaks startup: damaged records are skipped with a warning and the file is left in place. `kitzur state reset --plans` removes it.
- Kitzur's own `x-kitzur-*` response headers can no longer be overridden by the upstream.
- Common first-run errors now name the next step to take.
- `kitzur state reset` moves a damaged `learned.json` aside as `learned.json.corrupt` instead of failing.
- Legacy `/v1/completions` prompts are now counted (`legacyCompletions.count`): the answer carries `x-kitzur-action` and `x-kitzur-tokens` headers, and `/status` counts `legacy_completions` and `legacy_over_budget`, also shown as a `Legacy completions` line in `kitzur status`. The prompt is forwarded unchanged and is never compacted.
- Stray single-dash tokens such as `-p=64k` are rejected instead of becoming positional arguments.

New config keys, all optional: `models`, `ledger.ranking`, `upstream.retry.*` (including `upstream.retry.paths`), `legacyCompletions.*` and `debug.capture.path` (with `debug.capture.requests` and `debug.capture.maxBytes`). See [CONFIG.md](../../CONFIG.md).

## Install and verify

The release ships the same asset kinds as 0.2.1, plus an SBOM:

- `kitzur-<version>.tgz`: the npm package tarball.
- `kitzur-<version>-offline.tar.gz`: the offline bundle for Linux and macOS.
- `kitzur-<version>-windows.zip`: the Windows bundle.
- `kitzur-<version>.cdx.json`: a CycloneDX SBOM.
- `SHA256SUMS`: SHA-256 checksums of every asset.

Verify a download against `SHA256SUMS` with built-in tools:

```sh
# Linux
sha256sum -c --ignore-missing SHA256SUMS
```

```powershell
# Windows (PowerShell); compare the output with the matching line in SHA256SUMS
Get-FileHash .\kitzur-<version>-windows.zip -Algorithm SHA256
```

After extracting the offline bundle or the Windows ZIP, `node deploy/verify-bundle.mjs <folder>` checks the Node.js version, every file's checksum, unlisted or forbidden files, imports and a CLI smoke test with Node.js alone. See [deploy/README.md](../../deploy/README.md).

## Known limitations

- Only the OpenAI Chat Completions API is supported, not Responses or Anthropic Messages.
- Without the served model's `tokenizer.json`, counts are a conservative estimate rather than exact.
- Kitzur forwards one client key to one upstream and does not rotate keys; see [docs/UPSTREAM-ROTATION.md](../UPSTREAM-ROTATION.md) for an external rotator.
- Correction detection is heuristic: it can miss corrections or retain obsolete instructions, and it does not understand arbitrary negation. See [DESIGN.md](../../DESIGN.md#mechanical-summary) and [SECURITY.md](../../SECURITY.md).

## Thanks and links

Thanks to everyone who reported issues and reviewed changes for this release.

- Full list of changes: [CHANGELOG.md](../../CHANGELOG.md)
- Documentation by task: [docs/README.md](../README.md)
