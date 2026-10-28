# Gobstopper legacy stats interop

Kitzur emits the legacy import fields: ISO timestamp `ts`, nonnegative integer
`est_tokens_in` / `est_tokens_out`, and boolean `compacted`. No exporter or
runtime dependency is needed. The synthetic [fixture](../test/fixtures/stats/interop-legacy.jsonl)
covers passthrough, compaction, prefix reuse and local rejection; it contains no user data.

Use a Gobstopper release with `data import-legacy` (the study examined v0.8.10).
Check `gobstopper data import-legacy --help` first. From the repository root:

```sh
interop_state=$(mktemp -d)
HOME="$interop_state" XDG_STATE_HOME="$interop_state/state" XDG_DATA_HOME="$interop_state/data" XDG_CONFIG_HOME="$interop_state/config" \
  gobstopper data import-legacy test/fixtures/stats/interop-legacy.jsonl --source-id kitzur-synthetic-v1
```

Keep that directory for a repeat import with identical environment and source ID.
At Gobstopper commit `1aa71294f35d07ff81c82a7e133d0c2a3a220939`, source inspection
indicates duplicate rows for the same source are deduplicated; verify the import
summary. The importer bounds input to 256 MiB and 100,000 lines, plus a per-line
limit; use bounded, closed log segments rather than an active log. Keep the same
source ID if a segment moves and use distinct IDs for distinct segments. Kitzur's
`seq` restarts with the proxy and is not duplicate identity.

Imported rows are legacy context-size estimates, not measured provider usage,
billed savings or completed requests. Even exact Kitzur token counts retain
estimate semantics. `est_tokens_out` is forwarded prompt size, not generated
completion tokens. Attempts, failures and usage coverage do not become native
request events. Rejection forwards zero tokens; zero can also mean unknown, so
these rows must not be treated as successful savings.

Validation: the focused test checks exact emitted JSONL and field types. The
import command and duplicate behavior are based on source inspection of the
stated Gobstopper commit; an actual import was not run here.
