# Pick your setup

Choose the path that matches how you run Kitzur. The linked pages own the detailed configuration and operations guidance.

## Solo developer: one local model

Create a starting config with a preset and the model's tokenizer, set the upstream, then validate and serve:

```sh
kitzur config init --preset 100k --upstream http://gateway.example.com --tokenizer /path/to/tokenizer.json
kitzur config validate --config kitzur.config.jsonc
kitzur serve --config kitzur.config.jsonc
```

Point your agent's OpenAI compatible provider at `http://127.0.0.1:8270/v1`, with the model's truthful context and output limits. `kitzur status` shows the bound address, active budget, learned state and recent requests. Run `kitzur doctor` after changing configuration or when setup or connectivity is unclear; it checks local setup without probing upstream unless asked. State defaults to `~/.local/state/kitzur` (or `$XDG_STATE_HOME/kitzur`); logs are in its `logs` directory. See [configuration and client setup](../CONFIG.md#client-setup-opencode-and-kilo) and [diagnostics](DIAGNOSTICS.md).

## Shared team server: several people or models

Bind to a reachable interface and set `listen.token` for clients; clients send it as a Bearer token. Example config:

```json
{ "listen": { "host": "0.0.0.0", "token": "<client-token>" } }
```

Keep listener, upstream, logging, state directory and tokenizer settings global. Use exact wire-ID entries under `models` for per-model windows, output limits and supported profile overrides. Learned windows are stored per model in the state directory; give unrelated Kitzur instances separate state directories. Kitzur accepts one configured upstream key; key rotation across authorized gateway accounts needs a dedicated rotator in front of the gateway. See [key rotation](UPSTREAM-ROTATION.md). `kitzur status` shows current budget and recent activity; `kitzur report` summarizes recorded request stats and coverage to help plan capacity. See [model profiles](../CONFIG.md#model-profiles) and [diagnostics and reports](DIAGNOSTICS.md).

## CI and automation

Use `--config FILE` or `KITZUR_CONFIG`; `--set a.b=value` or `KITZUR_SET="a.b=v;c.d=w"` overrides config values. Give each job a throwaway state directory with `--state-dir /srv/kitzur/job-state`. With no tokenizer, counting falls back to estimates; budgets and compaction still run, but counts are approximate. Configure `tokenizer.mode: "estimate"` to choose that explicitly. `--foreground` enables console log echo when stderr is a TTY; server logs also go to the configured log file.

Run `kitzur replay captured/ --config job.jsonc` and `kitzur report stats.jsonl` as regression gates on captured request bodies and stats: both exit 1 when replay has failures or nondeterminism, or report finds malformed records. `kitzur doctor --json` emits machine-readable diagnostics and exits 0 when healthy, 1 for failed checks, or 2 for configuration errors. `kitzur report` has no config options. See [CLI options and precedence](../CONFIG.md#loading-and-precedence), [counting](../CONFIG.md#tokenizer-counting), and [diagnostics and reports](DIAGNOSTICS.md).
