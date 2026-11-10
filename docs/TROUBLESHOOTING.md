# Troubleshooting

Run `kitzur doctor` (add `--check-upstream`, `--client-config FILE` or `--json` as needed) and look up each `WARN` or `ERROR` code below. Background: [diagnostics](DIAGNOSTICS.md), [configuration](../CONFIG.md).

Use `kitzur doctor --snapshot support.json` to write a shareable support snapshot. It omits credentials and masks hosts and home paths; use `--snapshot -` to print it, or `--force` to replace an existing file.

## The proxy does not start, or the port is taken
- Codes: `config.valid`, `config.warnings`, `instance.responsive`, `paths`, `state.directory`, `log.directory`, `stats.path`.
- Cause: invalid settings, another service on `listen.port`, or a state/log/stats path that is blocked or not writable.
- Fix: run `kitzur config validate`; if `instance.responsive` warns, inspect what answers on the port and change `listen.host`/`listen.port`; point `stateDir`, `log.file` and `stats.path` below an accessible directory.

## The learned state file is damaged
- Code: `state.file`.
- Cause: `learned.json` in the state directory is not valid learned state (cut off by a crash or disk error, edited by hand, or a folder in its place). The proxy ignores it and learns limits from scratch.
- Fix: run `kitzur state reset` to move it aside to `learned.json.corrupt`, or delete the file; then restart a running proxy.

## Stats records are missing
- Code: `stats.writer`.
- Cause: the stats writer dropped records while its output was blocked or encountered a write failure. `/status` and `kitzur doctor` report the dropped-record and write-failure counters.
- Fix: check the stats destination's disk and directory permissions, then restart Kitzur to reset the in-memory counters.

## Requests pass through uncompacted
- Codes: `budget.compatible`, `upstream.skipped`.
- Cause: the session has not reached the trigger, `shadow` is on, or the budget leaves no room to compact.
- Fix: compare the logged `tokens` with `trigger`; turn off `shadow`; fix the budget settings `budget.compatible` names.

## The client overflows anyway (client limit versus served window)
- Codes: `budget.client_limits`, `model.<model>.profile`, `model.<model>.budget`; with `--client-config`: `client.config`, `client.usable`, `client.context`, `client.output`, `client.profile`, `client.base_url`, `client.routing`, `client.npm` (`client.compatible` when all pass).
- Cause: the client compacts at a point Kitzur does not know, or `budget.window` exceeds the window the server actually serves; or the client config is unreadable, lacks positive `limit.context`/`limit.output`, does not route through Kitzur's listen address, or uses a provider package that calls `/responses`.
- Fix: mirror `client.inputLimit`, `client.reservedTokens`, `client.outputLimit` or `client.compactionPointTokens` in kitzur.jsonc (`client.usable` names the values); set `budget.window` to the served window; add an exact model profile; point a provider `baseURL` at Kitzur, select models from that provider, and use `@ai-sdk/openai-compatible`.

## 401/403 from the upstream or from /v1/models
- Codes: `upstream.reachable`, `listen.token`.
- Cause: the models probe needs a key, or the configured or probe key was rejected.
- Fix: check the authorization entry in `upstream.headers`, or set `KITZUR_PROBE_TOKEN` for the probe; when `upstream.headers` carries credentials, set `listen.token`.

## The TLS chain is incomplete or untrusted
- Run `kitzur tls-probe https://gateway.example.com`. Diagnoses: `leaf_only_missing_intermediate`, `unknown_root`, `self_signed`, `expired`, `hostname_mismatch`.
- Cause: the gateway sends only its leaf, or its CA is not in the local store; or the certificate is expired or names another host.
- Fix: append the named CA (and its root) to `upstream.caFile`; have the gateway serve the full chain; renew the certificate or use the hostname it covers. An `upstream.reachable` error can have this cause.
- `upstream.tls` (from `kitzur doctor --check-upstream` and at `serve` startup): the upstream certificate failed verification. The output names the verification code and the chain diagnosis above. Fix: have the gateway serve the intermediate certificate, or trust the CA via `upstream.caFile`, then rerun `kitzur tls-probe`.

## A stream ends early or with an error event
- Codes: `upstream.reachable`.
- Cause: the upstream closed the stream without `[DONE]` or a finish reason (`upstream_incomplete` in `/status` and stats), or sent an in-stream `error` event.
- Fix: run `kitzur doctor --check-upstream`; check `upstream.timeoutMs`, the gateway's timeouts and `upstream.maxBodyBytes`; read the rotating log for the request.

