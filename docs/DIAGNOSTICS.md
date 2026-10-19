# Diagnostics and reports

`kitzur doctor` validates loaded settings, checks the prompt budget against the configured context and client limits, verifies tokenizer availability and local counting, and inspects state and stats paths. It does not create files or directories. The default state directory is resolved from `stateDir`, `XDG_STATE_HOME`, or the home directory; when a configured directory is absent, doctor checks the nearest existing parent. A configured tokenizer in automatic mode that is missing produces a warning because counts fall back to estimates. A present tokenizer must parse and count a short sample. Doctor also validates the configured template name, but does not render a chat request or contact a tokenize endpoint.

Messages are fixed and safe for display: they include no raw paths, credentials, config values, network error text, or server response body. Doctor exits 0 when checks have no errors, 1 when a diagnostic finds an error, and the CLI uses 2 for configuration or command-line errors.

The optional upstream check sends one bounded `GET /v1/models` request. It sends no prompt and does not generate a completion. A 2xx response is healthy; 401/403 are healthy when the client supplies the key, but warn when upstream.headers contains an authorization-like header; 404 warns about a missing route; other responses or transport failures are errors. The timeout is capped at 10 seconds. Set KITZUR_PROBE_TOKEN in the environment to send a Bearer key for this probe only: 2xx reports “key accepted”, and 401/403 warns “key rejected”. The token is never printed; there is no CLI token value.

Client usable-context checks accept equality at the trigger plus output allowance boundary. When the client would compact first, the fix names the client.inputLimit, client.reservedTokens (for an explicit input reservation), and client.outputLimit values to mirror in kitzur.jsonc, where applicable.

```sh
kitzur doctor
kitzur doctor --json
kitzur doctor --check-upstream --timeout-ms 1500
```

`kitzur report <stats.jsonl>` aggregates the existing stats file. JSON output contains only aggregates; readable output prints the same core measures. A nonempty record must have an integer `seq`, known `action`, HTTP `client_status` (100–599), and at least one of token fields or an attempts array. Invalid JSON, primitives, and unrelated objects increment `coverage.malformed` and do not count as requests. Valid records with absent or invalid optional values remain counted; those values contribute zero and per-field coverage shows how many records supplied data. Empty files produce zero totals. A valid final line without a newline is included and `partialFinalLine` marks the missing newline. The report never emits record contents, paths, session IDs, or credentials; it reports only the number of distinct nonempty session IDs.

Request token reduction uses records with at least one valid recorded attempt and valid `tokens_in`/`tokens_out`, excluding shadow requests and requests rejected locally (client errors with an explicit empty attempts array). It reports `(eligible input − eligible last-attempt forwarded) / eligible input`; a zero denominator is `null` in JSON and `n/a` in text. This is request size reduction, not a billing estimate. Shadow estimates are reported separately. `attemptedRaw` sums `attempts[].raw` for recorded attempts, including recorded recovery retries. Retry count is recorded attempts beyond the first. Missing attempts or an array containing non-object entries have unknown retry/local-reject classification and do not contribute to these measures; field coverage exposes that absence. The upstream transport's internal transparent socket retry is not persisted in each stats record and is not included here. Failures count client status 400 or above, incomplete upstream streams, or a final recorded attempt with a present non-`ok` kind. HTTP status counts include only numeric attempt statuses from 100 through 599.

`usage.prompt_tokens` and `usage.completion_tokens` are from the final response usage fields when present; they do not cover every retry and may be absent. Prompt and completion usage each have separate coverage counts. Timing values are summed for records that contain each timing field, and each total has a corresponding coverage count.

```sh
kitzur report stats.jsonl
kitzur report stats.jsonl --json
```
