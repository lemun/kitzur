# JSON output contract

Scripts and support checklists can parse the `--json` output of the commands below. Each table lists
the top-level keys:

- **stable**: will not be renamed, removed or change type without a note in the changelog of a minor
  version. New keys may be added at any time, so ignore keys you do not know.
- **informational**: may change in any release. Display them, but do not branch on them.

General rules, for every command here:

- On success stdout carries exactly one JSON document and nothing else. Diagnostics go to stderr.
- The indentation differs between commands (one or two spaces); it is not part of the contract.
- A usage error (exit 2, `kitzur: ...` on stderr) prints no JSON. So does a config file that cannot be
  loaded, except for `doctor`, which reports it as a `config.load` check.
- No output contains message content. `test/cli/json-contract.test.ts` checks the stable keys.

## `kitzur status --json`

Prints the `/status` body of the running proxy, re-indented, so the keys come from the server's
version, not the CLI's. Exit 0 on HTTP 200. On another HTTP status the body is printed as well (also
without `--json`), the status goes to stderr and the exit code is 1. A body that is not JSON is printed
as is. When the proxy cannot be reached stdout stays empty, stderr says `kitzur: cannot reach URL: ...`
and the exit code is 1.

| Key | Type | Contract |
| --- | --- | --- |
| `name` | string | stable |
| `version` | string | stable |
| `uptime_s` | number | stable |
| `paths` | object | stable |
| `counters` | object | stable |
| `actions` | object | stable |
| `budget` | object | stable |
| `config` | object | stable |
| `last_compaction` | object\|null | stable |
| `recent_requests` | array | stable |
| `model_counters` | object | stable |
| `warnings` | array | stable |
| `profiles` | object | informational, present only with `models` profiles |
| `learned`, `budget_by_key`, `counter`, `model_tokenizers`, `discovered_window`, `discovered_limits` | object | informational |
| `latency_ms`, `memory`, `upstream`, `state`, `stats`, `error_kinds`, `guard`, `replan` and the other keys | various | informational |

## `kitzur doctor --json`

Exit code equals `exitCode`: 0 when no check is `error`, 1 otherwise, 2 when the config cannot be
loaded (then `checks` holds one `config.load` check).

| Key | Type | Contract |
| --- | --- | --- |
| `checks` | array | stable |
| `exitCode` | number | stable |

Each check has `code` (string), `status` (`ok`, `warn` or `error`) and `message` (string), all stable,
and an optional `fix` (string). The set of check codes and the message wording are informational.

## `kitzur count --json`

| Key | Type | Contract |
| --- | --- | --- |
| `file` | string | stable |
| `profile` | string | stable |
| `counter` | string | stable |
| `template` | string | stable |
| `tokenizerSha256` | string\|null | stable |
| `messages` | number | stable |
| `tools` | number | stable |
| `total` | number | stable |
| `overhead` | number | stable |
| `perMessage` | array | stable |
| `tReq` | number | stable |
| `mode` | string | stable |
| `budget` | number | stable |
| `withinBudget` | boolean | stable |
| `serverFits` | boolean | stable |

`perMessage` items are `{ i, role, tokens }`. Without an exact tokenizer and without `--estimate`,
count prints no JSON and exits 2.

## `kitzur state show --json`

`path` is the `learned.json` file read. When that file cannot be read, the reason goes to stderr,
stdout still carries the JSON (with empty `entries`) and the exit code is 1.

| Key | Type | Contract |
| --- | --- | --- |
| `path` | string | stable |
| `version` | number | stable |
| `entries` | object | stable |

`entries` maps each learned key to its entry; the fields inside an entry are informational.

## `kitzur config validate --json`

Exit 0 when `ok`, 2 otherwise.

| Key | Type | Contract |
| --- | --- | --- |
| `ok` | boolean | stable |
| `errors` | array | stable |
| `warnings` | array | stable |

`errors` and `warnings` are strings; their wording is informational.

## `kitzur config show --json`

Exit 0, or 2 when `errors` is not empty.

| Key | Type | Contract |
| --- | --- | --- |
| `preset` | string\|null | stable |
| `configPath` | string\|null | stable |
| `layers` | array | stable |
| `config` | object | stable |
| `provenance` | object | stable |
| `errors` | array | stable |
| `warnings` | array | stable |
| `derived` | object | informational |
| `derivedByModel` | object | informational, present only with `models` profiles |

Secrets in `config` are masked. The keys inside `config` follow [the configuration reference](../CONFIG.md).

## `kitzur tls-probe --json`

On a completed probe the report has `origin`, `diagnosis`, `certificates`, `links`, `failingLink`,
`hint`, `authorized` and `authorizationError`; the exit code is 0 only when `diagnosis` is `ok`. These
keys are informational. When the probe cannot complete, stdout carries a one-line `{"error": "..."}`
(stable, string) and the exit code is 1.
