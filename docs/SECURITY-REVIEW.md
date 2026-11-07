# Security review checklist

A checklist for teams that vet Kitzur before allowing it on an internal network. Each item has a claim, a
command to verify it on a source checkout (or `dist/src` in a bundle), and the file that owns the detail.
Commands assume the repository root. `test/docs/security-review.test.ts` keeps the module table below true.

## Provenance and integrity

- **Claim:** release assets are built by CI as a draft and carry a `SHA256SUMS` manifest; a person publishes them.
  **Verify:** `sha256sum -c SHA256SUMS` next to the downloaded assets. **Owner:** [.github/workflows/release.yml](../.github/workflows/release.yml).
- **Claim:** the offline bundle lists every file it contains in its own `SHA256SUMS`.
  **Verify:** unpack it, then `sha256sum -c SHA256SUMS` inside it. **Owner:** [scripts/pack-offline.sh](../scripts/pack-offline.sh).
- **Claim:** a reproducible CycloneDX 1.5 SBOM lists the package and every published file with its SHA-256.
  **Verify:** `npm run sbom -- --out sbom.json`. **Owner:** [SECURITY.md](../SECURITY.md#supply-chain), [scripts/sbom.mjs](../scripts/sbom.mjs).
- **Claim:** no install scripts and no runtime dependencies.
  **Verify:** `node -p "const p=require('./package.json');[p.dependencies,['preinstall','install','postinstall','prepare'].filter(k=>p.scripts[k])]"` prints `[ undefined, [] ]`. **Owner:** [package.json](../package.json).
- **Claim:** the published file set is declared, bounded in size, and ships no tests, keys or env files.
  **Verify:** `npm run check:pack`. **Owner:** [scripts/check-pack.mjs](../scripts/check-pack.mjs).
- **Claim:** third-party licenses ship with the package. **Verify:** `ls LICENSES`. **Owner:** [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), [LICENSE](../LICENSE).

## Network behaviour

- **Claim:** listens on `127.0.0.1:8270` by default. **Verify:** `kitzur config show | grep -A3 '"listen"'`. **Owner:** [CONFIG.md](../CONFIG.md#listen).
- **Claim:** requests whose `Host` header is not in `listen.allowedHosts` are rejected (DNS rebinding).
  **Verify:** `curl -H 'Host: example.com' http://127.0.0.1:8270/status` returns an error status. **Owner:** [src/proxy/hostcheck.ts](../src/proxy/hostcheck.ts), [SECURITY.md](../SECURITY.md#network).
- **Claim:** `listen.token` optionally requires `Authorization: Bearer <token>` on every route; it is never forwarded.
  **Verify:** with a token set, `curl http://127.0.0.1:8270/status` returns 401. **Owner:** [SECURITY.md](../SECURITY.md#network).
- **Claim:** the proxy's only outbound destination is `upstream.origin` (chat, the optional `tokenizer.endpoint` on the same
  origin, and doctor's opt-in `--check-upstream` probe). The CLI diagnostic `kitzur status --url <url>` is the one exception:
  it reads `/status` from the URL the operator passes. The host never comes from the request and `HTTP(S)_PROXY` is not honoured.
  **Verify:** the module table below; `grep -n "new URL" src/tokenize/remote.ts src/proxy/upstream.ts`. **Owner:** [src/proxy/upstream.ts](../src/proxy/upstream.ts).
- **Claim:** `scripts/fetch-tokenizer.sh` downloads a development tokenizer into `bench/.cache` and checks its SHA-256.
  It is a build and benchmark step, not part of the runtime or the bundle. **Verify:** `grep -rn fetch-tokenizer dist/src` prints nothing. **Owner:** [scripts/fetch-tokenizer.sh](../scripts/fetch-tokenizer.sh).
- **Claim:** no telemetry, update check or runtime download (the tokenizer fetch above is the build-time exception). **Verify:** `grep -rnE "(^|[^.a-zA-Z])fetch\(" dist/src` prints nothing, and every outbound module is in the table below. **Owner:** [SECURITY.md](../SECURITY.md#network).

## Credentials

- **Claim:** the client's `Authorization` header is forwarded to the one upstream (dropped when `listen.token` is
  set), never logged and never stored. **Verify:** `grep -rni authorization src/proxy/stats.ts src/proxy/state.ts` prints nothing. **Owner:** [SECURITY.md](../SECURITY.md#what-is-forwarded).
- **Claim:** `KITZUR_PROBE_TOKEN` is read from the environment only, for doctor's upstream probe, and never printed.
  **Verify:** `grep -rn KITZUR_PROBE_TOKEN src`. **Owner:** [docs/DIAGNOSTICS.md](DIAGNOSTICS.md).
- **Claim:** `upstream.headers` values and `listen.token` are shown as `<set>` by `config show`; `/status` carries no header values.
  **Verify:** `kitzur config show`; `grep -n headers src/proxy/status.ts` prints nothing. **Owner:** [src/cli/format.ts](../src/cli/format.ts).

## Data at rest

- **Claim:** `stateDir` holds learned numbers, the tokenizer cache, logs and, only when enabled, plans.
  **Verify:** `ls -la ~/.local/state/kitzur`. **Owner:** [SECURITY.md](../SECURITY.md#what-is-stored-on-disk).
- **Claim:** plan persistence is off by default (`store.persist: false`); plans contain summary text (user content) and live in a `0700` directory.
  **Verify:** `grep -n "store.persist" CONFIG.md`. **Owner:** [src/proxy/state.ts](../src/proxy/state.ts).
- **Claim:** stats (off unless `stats.path` is set) hold sizes, counts and timings, plus client session IDs, but no message content.
  **Verify:** inspect one line of the stats JSONL. **Owner:** [src/proxy/stats.ts](../src/proxy/stats.ts).
- **Claim:** `debug.capture` is off by default, bounded by request and byte budgets, and writes a new `0600` file only.
  **Verify:** `grep -n 0o600 src/proxy/capture.ts`. **Owner:** [SECURITY.md](../SECURITY.md#opt-in-raw-capture).
- **Claim:** `kitzur redact` strips message text from captured requests, and `kitzur doctor --snapshot` masks hosts and
  home paths, for sharing. **Verify:** run both on a sample and read the output. **Owner:** [src/diagnostics/snapshot.ts](../src/diagnostics/snapshot.ts), [docs/DIAGNOSTICS.md](DIAGNOSTICS.md#sharing-a-reproducible-report).

## Process behaviour

- **Claim:** in `src/`, child processes start only from the modules marked `node:child_process` in the table below.
  The packaged Windows helper `deploy/windows/manage.mjs` also starts PowerShell (install and uninstall scripts) and a
  detached supervisor of its own. **Verify:** `grep -rln child_process dist/src deploy/windows`. **Owner:** this document,
  [deploy/windows/manage.mjs](../deploy/windows/manage.mjs).
- **Claim:** no `eval`, `new Function` or dynamic import of user input; dynamic imports use fixed in-package paths.
  **Verify:** `grep -rnE "eval\(|new Function|import\(" src`. **Owner:** [src/app.ts](../src/app.ts).
- **Claim:** request bodies are capped by `listen.maxRequestBytes` (413) and concurrency by `listen.maxConcurrentRequests` (503).
  **Verify:** `grep -n "listen.max" CONFIG.md`. **Owner:** [CONFIG.md](../CONFIG.md#listen), [src/proxy/server.ts](../src/proxy/server.ts).
- **Claim:** upstream error bodies are read with a byte cap (64 KiB) and a 5 s timeout, and are not logged.
  **Verify:** `grep -n UPSTREAM_ERROR src/proxy/server.ts`. **Owner:** [src/proxy/upstream.ts](../src/proxy/upstream.ts).

## Windows specifics

- **Claim:** non-admin autostart writes one Startup-folder shortcut (`Kitzur.lnk`) and nothing else.
  **Verify:** `kitzur autostart status`. **Owner:** [src/autostart.ts](../src/autostart.ts), [deploy/windows/USER.md](../deploy/windows/USER.md).
- **Claim:** no registry, service or execution-policy change. **Verify:** `grep -rniE "HKCU|HKLM|New-Service|Set-ExecutionPolicy" src deploy/windows` prints nothing.
  **Owner:** [deploy/windows/Register-Startup.ps1](../deploy/windows/Register-Startup.ps1), [deploy/windows/ADMIN.md](../deploy/windows/ADMIN.md).

## What Kitzur does not do

- **Claim:** it does not call a model; compaction is mechanical and local. **Verify:** the module table below. **Owner:** [DESIGN.md](../DESIGN.md#mechanical-summary).
- **Claim:** it does not rewrite transcript files; only the forwarded request changes. **Verify:**
  `grep -rlnE "writeFile|createWriteStream|appendFile|writeSync|copyFile" src` lists only modules writing under `stateDir`,
  the tokenizer cache, log, stats and capture files, or an output path given on the command line. **Owner:** [DESIGN.md](../DESIGN.md).
- **Claim:** it does not store or rotate keys beyond the one client key it forwards. **Verify:** `grep -rni rotat src` matches only log rotation. **Owner:** [SECURITY.md](../SECURITY.md#network).

## Modules that can reach the network or start processes

Every `src/` file with an import (including `import type`) of `node:http`, `node:https`, `node:net`, `node:tls`, `node:dns`, `node:dgram`
or `node:child_process`, or a `fetch(` call.

| Module | Imports | Why |
|---|---|---|
| `src/proxy/server.ts` | `node:http` | The proxy listener. |
| `src/proxy/relay.ts` | `node:http` (types only) | Relays the upstream response to the client socket the listener owns. |
| `src/proxy/upstream.ts` | `node:http`, `node:https`, `node:tls` | The client for `upstream.origin`, the only outbound destination. |
| `src/tokenize/remote.ts` | `node:http`, `node:https` | Optional `tokenizer.endpoint` calls on `upstream.origin`. |
| `src/diagnostics/tls-chain.ts` | `node:net`, `node:tls` | Inspects the upstream certificate chain when a TLS error is reported. |
| `src/diagnostics/doctor.ts` | `node:net`, `node:http` | Checks whether the configured listen port is free or serves Kitzur's `/status`. |
| `src/cli/http.ts` | `node:http`, `node:https` | `kitzur status` reads `/status` from the listener (or `--url`). |
| `src/autostart.ts` | `node:child_process` | Windows: PowerShell creates the Startup shortcut; `autostart run` starts a detached `kitzur serve`. |
| `src/diagnostics/windows.ts` | `node:child_process` | Windows doctor runs `netsh int ipv4 show excludedportrange`. |
| `src/cli/commands/bench.ts` | `node:child_process` | `kitzur bench` runs the benchmark suite with the same Node, from a source checkout only. |