## A hung instance
- Codes: `instance.responsive`.
- Cause: the process listens but does not answer `GET /status`; on Windows a paused console (QuickEdit selection) freezes console writes. The log records `event_loop_stall` lines and `/status` reports `stalls_total`.
- Fix: stop the process and start `kitzur serve` detached, with stdout and stderr redirected to log files instead of a console. On Windows (PowerShell): `Start-Process -FilePath node -ArgumentList '"<path>\cli.js" serve' -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\kitzur-out.log" -RedirectStandardError "$env:TEMP\kitzur-err.log"`; doctor prints this command with your paths filled in.

## Wrong tokenizer or template
- Codes: `tokenizer.mode`, `tokenizer.path`, `tokenizer.load`, `tokenizer.count`, `tokenizer.template`, `model.<model>.tokenizer`, `model.<model>.template`.
- Cause: estimate mode, a missing or unsupported tokenizer.json, or a template that does not match the tokenizer.
- `tokenizer.load` names why the file failed: not found, a folder, unreadable, empty, not valid JSON, or valid JSON that is not a BPE tokenizer.json (such as tokenizer_config.json).
- Fix: set `tokenizer.mode` to auto and `tokenizer.path` to the served model's tokenizer.json; pick the template that matches it.

## Learned window mismatch
- Codes: `model.<model>.budget`, `budget.compatible`.
- Cause: an overflow taught a smaller window, or a shared `stateDir` carries learned limits from another instance.
- Fix: run `kitzur state show`; after correcting `budget.window`, run `kitzur state reset`; give each instance its own `stateDir`.

## Unsupported Node.js version
- `runtime.node`: the running Node.js is older than 22, the minimum Kitzur supports.
- Fix: install Node.js 22 or later (`node --version` shows the running one); with the offline bundle, install the version its README names.

## Windows without administrator rights
These checks run only on Windows and need no administrator rights; a missing `netsh` or unreadable output skips the port check instead of failing.
- `windows.port`: `listen.port` falls inside a range from `netsh int ipv4 show excludedportrange protocol=tcp` (Hyper-V, WSL or Docker reserve these), so binding fails. Fix: set `listen.port` to the free port doctor suggests.
- `windows.synced_folder`: the state directory, log file or config file is under OneDrive or a similar synced folder, where file locks and renames can fail. Fix: move `stateDir`, `log.file` and the config to a local folder such as `%LOCALAPPDATA%\kitzur`.
- `windows.autostart`: reports whether the per-user Startup shortcut (`Kitzur.lnk`) from `kitzur autostart install` exists. Fix: run `kitzur autostart status` for details, or `kitzur autostart install --config PATH` to start Kitzur at sign-in.

## My gateway answers 429 or 503
- Default: Kitzur relays the gateway's 429, 502, 503 or 504 to the client as is. With `upstream.retry.enabled` set to `true`, a chat request is sent again after a capped backoff and the client sees only the final answer. Background: the [upstream.retry rows](../CONFIG.md#upstream) and the [FAQ](../README.md#faq-and-limits).
- Is it working: `kitzur status --json` (the `/status` body) holds `transient_retries`: `retries` (waits taken), `by_status` (waits per status code), `delay_ms` (total wait) and `exhausted` (requests where the retry gave up and the error was relayed). All are zero while retry is off. Field meanings: [JSON output](JSON-OUTPUT.md).
- Per request: a stats record carries `transient_retries` (count) and `transient_retry_delay_ms` (total wait), written only when the request was retried. `kitzur report` adds them up as `transientRetries` (`requests` repeated, `retries` in total, `delayMs` waited) and, when they are not zero, prints `Transient upstream retries: <retries> across <requests> requests, <delayMs> ms of backoff in total.` The readable `kitzur status` prints `Upstream retries: <retries> (<status>=<count>, ...); waited <delay>ms` from the live totals, adding `; gave up on <n> requests` when the retry gave up.
- Which setting to change:
  - `exhausted` grows: raise `upstream.retry.maxAttempts` or `upstream.retry.maxTotalDelayMs`, keeping the total below the client's own request timeout.
  - Clients time out while Kitzur waits: lower `upstream.retry.maxTotalDelayMs`.
  - The gateway sends a `Retry-After` above `upstream.retry.maxDelayMs`: that answer is relayed at once; raise `upstream.retry.maxDelayMs` to wait it out.
  - The client already retries on its own: leave `upstream.retry.enabled` off, or the waits add up on both sides.
- Limits: chat requests only; never after the first response byte; never in shadow mode; nothing is learned from a retried answer.
- `upstream.retry` (from `kitzur doctor` when `upstream.retry.enabled` is `true`): warns when the settings can never retry, because `upstream.retry.maxAttempts` is 1 or, with `upstream.retry.jitter` off, the first wait is longer than `upstream.retry.maxTotalDelayMs`; otherwise it sums up the attempt and wait limits. Fix: set `upstream.retry.maxAttempts` to 2 or more, or raise `upstream.retry.maxTotalDelayMs` or lower `upstream.retry.baseDelayMs`.
