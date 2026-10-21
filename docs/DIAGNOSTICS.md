# Diagnostics and reports

`kitzur doctor` validates loaded settings, checks the prompt budget against the configured context and client limits, verifies tokenizer availability and local counting, and inspects state and stats paths. It does not create files or directories. The default state directory is resolved from `stateDir`, `XDG_STATE_HOME`, or the home directory; when a configured directory is absent, doctor checks the nearest existing parent. A configured tokenizer in automatic mode that is missing produces a warning because counts fall back to estimates. A present tokenizer must parse and count a short sample. Doctor also validates the configured template name, but does not render a chat request or contact a tokenize endpoint.

Messages are fixed and safe for display: they include no raw paths, credentials, config values, network error text, or server response body. Doctor exits 0 when checks have no errors, 1 when a diagnostic finds an error, and the CLI uses 2 for configuration or command-line errors.

The optional upstream check sends one bounded `GET /v1/models` request. It sends no prompt and does not generate a completion. A 2xx response is healthy; 401/403 and 404 indicate a reachable server with an auth or route issue; other responses or transport failures are errors. The timeout is capped at 10 seconds.

```sh
kitzur doctor
kitzur doctor --json
kitzur doctor --check-upstream --timeout-ms 1500
```

For optional external viewing of legacy stats, see [Gobstopper interop](GOBSTOPPER-INTEROP.md), including estimate semantics and an isolated synthetic import example.
