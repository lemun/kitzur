# Windows administrator guide

Kitzur runs per user without elevation. Prepare a deployment profile for the served model and distribute
it separately from the public package. Node.js and OpenCode are separate prerequisites.

## Prepare a profile

1. Choose a supported Node.js 20+ build and pin the OpenCode client version. The included template uses
   the `@ai-sdk/openai-compatible` provider format documented in the
   [OpenCode provider guide](https://opencode.ai/docs/providers). Verify compatibility with the selected
   version. Use the system's normal PowerShell script policy; no scripts change policy or disable TLS.
   When Node launches Windows PowerShell 5 for startup registration, it removes the
   inherited `PSModulePath` from that child only so PowerShell builds compatible
   defaults. Other environment settings, including script policy and custom CAs,
   remain intact; this supports a PowerShell 7 → Node → Windows PowerShell bridge.
2. Record the model ID and full HTTPS API base, such as `https://api.example.invalid/v1`. Kitzur's
   upstream origin excludes the API path; the client's local base URL includes it. Verify authenticated
   model listing and streamed Chat Completions independently. Installation makes an unauthenticated
   request to the API base's `/models`; 401/403 establishes connectivity, not model access.
3. Supply the model's exact tokenizer through your normal artifact process. Record its immutable
   revision, source, SHA256, review reference and license in `profile.example.json`. Communicate the
   expected hashes through a trusted channel independent of the archive. Checksums verify identity,
   not authorization or artifact safety.
4. Complete a profile outside the public repository. Select a preset matching the model's actual context
   and output limits. Review any measured policy settings before applying them; raw probe outputs and
   deployment-specific error patterns do not belong in public documentation or packages. Custom CAs
   must be trusted by Node before setup; `NODE_EXTRA_CA_CERTS` may be provisioned by the administrator.
   Never set insecure TLS. No API key is accepted by the installer or release builder.
   Optional `tokenizerTemplate` selects `qwen3` (the backward-compatible default), `chatml`,
   `generic` or `sim` (test use only). Match the served model's chat template: loading an exact
   tokenizer does not establish that its rendered request count matches the server.

## Build and distribute

Tokenizers are independently versioned artifacts and excluded from public npm and generic release
bundles. A deployment ZIP may optionally include a tokenizer when its license and distribution policy
permit it. The explicit option below does not publish anything.

```sh
# Generic Windows ZIP, offline archive and npm package:
python3 scripts/pack-windows.py
# Deployment profile included, tokenizer supplied separately:
python3 scripts/pack-windows.py --deployment-profile /path/to/profile.json
# Include the tokenizer explicitly when distribution is permitted:
python3 scripts/pack-windows.py --deployment-profile /path/to/profile.json \
  --include-approved-tokenizer /path/to/tokenizer.json
```

Build prerequisites: local TypeScript/npm development dependencies, bash/GNU tar and Python 3.12+.
Kitzur has no runtime npm dependencies. Node and OpenCode, including the client's provider SDK/cache,
are supplied separately. The builder never downloads prerequisites.

Keep customized ZIPs and profiles out of public npm, Git releases and public storage. The generic ZIP
contains compiled code, presets, scripts, documentation and licenses. The customized ZIP also contains
`deployment/profile.json`, a distribution notice and optionally `deployment/tokenizer.json`. Outputs
include ZIP and manifest SHA256 files. Verify the ZIP before extraction. The installer verifies the trusted
manifest hash and each listed file before executing the Node helper.

Record source revision, build tools, client version, configuration revision, artifact hashes and tokenizer
provenance for reproducibility. Do not release an unreviewed dirty build. Upgrades preserve existing user
configuration; changed profiles/tokenizers require explicit migration. The launcher requires loopback
port 8270, TLS verification, exact counting and no credential headers, request stats, persisted plans or
ledger mirrors. The sample profile uses the public 100k preset; change deployment policy deliberately.
Generated OpenCode context/output limits follow the effective preset/configuration, including
`client.outputLimit` when set. Custom client compaction points/allowances cannot be expressed by
this template and are rejected; configure such deployments through a separately reviewed client setup.

CI builds the generic ZIP/npm archives on Linux with Python 3.12, then consumes both on Windows
with Node 20 and 22. It exercises portable engine/ledger/tokenizer/diagnostic suites and the actual
PowerShell installer, configuration-preserving reinstall, background start/status/stop, safe diagnostics
and an isolated startup shortcut under paths with spaces. Linux continues to run the full suite,
including POSIX signal/mode and Unix path cases. Windows Node 20/22 artifact and installation/lifecycle checks passed in
[GitHub CI](https://github.com/lemun/kitzur/actions/runs/38245999885); see
`IMPROVEMENT-PROGRAM.md` for the tested revision and validation scope.

## Validate operation and diagnose

Validate installation on Windows, including login startup, Start, Stop, Status and Uninstall. Managed
systems may disable Startup shortcuts; `-NoStartup` allows manual launch. The launcher runs during
the logged-in session, and logoff may interrupt active requests.

Use synthetic, non-sensitive histories to verify compaction. Compare Status/Diagnose snapshots before
and after requests with the client's own compaction count and timestamps. Counters reset at restart.
Kitzur's `compact` action means a new compaction; `reuse` may apply a previous plan without making a
new one. Client compaction is independent and cannot be inferred from proxy counts. `guard_fallback`
may forward the original request; it does not establish successful compaction. Investigate exception or
fallback increases before deploying broadly. Check effective provider/model/config overrides locally.

Diagnostics export only selected numeric counters, limits, snapshot time, package version and modes.
Exception names are aggregated into counts. No prompts, code, keys, hostnames, model IDs, session IDs,
request paths, error messages or stack traces are exported. Lifecycle logs contain fixed event labels
and rotate at 1 MiB. Raw `/status`, learned state and existing CLI logs are local data; do not upload them
as diagnostic reports. The launcher discards free-text logging and removes `KITZUR_*` overrides,
including test fault injection. Investigate engine exceptions with synthetic fixtures and content-free
instrumentation. No individual user benchmark run is required.

Supply credentials to the client through an appropriate credential mechanism. The proxy forwards the
client's Authorization header. Avoid shell transcripts containing credentials. Other local processes can
reach the loopback proxy. Uninstall stops the launcher and removes login startup; user data is retained
until explicitly deleted.
