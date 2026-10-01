# Security: what kitzur sees, stores and logs

kitzur is a loopback proxy between your coding agent and the model gateway. It sees **everything the agent sends
and receives**: prompts, code, file contents, tool outputs, page snapshots, model replies, and the `Authorization`
header. This file lists exactly what it does with that.

## Network

- **Listens** on `127.0.0.1:8270` by default (`listen.host`). Binding another interface is a config change.
- **Host check.** Requests whose `Host` header is not in `listen.allowedHosts` (`127.0.0.1`, `localhost`, `::1`)
  are rejected. This blocks DNS-rebinding attacks from a web page in your browser.
- **Talks to exactly one upstream**: `upstream.origin`. The client's request path is appended, but the host never
  comes from the request.
  - Optionally it also calls the gateway's tokenize endpoint (`tokenizer.endpoint`) on that same origin.
  - There is no other network traffic: no telemetry, no update checks, no downloads.
  - `HTTP(S)_PROXY` variables are not honoured.
- **TLS** uses Node's root store plus `upstream.caFile` (or `NODE_EXTRA_CA_CERTS`). `upstream.insecureTls` turns
  verification off and is logged loudly at startup.

## What is forwarded

- All client headers are forwarded to the upstream, `Authorization` included. Hop-by-hop headers are not, and
  `accept-encoding` is forced to `identity`.
- `upstream.headers` are added. They are never logged.
- Request bodies are forwarded unchanged, or rewritten by the engine as `DESIGN.md` describes: summaries, stubs and
  truncations of earlier content. No content is invented beyond kitzur's own markers.

## What is stored on disk

All of it lives under `stateDir`, which defaults to `$XDG_STATE_HOME/kitzur` or `~/.local/state/kitzur`.

| File | Content | Contains user content? | Default |
|---|---|---|---|
| `learned.json` | Per (gateway origin, model): learned window, tighten, calibration ratios, timestamps | No: numbers and the origin/model names only | on |
| `plans/plans-<day>.jsonl` | Compaction plans: plan keys, cut indices and **summary text** | **Yes**: summaries quote user instructions, assistant notes, file paths and URLs | **off** (`store.persist: false`); the `plans/` directory is created owner-only (`0700`) |
| `tokenizer-<sha>.lctk` | Compiled tokenizer cache | No | on when a tokenizer is configured |
| `stats.path` (JSONL) | One record per request: sizes, token counts, actions, statuses, timings, a session hash | No: **sizes only, never content** | off unless set |
| `ledger.mirrorPath` | The rendered facts section | **Yes** | off (not implemented in v1: setting it writes nothing and warns at startup) |

With the defaults, kitzur writes **no user content to disk**. A restart then recomputes plans from the next
request (deterministic, so the output is identical).

## What is logged

- Startup configuration (no header values, no URL credentials), warnings and errors. There is no per-request log
  line: per-request actions and sizes go to `/status` and, when `stats.path` is set, the stats JSONL.
- Config and request-file syntax errors (`serve`, `config`, `count`, `replay`) give the line and column only: they
  never quote the file, so a mistyped header value or a captured prompt is not echoed.
- Upstream error bodies are classified in memory and returned to the client. They are **not** written to logs.
  They can echo prompt text.
- `/status` shows counters, sizes, budgets, learned numbers and latency. It never shows content. It is served on the
  proxy's own listener (loopback by default) to every request that passes the Host check, so a non-loopback
  `listen.host` exposes it too.

## Memory

Plans and per-message token counts are kept in bounded in-memory caches (`store.maxPlans`, `store.maxBytes`,
`tokenizer.cacheEntries`). Process memory therefore contains recent summaries and message digests, like any proxy's.

## Supply chain

- There are no runtime dependencies. The offline bundle (`scripts/pack-offline.sh`) contains only `dist/src`,
  `presets`, `deploy` and the docs, with a `SHA256SUMS` manifest.
- The tokenizer file (`tokenizer.json`) is data, read with `JSON.parse`. It is never executed.

## Reporting

Report vulnerabilities privately through [GitHub security advisories](https://github.com/lemun/kitzur/security/advisories/new) when private reporting is enabled. Otherwise, open an issue requesting a private contact without including exploit details, credentials or captured prompts.
