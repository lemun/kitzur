# Running Kitzur on a locked-down intranet

Use this checklist when the Windows host cannot reach the public internet. Each step links to the guide that owns the details.

## Prepare and install

- [ ] On a connected build machine, create the offline bundle and release assets. Transfer the Windows ZIP (or offline archive), `SHA256SUMS`, and the published SBOM through your approved channel. Verify the checksum before extraction; see [deployment](../deploy/README.md), [Windows user guide](../deploy/windows/USER.md), and [SECURITY.md supply chain](../SECURITY.md#supply-chain) for SBOM generation.
- [ ] Install Node.js 22 or newer on the target. The offline bundle has no runtime dependencies; use its bundled files and do not run a package install. See [deployment requirements](../deploy/README.md#installing-kitzur-as-a-user-service-offline).
- [ ] Extract to a stable location such as `C:\Kitzur`. Then run `node deploy/verify-bundle.mjs <folder>`, for example `node C:\Kitzur\deploy\verify-bundle.mjs C:\Kitzur`; every check line must say PASS and the last line `verify-bundle: all checks passed`. It checks the Node version, every file against the bundle's `SHA256SUMS`, imports and forbidden files, and runs the bundled CLI; see [unpack and verify](../deploy/README.md#1-unpack-and-verify). Use a dedicated config path, for example `C:\Kitzur\kitzur.jsonc`, and pass `--config "C:\Kitzur\kitzur.jsonc"` on every command, or set `KITZUR_CONFIG`. Kitzur auto-discovery checks config locations, never the working directory. See [config loading and precedence](../CONFIG.md#loading-and-precedence).

## Configure and check the gateway

- [ ] Create a starting file with `kitzur config init --preset 100k --upstream https://gateway.example.com --out "C:\Kitzur\kitzur.jsonc"`, then review it and run `kitzur config validate --config "C:\Kitzur\kitzur.jsonc"`. See [config commands](../CONFIG.md#loading-and-precedence).
- [ ] If the gateway serves multiple models with different windows, configure exact wire-ID model profiles in `models`. See [model profiles](../CONFIG.md#model-profiles).
- [ ] Run `kitzur doctor --config "C:\Kitzur\kitzur.jsonc" --check-upstream`. If the gateway requires a key even to list models, set `KITZUR_PROBE_TOKEN` for this probe. See [diagnostics](DIAGNOSTICS.md).
- [ ] If TLS probing reports `leaf_only_missing_intermediate`, run `kitzur tls-probe https://gateway.example.com --ca-file "C:\Kitzur\ca.pem"` when using a private CA. Have the gateway serve its complete chain or set `upstream.caFile` in the config to the trusted CA file, then validate again. See [TLS troubleshooting](TROUBLESHOOTING.md#the-tls-chain-is-incomplete-or-untrusted).

## Run and support

- [ ] Install per-user Windows login startup with `kitzur autostart install --config "C:\Kitzur\kitzur.jsonc"`; it does not require administrator rights. See [Windows user guide](../deploy/windows/USER.md).
- [ ] Use `kitzur status --config "C:\Kitzur\kitzur.jsonc"` and `kitzur doctor --config "C:\Kitzur\kitzur.jsonc"` to inspect the running service and diagnostics. The status output and doctor identify config, state, and log locations; see [deployment operations](../deploy/README.md#operations) and [diagnostics](DIAGNOSTICS.md).
- [ ] For a shape-only SSE capture, set `debug.capture.path` in config (and optionally `debug.capture.requests` / `debug.capture.maxBytes`). Capture bodies contain raw response chunks; keep the file private. See [bounded raw response capture](../CONFIG.md#bounded-raw-response-capture).
- [ ] Before sharing a request body, run `kitzur redact "C:\Kitzur\capture\request.json" --out "C:\Kitzur\shared"` and review the result. See [sharing a reproducible report](DIAGNOSTICS.md#sharing-a-reproducible-report).
- [ ] Read `kitzur replay "C:\Kitzur\capture\request.json" --explain` for content-free retention outcomes, then use `kitzur report "C:\Kitzur\stats.jsonl"` for aggregate stats. See [diagnostics and reports](DIAGNOSTICS.md).
- [ ] Kitzur forwards one client key to one upstream and does not rotate keys. For authorized multi-key routing, place a dedicated rotator between Kitzur and the gateway; see [upstream key rotation](UPSTREAM-ROTATION.md).
