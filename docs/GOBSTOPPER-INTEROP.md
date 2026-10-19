# Gobstopper legacy stats interop

Kitzur emits the legacy fields required by Gobstopper's importer: ISO timestamp
`ts`, nonnegative integer `est_tokens_in` / `est_tokens_out`, and boolean `compacted`.
No exporter or runtime dependency is needed. The synthetic, newline-terminated
[test fixture](../test/fixtures/stats/interop-legacy.jsonl) covers passthrough,
compaction, prefix reuse and local rejection; it contains no user data.

Use a Gobstopper release with `data import-legacy` (the study examined v0.8.10).
Check `gobstopper data import-legacy --help` first. From the repository root:

```sh
interop_state=$(mktemp -d)
HOME="$interop_state" XDG_STATE_HOME="$interop_state/state" XDG_DATA_HOME="$interop_state/data" XDG_CONFIG_HOME="$interop_state/config" \
  gobstopper data import-legacy test/fixtures/stats/interop-legacy.jsonl --source-id kitzur-synthetic-v1
```

Keep that directory for a repeat import with identical environment and source ID.
Duplicate handling should leave the observation total unchanged on reimport;
verify the import summary before using this with your own bounded, closed logs.
Keep the same source ID if a segment moves; give distinct segments distinct IDs.
Do not infer duplicate identity from Kitzur's `seq`, which restarts with the proxy.

Imported rows are legacy context-size estimates, not measured provider usage,
billed savings or completed requests. Kitzur may count tokens exactly, but the
legacy import still has estimate semantics. `est_tokens_out` is forwarded prompt
size, not generated completion tokens. Attempts, failures and usage coverage do
not become native request events. The rejection row forwards zero tokens; unknown
counts can also be zero. These rows must not be treated as successful savings.

Validation: the focused test checks exact emitted JSONL and required field types.
Actual import and duplicate behavior require a compatible Gobstopper binary;
the available v0.5.0 binary lacks `data`, so these were not verified here.
