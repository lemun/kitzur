# Security: what kitzur sees, stores and logs

kitzur is a loopback proxy between your coding agent and the model gateway. It sees **everything the agent sends
and receives**: prompts, code, file contents, tool outputs, page snapshots, model replies, and the `Authorization`
header. This file lists exactly what it does with that.

## Network

- **Listens** on `127.0.0.1:8270` by default (`listen.host`). Binding another interface is a config change.
- **Host check.** Requests whose `Host` header is not in `listen.allowedHosts` (`127.0.0.1`, `localhost`, `::1`)
  are rejected. This blocks DNS-rebinding attacks from a web page in your browser.
- **Browser requests.** A request with an `Origin` header, or with `Sec-Fetch-Site: cross-site`/`same-site`, gets 403
  before any upstream call unless its origin is in `listen.allowedOrigins` (empty by default). `OPTIONS` is answered
  locally with 403 and never forwarded, and chat requests need `Content-Type: application/json` (415 otherwise).
  This hardens against browser cross-origin requests (CORS "simple" POSTs need no preflight).
- **Client token.** Without `listen.token`, anything that can connect to the listener can use the proxy: every
  local process and, on a shared machine, every other user. When `upstream.headers` carries credentials, they all
  get those credentials' access to the gateway (not the values themselves, which are never returned). Set
  `listen.token` to require `Authorization: Bearer <token>` on every route, `/status` included (401 otherwise,
  compared in constant time). The token is consumed locally, never forwarded, and never printed by logs,
  `/status`, `config show` or `doctor`. `serve` and `doctor` warn when `upstream.headers` is set without a token;
  a non-loopback `listen.host` with `upstream.headers` and no token refuses to start. Keep the token in a file
  only you can read (for example the config file, mode `0600`).
- **Talks to exactly one upstream**: `upstream.origin`. The client's request path is appended, but the host never
  comes from the request.
  - Kitzur never stores or rotates more than the one client key it forwards.
  - Optionally it also calls the gateway's tokenize endpoint (`tokenizer.endpoint`) on that same origin.
  - There is no other network traffic: no telemetry, no update checks, no downloads.
  - `HTTP(S)_PROXY` variables are not honoured.
- **TLS** uses Node's root store plus `upstream.caFile` (or `NODE_EXTRA_CA_CERTS`). `upstream.insecureTls` turns
  verification off and is logged loudly at startup.

## What is forwarded

- All client headers are forwarded to the upstream, `Authorization` included unless `listen.token` is set (it then carries the client token and is dropped). Hop-by-hop headers are not, and
  `accept-encoding` is forced to `identity`.
- `upstream.headers` are added. They are never logged.
- Request bodies are forwarded unchanged, or rewritten by the engine as `DESIGN.md` describes: summaries, stubs and
  truncations of earlier content. No content is invented beyond kitzur's own markers.

## What is stored on disk

Except for explicitly configured output paths, it lives under `stateDir`, which defaults to `$XDG_STATE_HOME/kitzur` or `~/.local/state/kitzur`.

| File | Content | Contains user content? | Default |
|---|---|---|---|
| `learned.json` | Per (gateway origin, model): learned window, tighten, calibration ratios, timestamps | No: numbers and the origin/model names only | on |
| `plans/plans-<day>.jsonl` | Compaction plans: plan keys, cut indices and **summary text** | **Yes**: summaries quote user instructions, assistant notes, file paths and URLs | **off** (`store.persist: false`); the `plans/` directory is created owner-only (`0700`) |
| `tokenizer-<sha>.lctk` | Compiled tokenizer cache | No | on when a tokenizer is configured |
| `stats.path` (JSONL) | One record per request: sizes, token counts, actions, statuses, timings, a session hash, and optional `client_session` (`x-session-id` / `x-sim-session`, stored verbatim, at most 128 characters) | **Client session IDs**, but no message content | off unless set |
| `debug.capture.path` | Bounded raw response JSONL: status, redacted response headers, request shape, timestamped base64 chunks and end reason | **Yes**: raw model output and upstream error bodies may echo prompts or secrets | **off** (`null`); new file only, mode `0600`, automatic request/byte budget cutoff |
| `ledger.mirrorPath` | The rendered facts section | **Yes** | off (not implemented in v1: setting it writes nothing and warns at startup) |

Avoid putting secrets or message content in client session IDs when enabling stats.

With the defaults, kitzur writes **no user content to disk**. A restart then recomputes plans from the next
request (deterministic, so the output is identical).

## What is logged

- Startup configuration (no header values, no URL credentials), warnings and errors.
- At the default `info` level, one content-free line per completed chat request: action, token counts, budget,
  trigger, target, the model name and elapsed milliseconds (`logLevel: "warn"` suppresses it). More per-request
  detail goes to `/status` and, when `stats.path` is set, the stats JSONL.
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
- `npm run sbom` builds the package and prints a CycloneDX 1.5 SBOM: the package with its version, license and
  purl, no dependencies, and one entry per published file with its SHA-256. The output is reproducible (no
  timestamp unless `SOURCE_DATE_EPOCH` is set); regenerate it with `npm run sbom -- --out sbom.json`.
- The tokenizer file (`tokenizer.json`) is data, read with `JSON.parse`. It is never executed.

## Reporting

Report vulnerabilities privately through [GitHub security advisories](https://github.com/lemun/kitzur/security/advisories/new) when private reporting is enabled. Otherwise, open an issue requesting a private contact without including exploit details, credentials or captured prompts.

## Opt-in raw capture

`debug.capture.path` deliberately writes model output to disk, including reasoning,
tool-call arguments and error bodies that may echo request text or credentials.
Only response headers are redacted: authorization, proxy-authorization, cookie,
set-cookie, x-api-key and every configured upstream header key. Body bytes are
preserved exactly, with no content redaction. Never share captures without review.
Request records contain counts and known numeric/boolean/null generation options
only; no request text, string parameters, tool definitions or request headers are
serialized, and there is no option to include a request body.

Capture defaults to five upstream attempts (maximum 50) and 10 MiB total, then
turns off automatically. An in-flight capture may finish after its request budget
has stopped admitting new attempts; the byte cap stops all captures immediately.
Use a private directory and a new filename: existing files and symlinks are
refused. Capture files are not rotated or deleted automatically; delete them when
the investigation is complete. Startup and `/status` report activation and errors.
