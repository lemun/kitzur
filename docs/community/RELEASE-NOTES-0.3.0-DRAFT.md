**DRAFT**: GitHub release text for maintainer review. Nothing is published and the version is not bumped.

# Kitzur 0.3.0

## Summary

Kitzur 0.3.0 lets one proxy serve several models with their own settings, and makes each request's outcome, the upstream's TLS chain and the retention decisions visible. It also adds non-admin Windows autostart, support tools that keep request content out of bug reports, and checksums plus an SBOM for every release asset.

## Highlights

- **Model profiles.** An optional `models` map gives each exact wire model ID its own window, plan size, client limits and tokenizer over the root defaults; try `kitzur config init --model ID=WINDOW --dry-run`, then `kitzur config show --model ID`.
- **Request outcomes.** Each chat request's log line ends with an `outcome` (`ok`, `aborted`, `incomplete`, `upstream_error` or `refused`), and a client closing early, a stream ending without `[DONE]` or an error after the first chunk is detected; `kitzur status` shows the outcome counts.
- **TLS chain reports.** `kitzur tls-probe [origin] --ca-file FILE` names the failing link of the upstream's certificate chain with a repair hint, and `serve` and `doctor` report the same when verification fails.
- **Windows autostart without administrator rights.** `kitzur autostart install` adds a Startup-folder shortcut, and `kitzur autostart status` and `kitzur autostart remove` check and undo it.
- **Retention explanations.** `kitzur replay --explain` prints a readable table of what each compaction kept, excerpted, summarized or dropped; `--explain-limit N` sets how much detail it shows.
- **Support bundles.** `kitzur doctor --snapshot FILE` writes a shareable snapshot with credentials omitted and hosts and home paths masked, and `kitzur redact <file|dir>` copies captured requests with every text replaced by same-length filler.

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

New config keys, all optional: `models`, `ledger.ranking` and `debug.capture.path` (with `debug.capture.requests` and `debug.capture.maxBytes`). See [CONFIG.md](../../CONFIG.md).

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
