# kitzur configuration

Every knob, its default, what it does, what breaks when it is wrong, and which gateway probe result sets it
(`kitzur config import-eval`). See `DESIGN.md` for the architecture and limitations.
`test/config/config-md.test.ts` checks that every key of the built-in defaults is documented here.

- [Loading and precedence](#loading-and-precedence)
- [Budgets and the presets](#budgets-and-the-presets)
- [Client setup: OpenCode and Kilo](#client-setup-opencode-and-kilo)
- [Every knob](#every-knob)
- [Environment](#environment)
- [gateway-probes import](#gateway-probes-import)

---

## Loading and precedence

```
built-in defaults  <  preset  <  config file  <  KITZUR_* environment  <  command line
```

- **Defaults** are `DEFAULT_CONFIG` in `src/config/schema.ts`: the 100k/32k reference setup.
- **Preset**: `--preset 32k|64k|100k|128k` (or a path to a preset file), `KITZUR_PRESET`, or a top-level
  `"preset": "32k"` in the config file (the command line and the environment win over the file's key).
  The preset layer is applied right after the defaults, so the config file overrides it.
- **Config file**: `--config FILE` or `KITZUR_CONFIG`. JSON with `//` and `/* */` comments and trailing
  commas. Keys starting with `$` (`$schema`, `$comment`) are ignored. An unknown key is an error with a
  "did you mean" hint. Relative paths in the file (`tokenizer.path`, `upstream.caFile`, `stateDir`,
  `stats.path`, `tokenizer.cachePath`, `ledger.mirrorPath`) are relative to the file's directory; `~/` is `$HOME`.
- **Environment**: see [Environment](#environment). Relative paths are relative to the working directory.
- **Command line**: `--set a.b=value` (repeatable, applied in order) and the shortcuts `--upstream`, `--host`,
  `--port`, `--tokenizer`, `--template`, `--state-dir`, `--stats`, `--log-level`, `--shadow`.

Merging: objects merge key by key; arrays and scalars replace (so `rules.toolNames.read` in a file replaces
the default list, and the other roles keep theirs). `upstream.headers` merges header by header, and
`--set upstream.headers.X-Api-Key=…` sets one header.

`--set` / env values are parsed by the key's type: numbers (`32_000` is fine), booleans (`true/false/1/0/yes/no/on/off`),
`null` for keys that allow it, lists as JSON (`["a, b","c"]`) or comma-separated (`a,b`), objects and
`errors.custom` as JSON. A JSON-quoted value (`"null"`) is always a string.

Commands:

| Command | What it does |
|---|---|
| `kitzur config init [--preset 100k] [--out FILE\|-]` | writes a commented starting config (`kitzur.config.jsonc`) |
| `kitzur config show [--changed] [--json]` | the effective value of every key with its source (`default`, `preset:32k`, `file:…`, `env:KITZUR_WINDOW`, `cli:--set`), plus the derived budget; header values are masked |
| `kitzur config validate [--json]` | errors (exit 2) and startup warnings; also checks that `upstream.caFile` exists |
| `kitzur config import-eval <results…>` | gateway probe results → config + provenance sidecar ([below](#gateway-probes-import)) |

**Validation** rejects: a wrong type or out-of-range value for any key; an invalid regex (`ledger.*Cues`,
`ledger.labelPattern`, `rules.test.commands`, `errors.custom[].match`, `errors.exclusions[].match`); an
unknown named group in an error rule; the `g`/`y` flags on an error rule or exclusion (they make matching
stateful); `compaction.triggerFraction` outside (0, 1], `compaction.targetFraction`
outside (0, 1) and `compaction.targetTokens ≥ compaction.triggerTokens`; an explicit `server.budgetMode`
that contradicts `budget.limitCountsMaxTokens`; a config with no room for the prompt (`budget ≤ 0`) or
none below the client's compaction point; `upstream.origin` with a path; a missing `upstream.caFile`.

**Startup warnings** (also printed by `config show|validate`):
- `clamp enabled but unreachable: range (a, b) is empty`;
- `T_plan … is below the client's output limit …`;
- `at most one snapshot fits per compaction epoch …` when `budget.observedFixedPromptTokens` is set;
- a preset whose window or `defaultMaxTokens` a later layer overrode, or `budget.window` set to a preset window
  while `budget.defaultMaxTokens` kept the built-in 100k value (the classic `KITZUR_WINDOW=32000` alone);
- an absolute `compaction.triggerTokens`/`targetTokens` that gets clamped;
- a `budget` under a quarter of the window (`T_plan` reserves most of it, e.g. a 32k window with `defaultMaxTokens` 32000);
- `upstream.origin` missing, a non-loopback `listen.host`, `allowedHosts ['*']` or empty, `insecureTls`, no tokenizer,
  `ledger.mirrorPath` set (not implemented in v1).

Each regex key is checked with the flags its consumer compiles it with: `ledger.correctionCues` and
`ledger.additiveCues` with `iu` (u-mode syntax is stricter: `\-` or `\:` outside a class is an error there),
`rules.test.commands` with `i`, `ledger.labelPattern` without flags.

---

## Budgets and the presets

```
T_req       = max of the positive max_tokens / max_completion_tokens of the request; else budget.defaultMaxTokens
T_plan      = budget.planMaxTokens ?? budget.defaultMaxTokens               (config only)
W           = learned window ?? budget.window
margin      = max(budget.safetyMarginTokens, ceil(budget.safetyMarginFraction · W))
budget      = min(W − T_plan − margin, learned maxPrompt − margin) − tighten
clientPoint = client.compactionPointTokens ?? (W − min(client.outputLimit ?? T_plan, client.outputTokenMax))
allowance   = client.outputAllowanceTokens ?? min(7000, floor(T_plan / 2))
hard        = min(budget, clientPoint − allowance)
trigger     = min(compaction.triggerTokens ?? floor(hard · compaction.triggerFraction), hard)
target      = min(compaction.targetTokens ?? floor(trigger · compaction.targetFraction), trigger − 1)
byteLimit   = min(upstream.maxBodyBytes, learned maxBodyBytes)
summaryBudget = min(max(ledger floor, floor(budget · compaction.summaryFraction)), floor(budget · compaction.summaryMaxFraction))
admitTokens = oversize.admitTokens ?? floor((budget − count(head) − floor(budget · compaction.summaryFraction)) / 2)
headRoom    = budget − floor(budget · compaction.summaryFraction) − (oversize.minTailTokens ?? floor(0.25 · budget))
```

Every `floor(x · fraction)` is `Math.floor(x * fraction + 1e-9)` (41,000 · 0.35 is 14,349.999… in IEEE).
`budget` is the invariant (a forwarded request fits it); `trigger` decides when to compact and `target` how far.
`kitzur config show` prints all of these for the effective config.

| Preset | `budget.window` | `budget.defaultMaxTokens` (T_plan) | margin | budget | clientPoint | allowance | hard = trigger | target |
|---|---|---|---|---|---|---|---|---|
| `32k` | 32,000 | 8,000 | 512 | 23,488 | 24,000 | 4,000 | 20,000 | 7,000 |
| `64k` | 64,000 | 16,000 | 640 | 47,360 | 48,000 | 7,000 | 41,000 | 14,350 |
| `100k` (= defaults) | 100,000 | 32,000 | 1,000 | 67,000 | 68,000 | 7,000 | 61,000 | 21,350 |
| `128k` | 128,000 | 32,000 | 1,280 | 94,720 | 96,000 | 7,000 | 89,000 | 31,150 |

A preset sets only the window and `defaultMaxTokens`; everything else is the defaults. These values are
configurable; use the benchmark sweep to evaluate alternatives. With the reference fixed prompt of 9,376 tokens,
`admitTokens` is 6,586 / 18,045 / 27,472 at 32k / 64k / 100k, and at 32k at most one Playwright snapshot fits
per compaction epoch (the startup warning says so when `budget.observedFixedPromptTokens` is set).

**Server budget mode** (`server.budgetMode`, derived when null;  precedence):
1. an explicit `server.budgetMode` wins;
2. else `budget.limitCountsMaxTokens`: `true` → `strict_total` (`tgi` for `server.type` tgi); `false` →
   `prompt_only` (`silent_truncate` for ollama);
3. else `server.type`: vllm, sglang, litellm, unknown → `strict_total`; llamacpp, lmstudio → `prompt_only`;
   tgi → `tgi`; ollama → `silent_truncate`.

| Mode | The server checks | Forwarded `max_tokens` |
|---|---|---|
| `strict_total` | `prompt + max_tokens ≤ W` | fitted down to `W − margin − tighten − count(out)` when needed (`maxtokens_fit`) |
| `tgi` | `prompt + min(max_tokens, 1024) ≤ W` | the same test on `min(T_req, 1024)` |
| `prompt_only` | `prompt < n_ctx` | unchanged |
| `silent_truncate` | nothing (drops old messages silently) | unchanged |

All four modes use the same `budget`; the mode changes the server-fit test, the forwarded `max_tokens`, the
clamp and how errors are read.

---

## Client setup: OpenCode and Kilo

kitzur listens on `http://127.0.0.1:8270` and appends the client's request path unchanged to
`upstream.origin`. So the client's `baseURL` is `http://127.0.0.1:8270` **plus the gateway's path**: for a
gateway at `https://gw.example/llm/v1` use `upstream.origin = "https://gw.example"` and
`baseURL = "http://127.0.0.1:8270/llm/v1"`. `import-eval` prints this line from the probe's base path.

**Truthful limits are the default, measured setup**: declare the served window and output to the
client, so that the client's own compaction point (`clientPoint`) is where kitzur expects it and stays idle.

OpenCode (`opencode.json[c]`, in the project, `~/.config/opencode/` or `.opencode/`):

```jsonc
{
  "provider": {
    "kitzur": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qwen via kitzur",
      "options": { "baseURL": "http://127.0.0.1:8270/v1", "apiKey": "{env:GATEWAY_API_KEY}" },
      "models": {
        "local-model": {
          "name": "local model 27B (kitzur)", "tool_call": true, "reasoning": true,
          "limit": { "context": 100000, "output": 32000 }     // = budget.window / budget.defaultMaxTokens
        }
      }
    }
  },
  "model": "kitzur/local-model",
  "small_model": "kitzur/local-model",
  "compaction": { "auto": true, "prune": false }           // keep auto on: it is also the overflow fallback
}
```

- `limit.context`/`limit.output` equal the kitzur preset (`100k` ↔ 100000/32000, `32k` ↔ 32000/8000, …).
  OpenCode then compacts at `context − min(output, 32000)`, which is `clientPoint`.
- OpenCode sends `max_tokens = min(limit.output, 32000)` on every request and always asks for streamed usage
  (`stream_options.include_usage`), so `stream.injectIncludeUsage` stays off.
- `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` changes the 32000: set `client.outputTokenMax` to the same value.
- Do not set `compaction.auto: false`: it also disables OpenCode's overflow fallback.

Kilo (CLI and VS Code; `kilo.json[c]` in the project, `~/.config/kilo/`, `.kilocode/` or `.kilo/`): the same
provider block. The VS Code "custom provider" dialog writes no `limit`, so edit the file and set
`limit.context`/`limit.output`. Leave `compaction.threshold_percent` unset behind kitzur (its pre-send
estimate counts system + tools twice and fires early), and never use `limit.context: 0` (Kilo then compacts
in 1,000-token chunks). Kilo shrinks `max_tokens` from its *local* (uncompacted) history estimate, down to
1,024; `budget.maxTokensRestore.enabled: true` raises it back when the compacted prompt leaves room.

**The declared-large alternative**: tell the client a large window (OpenCode `limit.input: 1000000` with a
truthful `limit.context`, or a large Kilo context) and set `client.compactionPointTokens` accordingly (e.g.
`= budget.window`). The client's own compaction then never fires, and the `max_tokens` clamp
(`budget.maxTokensClamp`) becomes reachable. Use it only if the bench's reasoning runs show client
compactions with truthful limits (`bench/README.md` ).

---

## Every knob

Columns: **Default**; **Meaning**; **If wrong**: what breaks; **Probe field**: the result field
`config import-eval` sets it from (– = none; *info* = the importer records it in the provenance sidecar only).

### listen

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `listen.host` | `127.0.0.1` | Bind address. | A non-loopback address exposes the proxy, and the credentials it forwards, to the network. | – |
| `listen.port` | `8270` | Listen port; `0` picks a free port (`serve` prints `listening on http://127.0.0.1:<port>`). | A port in use: `serve` fails to start. The client's `baseURL` must use it. | – |
| `listen.allowedHosts` | `["127.0.0.1","localhost","[::1]","::1"]` | Accepted `Host` header names (port ignored); blocks DNS rebinding. `["*"]` disables the check. | Too narrow: clients that use another name are refused. `*`: a web page can reach the proxy through DNS rebinding. | – |

### upstream

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `upstream.origin` | `null` (required by `serve`) | `scheme://host[:port]` of the gateway, no path; the client's request path is appended unchanged. | Every request fails or reaches the wrong server. A path is rejected: put it in the client's `baseURL`. | manual (the host is masked in the pack); the probe's `config.base_path` becomes the printed client baseURL |
| `upstream.timeoutMs` | `900000` | Wait for the upstream response headers (covers prefill). | Too low: long prefills (100k prompts, CPU servers) fail with 502. Too high: a hung gateway holds requests. | `summarize_capture.latency_secs.max` × 3, at least 600 s |
| `upstream.idleTimeoutMs` | `300000` | Maximum silence between streamed chunks; the stream is then cut. | Too low: long thinking pauses are cut. Too high: dead streams linger. | – |
| `upstream.caFile` | `null` | PEM file with extra CAs, added to Node's roots. `NODE_EXTRA_CA_CERTS` works too. | Missing for an custom CA: the startup probe fails TLS verification and `serve` exits non-zero. A path that does not exist is a validation error. | – |
| `upstream.insecureTls` | `false` | Disable certificate verification. | `true` allows a man-in-the-middle to read prompts and keys. | – |
| `upstream.headers` | `{}` | Headers added to every upstream request (values never logged or shown). | A missing gateway key: 401s. Usually the client sends `Authorization` itself. | – |
| `upstream.maxBodyBytes` | `null` | The gateway's request-body limit (nginx `client_max_body_size` defaults to 1 MiB); the byte check keeps `bytes(messages) + tools + 512` under it. | Unset behind a 1 MiB proxy: the first large request gets a 413 (then learned as `maxBodyBytes`). Too low: needless compactions. | – |
| `upstream.keepAliveIdleMs` | `4000` | Close idle upstream keep-alive sockets after this; must be below the server's keep-alive (uvicorn: 5 s). | Above the server's: occasional `ECONNRESET` on reused sockets (retried once, harmless). | – |

### server

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `server.type` | `unknown` | `vllm`, `sglang`, `llamacpp`, `tgi`, `ollama`, `lmstudio`, `litellm` or `unknown`; derives the budget mode when neither `server.budgetMode` nor `budget.limitCountsMaxTokens` is set. | A prompt-only mode on a strict server: requests with `prompt + max_tokens > W` are rejected, then recovered by the error ladder. A strict mode on llama.cpp: `max_tokens` is fitted down needlessly. | fingerprint of the overflow bodies (`probe_gateway.tests.overflow.*.rejection.body`); else `tests.models.owned_by` (derived) |
| `server.budgetMode` | `null` | Explicit `strict_total`, `prompt_only`, `tgi` or `silent_truncate`; wins over everything. Contradicting `budget.limitCountsMaxTokens` is an error. | See `server.type`. | never written |

### budget

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `budget.window` | `100000` | The model's context window `W` in tokens. | Too high: overflow rejections until a smaller window is learned from the error (accepted only down to half the configured value). Too low: wasted context, more compactions. | `probe_gateway.tests.models.max_model_len`, window numbers in overflow bodies and `summarize_capture.errors` (smallest), else the client's `limit.context`, else the probe's `--window` |
| `budget.limitCountsMaxTokens` | `null` | Whether the server's limit counts `max_tokens` (`true`: strict; `false`: prompt-only); `null` = from `server.type`. | See `server.type`. | overflow cases A/C/D (`prompt_plus_max_tokens_over_window`): rejected with an overflow body = `true`; accepted with prompt + max_tokens > W = `false`; inconclusive = not written |
| `budget.defaultMaxTokens` | `32000` | `T_req` of a request with neither `max_tokens` nor `max_completion_tokens`, and `T_plan` unless `planMaxTokens` is set. | Too high: a smaller budget and extra compactions. Below what the client asks for: `max_tokens` is fitted down on strict servers and long replies stop at `length`. | mode of `summarize_capture.max_tokens_values`, else `min(limit.output, OUTPUT_TOKEN_MAX)` from the client config, else the probe's `--max-tokens` |
| `budget.planMaxTokens` | `null` | `T_plan`, the output reservation the plans are made with (config only, never the request's value); `null` = `defaultMaxTokens`. | Below the client's output: replies are fitted per request (startup warning). Above: a smaller budget than needed. | the pack's `outputReserve` for prompt-only servers: `min(max_tokens, max(8192, 1.5 × max completion))` |
| `budget.safetyMarginTokens` | `512` | Minimum margin below the window, for template and counting error. | Too low: rare overflow rejections (recovered, then learned). Too high: wasted context. | – |
| `budget.safetyMarginFraction` | `0.01` | Margin as a fraction of `W`; the margin is the larger of the two. | As above. | – |
| `budget.maxTokensClamp.enabled` | `false` | Reuse the plan and lower `max_tokens` instead of compacting (strict servers; reachable only with a declared-large client window, see Client setup). | Enabled with truthful limits: never fires (startup warning). Enabled with a large window: shorter maximum replies. | – |
| `budget.maxTokensClamp.floorTokens` | `8192` | The smallest `max_tokens` the clamp, the  truncate path and the `max_tokens_too_large` recovery may forward. | Too low: replies cut at `length`. Too high: the clamp and truncate paths rarely apply, more requests end in the documented error. | – |
| `budget.maxTokensRestore.enabled` | `false` | Raise a shrunken `max_tokens` (Kilo's local-estimate squeeze) back to `toTokens` when the compacted prompt leaves room. | Off with Kilo: late-session replies capped near 1,024 tokens. On with OpenCode: no effect. | – |
| `budget.maxTokensRestore.toTokens` | `null` | Target of the restore; `null` = `T_plan`. | Too high: nothing, it is capped by the room left. | – |
| `budget.observedFixedPromptTokens` | `null` | Informational: the measured fixed prompt (system + tools + first user message). Feeds the one-snapshot-per-epoch warning and `config show`'s `admitTokens`. | Only the warnings change. | median `summarize_capture.sessions_detail[].first_request_reported_prompt` |

### client

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `client.compactionPointTokens` | `null` | Where the agent compacts by itself (last step's prompt + completion); `null` = `W − min(outputLimit ?? T_plan, outputTokenMax)`. | Above the client's real point: the agent's own LLM compaction fires and rewrites the goal and facts. Far below: kitzur compacts earlier than needed. | client config: OpenCode `usable` (`limit.context − maxOut`, or `limit.input − reserved`), Kilo `threshold_percent`; `compaction.auto: false` = the window |
| `client.outputLimit` | `null` | The client's configured output (`limit.output`). | Only the `clientPoint` default and the `T_plan` warning use it. | client config `limit.output` |
| `client.outputTokenMax` | `32000` | The client's output cap (`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, `KILO_…`). | Wrong `clientPoint` default (see above). | client config env |
| `client.outputAllowanceTokens` | `null` | Headroom kept below `clientPoint` for the reply plus reasoning; `null` = `min(7000, floor(T_plan / 2))`. | Too small: a step that reasons long pushes prompt + completion past the client's point, and the client compacts. Too large: earlier compactions. | `min(T_plan, max(2000, p99 completion_tokens))` from `capture.jsonl`, else `summarize_capture.reported_completion_tokens.max` |
| `client.toolOutputMaxBytes` | `51200` | The client's per-tool output cap (OpenCode `tool_output.max_bytes`); estimates the snapshot size for the startup warning when `rules.snapshot.p90Tokens` is unset. | Only that warning changes. | client config `tool_output.max_bytes` |
| `client.summaryMarkers` | `["## Objective","## Next Move"]` | Text markers of a client-written summary (OpenCode/Kilo template); such an assistant message joins the head. | Missing: after a client compaction its summary is summarized away like any assistant text, losing the goal and facts it carried. | – |
| `client.compactionMarkers` | `["What did we do so far?"]` | Trimmed first text of the user message that precedes a client summary. | As above. | – |
| `client.boilerplateUserTexts` | OpenCode/Kilo short and long "Continue if you have next steps…" texts | Client-generated user texts that are not user instructions. | Missing: "Continue…" appears as a user fact in every summary. | – |

### compaction

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `compaction.enabled` | `true` | `false` turns compaction off (ablation): requests over the budget get the documented errors instead. | Off in production: long sessions fail. | – |
| `compaction.triggerTokens` | `null` | Absolute trigger; clamped to `hard`. | A value above `hard` is clamped (warning); an absolute value does not follow a learned smaller window. | never written |
| `compaction.targetTokens` | `null` | Absolute target; must be below `triggerTokens`; clamped to `trigger − 1`. | Too high: compactions free little and follow each other. | never written |
| `compaction.triggerFraction` | `1.0` | `trigger = floor(hard · f)`, in (0, 1]. | Lower: earlier and more frequent compactions. | – |
| `compaction.targetFraction` | `0.35` | `target = floor(trigger · f)`, in (0, 1): how much tail survives a compaction. | Higher: a larger tail, more tokens per request and back-to-back compactions. Lower: more is summarized. | – |
| `compaction.keepRecent` | `1` | Newest assistant units always kept verbatim (≥ 1). | Higher: larger tails after compaction; at 32k the newest unit alone can exceed the target. | – |
| `compaction.summaryRole` | `user` | The summary is its own user message after the head; `merge-into-first-user` appends it to the first user message (for templates that reject two consecutive user messages; relaxes I4). | `user` with such a template: the gateway rejects compacted requests (then the original is resent once if it fits). | `probe_gateway.tests.tools.gobstopper_shape_followup.status` (200 = `user`) |
| `compaction.summaryFraction` | `0.04` | Summary budget base: `floor(budget · f)`; the ledger floor may exceed it. | Higher: bigger summaries, less tail. Lower: tool log and narrative evicted sooner. | – |
| `compaction.summaryMaxFraction` | `0.25` | Cap of the summary budget as a fraction of `budget`. The cap bounds the room for the tool log and narrative tier 2; the ledger floor (user, decision, todo, file, rest, tier 1) is rendered in full above it and evicted only when the request would exceed `budget` ( R6). | Too low: the tool log and assistant narrative leave the summary sooner. Too high: bigger summaries, less tail. | – |
| `compaction.narrativeMaxCharsPerMessage` | `600` | Head + tail cap per assistant message in narrative tier 2 (unlabelled text). | Higher: bigger summaries. | – |
| `compaction.userMaxChars` | `4000` | User facts longer than this are shortened head + tail in the summary (the fit loop may halve it twice more). | Too low: long user rules lose their middle. | – |

### oversize

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `oversize.enabled` | `true` | Slim and truncate oversized tool results in the newest units and at admission (, ). | Off: one huge tool output makes the request impossible (a client-visible error). | – |
| `oversize.headShare` | `0.8` | Share of the room given to the head of a truncated output (the rest to its tail). | Test failures usually sit at the tail; lower it for tail-heavy outputs. | – |
| `oversize.headPolicy` | `truncate` | An oversized head (e.g. a client summarizer request) truncates the first user message; `error` returns the documented error instead. | `error`: summarizer requests of long sessions fail. | – |
| `oversize.admission` | `true` | Shrink new tool results above `admitTokens` when they first arrive (never-forwarded messages, so the prefix cache is kept). | Off: large results enter verbatim and force earlier, larger compactions. | – |
| `oversize.admitTokens` | `null` | Admission threshold; `null` = `floor((budget − head − floor(budget · summaryFraction)) / 2)`. | Too low: useful outputs truncated. Too high: admission never fires. | – |
| `oversize.minTailTokens` | `null` | Room kept for the tail when the head must be truncated; `null` = `floor(0.25 · budget)`. | Too high: the first user message is cut deeper. | – |

### reasoning

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `reasoning.summary` | `drop` | `reasoning_content`/`reasoning` in summaries: `drop`, `cap` (to `summaryCapChars`) or `keep`. | `keep`: large summaries of thinking text. | – |
| `reasoning.summaryCapChars` | `400` | Cap for `summary: cap`. | – | – |
| `reasoning.tail` | `keep` | `drop` removes reasoning from kept assistant messages at a compaction. | `drop` with `preserve_thinking` templates changes rendering of kept turns. | – |
| `reasoning.field` | `null` | Informational: which field the server emits (`reasoning_content` or `reasoning`). | – | `probe_gateway.tests.basic.message.keys` / stream `delta_keys` |
| `reasoning.serverEmits` | `null` | Informational: the server returns reasoning. | – | `probe_gateway.tests.basic.message.reasoning_*_chars` |
| `reasoning.sentBackByClient` | `null` | Informational: the client sends reasoning back in history. | – | `summarize_capture.requests_with_reasoning_sent_back` |

### ledger (facts in the summary, )

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `ledger.enabled` | `true` | Extract the facts ledger into summaries. | Off (ablation): summaries keep the user instructions (never superseded, since supersession is part of the ledger), the narrative and the tool log; decisions, todos, files, browser state, the last test run and referenced paths are gone. | – |
| `ledger.tags.decision` | `["DECISION"]` | Line tags for decisions (case-insensitive, optional `-ID` suffix). | Tags the agent does not use: decisions only survive as narrative. | – |
| `ledger.tags.todo` | `["TODO"]` | Line tags for open todos. | As above. | – |
| `ledger.tags.blocked` | `["BLOCKED"]` | Line tags for blockers (listed under Open todos). | As above. | – |
| `ledger.tags.note` | `["NOTE"]` | Line tags for notes (head of Assistant notes). | As above. | – |
| `ledger.labelPattern` | `\b[A-Z][A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*:` | Regex (compiled without the `u` flag) of labelled lines kept as narrative tier 1. The default is searched only in the 64 characters before each `:` (linear time on any line; a longer label is found by its tail); a custom pattern runs on the whole line, so keep it free of catastrophic backtracking. | Too broad: noise ranks as tier 1. | – |
| `ledger.pathArgKeys` | `["filePath","file_path","path","filename","file"]` | Tool-argument keys holding file paths (read/edit/write). | Missing the client's key: touched files are not listed. | – (only tool names leave the deployment) |
| `ledger.correctionCues` | English cues (`actually`, `instead`, `correction`, …) and Hebrew (`בעצם`, `במקום`, …) | Regex (flags `iu`) marking a sentence as a correction of an earlier instruction. Never cues: a question, a cue inside quotation marks, and a status report whose only cues are `actually`, `no longer` or `not … anymore` with no directive word (`use`, `run`, `skip`, `need`, `should`, …). The Hebrew `בעצם` is treated the same way, with Hebrew directive words (`תשתמש`, `הרץ`, `במקום`, `אל`, `רק`, `צריך`, …), so "Actually, the tests passed now." does not delete "Run the tests after each change." | Too broad: false supersessions hide user rules. Too narrow: old and new instruction both stay visible. | – |
| `ledger.correctionMinOverlap` | `0.34` | Content-word overlap coefficient needed to supersede without a shared explicit ID. | Lower: false supersessions. Higher: missed ones. | – |
| `ledger.additiveCues` | `too`, `also`, `additionally`, `in addition`, `as well`, `גם` | Regex (flags `iu`): sentences with these cues never supersede. | – | – |
| `ledger.stopWords` | `[]` | Extra stop words (the built-in English + Hebrew list is in `src/engine/ledger/stopwords.ts`). | – | – |
| `ledger.outputPaths.enabled` | `true` | List paths referenced inside tool outputs (config-like ones as Files). | Off: config files mentioned in outputs are forgotten. | – |
| `ledger.outputPaths.maxPerResult` | `3` | Cap of output paths per tool result. | – | – |
| `ledger.outputPaths.maxTotal` | `20` | Cap of output paths in the ledger. | – | – |
| `ledger.mirrorPath` | `null` | Reserved: would write the rendered facts section to this file after each compaction (user content; SECURITY.md). **Not implemented in v1**: setting it writes nothing (startup warning). | – | – |

### rules (tool rules, )

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `rules.toolNames.snapshot` | `["*browser_*"]` | Globs (`*` only) of snapshot-producing tools (MCP names are `<server>_<tool>`). Informational in v1: snapshots are recognised by content only ( : `- Page Snapshot:` or ≥ 10 `[ref=`, whatever the tool; for read/edit/write results only at a line start after an optional line-number gutter, so source code that mentions the markers stays file content), so this list changes no behaviour; `import-eval` records the observed browser tool names here. | – (a snapshot is stubbed and slimmed whatever its tool name) | observed names the defaults miss (`summarize_capture.tool_sets`), browserAction merged here |
| `rules.toolNames.browserNavigate` | `["*browser_navigate","*browser_navigate_back","*browser_tabs"]` | Tools whose arguments/results carry tab URLs. | The Browser section misses URLs. | as above |
| `rules.toolNames.todo` | `["todowrite","todo_write","*update_todo_list"]` | Todo tools (their latest `todos` is the Open todos section). | Todos lost at compaction. | as above |
| `rules.toolNames.read` | `["read","*read_file","view"]` | Read tools (Files section). | Files not listed. | as above |
| `rules.toolNames.edit` | `["edit","multiedit","apply_patch","*apply_diff"]` | Edit tools (Files, `apply_patch` headers). | As above. | as above |
| `rules.toolNames.write` | `["write","*write_to_file"]` | Write tools. | As above. | as above |
| `rules.toolNames.shell` | `["bash","shell","*execute_command"]` | Shell tools (test runs are recognised by command). | Test tallies not recognised by command (content detection still applies). | as above |
| `rules.mcpServers` | `["playwright"]` | Informational: MCP server names (their tools are prefixed `<server>_`; the default globs match by suffix). | – | client config `mcp` keys |
| `rules.snapshot.stub` | `boundary` | Superseded snapshots become stubs at compactions (`boundary`), at every step (`eager`, an ablation that breaks prefix stability), or never (`off`). | `eager`: prefix-cache misses. `off`: summaries and tails keep dead snapshots. | – |
| `rules.snapshot.slim` | `true` | Slim an oversized snapshot to interactive elements and headings before truncating. | Off: snapshots are cut blindly. | – |
| `rules.snapshot.interactiveRoles` | `link, button, textbox, combobox, option, checkbox, radio, tab, menuitem, switch, slider, searchbox, spinbutton, heading` | ARIA roles kept by slimming. | Missing roles: the agent cannot click them after slimming. | – |
| `rules.snapshot.p90Tokens` | `null` | Informational: p90 snapshot size in tokens; feeds the one-snapshot-per-epoch warning. | Only the warning changes. | `summarize_capture.tool_result_chars_by_tool[*browser_(snapshot\|navigate\|click)].p90 / charsPerToken.snapshot` |
| `rules.test.commands` | regex of `playwright test`, `jest`, `vitest`, `pytest`, `go test`, `mvn … test`, `gradle … test`, `npm/yarn/pnpm (run) test`, `cargo test` | Shell commands whose output is a test run (failure lines + tally kept). | Missing runner: its output is excerpted instead of condensed. | – |
| `rules.test.maxFailureLines` | `12` | Failure lines kept per test run in the tool log. | – | – |
| `rules.excerpt.headChars` | `240` | Head excerpt of other long outputs in the tool log. | – | – |
| `rules.excerpt.tailChars` | `160` | Tail excerpt. | – | – |
| `rules.excerpt.shortVerbatimChars` | `300` | Outputs up to this length are kept verbatim in the tool log. | – | – |

### tokenizer (counting)

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `tokenizer.mode` | `auto` | `auto`: exact when `path` loads, else the estimate; `estimate` forces the estimate (ablation). | – | – |
| `tokenizer.path` | `null` | The served model's HF `tokenizer.json` (exact counting, offline). A file that is missing or fails to load falls back to the estimate with a warning. | A different model's tokenizer: counts off by the vocabulary difference (calibration absorbs up to +5%). | manual |
| `tokenizer.cachePath` | `null` | Compiled tokenizer cache (cold start ~120 ms instead of ~1.3 s); `null` = `<stateDir>/tokenizer-<sha>.lctk`. | Unwritable: only the cache is lost. | – |
| `tokenizer.template.name` | `qwen3` | Chat-template profile: `qwen3` (Qwen3.x Jinja), `chatml`, `generic`, or `sim` (the benchmark mock only). | Wrong template: counts differ from the server's by the template overhead (0.2–1.8%). | – |
| `tokenizer.template.enableThinking` | `null` | Default `enable_thinking` for the template; a request's `chat_template_kwargs` wins. | Wrong: the generation prompt count is off by a few tokens. | client config `models.<id>.options.chat_template_kwargs.enable_thinking` |
| `tokenizer.template.preserveThinking` | `null` | Default `preserve_thinking` (render `<think>` for every assistant turn). | Wrong: reasoning of old turns counted or not. | – |
| `tokenizer.endpoint.style` | `null` | Gateway tokenize endpoint (`vllm`, `sglang`, `llamacpp`, `tgi`): a calibration source used by the proxy after forwarding, never inside the engine. | – | manual (not probed) |
| `tokenizer.endpoint.path` | `null` | Endpoint path; `null` = the style's default. | 404s: calibration from usage only. | manual |
| `tokenizer.endpoint.timeoutMs` | `5000` | Timeout of a tokenize call. | – | – |
| `tokenizer.fallback.charsPerToken.prose` | `5.0` | Estimate: characters per token of prose. | Too high: undercounts (overflows until calibrated). | `probe_gateway.tests.ratio.english_prose.chars_per_token_content` |
| `tokenizer.fallback.charsPerToken.code` | `4.1` | … of code. | As above. | `ratio.typescript_code` |
| `tokenizer.fallback.charsPerToken.snapshot` | `2.9` | … of Playwright snapshots. | As above. | `ratio.playwright_snapshot_en` |
| `tokenizer.fallback.charsPerToken.testOutput` | `2.5` | … of test-runner output. | As above. | `ratio.test_runner_output` |
| `tokenizer.fallback.charsPerToken.json` | `2.33` | … of JSON. | As above. | `ratio.json_api` |
| `tokenizer.fallback.charsPerToken.snapshotNonLatin` | `2.06` | … of non-Latin (Hebrew) snapshots. | As above. | `ratio.playwright_snapshot_he` |
| `tokenizer.fallback.safetyFactor` | `1.1` | Estimate multiplier (the estimate must not undercount). | Lower: overflows in estimate mode. | – |
| `tokenizer.fallback.perMessageOverhead` | `8` | Tokens per message for the `generic` template. | – | – |
| `tokenizer.imageTokens` | `1568` | Tokens counted per image part (images are never tokenized). | Too low for the model's vision encoder: overflows with images. | – |
| `tokenizer.cacheEntries` | `200000` | Size of the per-message count cache (LRU). | Too low: re-tokenizing 300 KB requests (latency). | – |

### calibration

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `calibration.enabled` | `true` | Learn a correction from the server's `prompt_tokens` vs our count. | Off: a systematic undercount is only found through rejections. | – |
| `calibration.usageAvailable` | `null` | Informational: the server reports usage in streams. | – | `probe_gateway.tests.stream.*.usage_present`, `summarize_capture.usage_returned_fraction_of_200` |
| `calibration.upwardOnly` | `true` | The correction never decreases. | Off: an overcount could shrink the margin. | – |
| `calibration.minSamples` | `5` | Accepted samples before a correction applies. | – | – |
| `calibration.maxCorrection.exact` | `1.05` | Cap of the correction in exact mode. | Higher: one bad server report costs more context. | – |
| `calibration.maxCorrection.estimate` | `2.5` | Cap in estimate mode. | – | – |
| `calibration.minCountedTokens` | `4000` | Requests smaller than `max(this, 0.1 · budget)` are not calibration samples (tiny requests have the largest template ratio). | Lower: the correction drifts up to 1.13 from title requests. | – |

### stream

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `stream.injectIncludeUsage` | `false` | Add `stream_options.include_usage` to streamed requests that lack it (and strip the extra usage chunk). OpenCode and Kilo already ask for usage. | On for a server that rejects `stream_options`: one extra retry, then remembered. | `probe_gateway.tests.stream` + `summarize_capture.include_usage_fraction` |
| `stream.holdFirstEvent` | `true` | Hold the response until the first SSE event, so an in-stream error can still be retried. | Off: in-stream overflow errors reach the client as fatal errors. | – |
| `stream.firstEventTimeoutMs` | `15000` | Maximum hold after the upstream headers. | – | – |

### errors

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `errors.useBuiltin` | `true` | Use the built-in error map (vLLM, SGLang, llama.cpp, TGI, LM Studio, Ollama, LiteLLM, OpenAI codes, 413, gateway 5xx). | Off: only `errors.custom` classifies overflows. | – |
| `errors.custom` | `[]` | Extra `ErrorRule`s: `{id, server, status?, match, flags?, json?, kind, on?, lowerBound?, lowerBoundIf?, note?}`; `match` is a JS regex source with named groups `window`, `prompt`, `completion`, `total`, `maxInput`, `chars`, `atLeast`; `status: [null]` = in-stream; `on: "message"` matches the extracted error message. | An unrecognised overflow wording is returned to the client unchanged (no recovery). | escaped overflow messages no built-in matches (`probe_gateway.tests.overflow`, `summarize_capture.errors`); `context_overflow` → `overflow_prompt`/`overflow_unknown`, `output_overflow` → `max_tokens_too_large`, `ambiguous_overflow` → `gateway_error` |
| `errors.exclusions` | `[]` | Extra `{id, match, flags?}` bodies that are never overflows (checked first; rate limits are built in). | – | – |
| `errors.inStream` | `true` | Parse SSE error events after HTTP 200. | Off: in-stream overflows are not recovered. | set `true` when case B errored in-stream |
| `errors.maxRetries` | `2` | Extra upstream attempts per client request (each strictly smaller). | – | – |
| `errors.nearBudgetFraction` | `0.9` | A 502/503/504 or generic error counts as a possible overflow only if the request was ≥ this fraction of `hard`. | Lower: gateway blips cause needless tightening retries. | – |
| `errors.maxTightenFraction` | `0.2` | Cap of the learned tighten, as a fraction of `W − T_plan − margin`. | – | – |
| `errors.translateForClient` | `true` | Translate overflow errors into the 400 `context_length_exceeded` shape OpenCode and Kilo recognise. | Off: TGI 422 / LM Studio wordings are not recognised by the client. | – |

### cache, store, state, stats, misc

| Key | Default | Meaning | If wrong | Probe field |
|---|---|---|---|---|
| `cache.prefixCaching` | `unknown` | Informational: the server has prefix caching (`on`, `off`, `unknown`). | – | `on` when `summarize_capture.cached_prompt_tokens` shows cached tokens |
| `store.persist` | `false` | Persist plans to `<stateDir>/plans/` (saves CPU after a restart; results are identical without it). Plans contain summaries (user content). | – | – |
| `store.maxPlans` | `4096` | Plan memo size (entries). | Too low: extra fold replays (CPU only). | – |
| `store.maxBytes` | `67108864` | Plan memo size (bytes). | As above. | – |
| `stateDir` | `null` | Learned state, plan store and tokenizer cache; `null` = `$XDG_STATE_HOME/kitzur` or `~/.local/state/kitzur`. | Shared between unrelated instances: learned windows leak between them. | – |
| `stats.path` | `null` | JSONL of one record per client request (sizes only, never content). | – | – |
| `shadow` | `false` | Run the engine and record what it would do, but forward the original bytes (calibration can run before enabling). | – | – |
| `digestHook.enabled` | `false` | Documented hook for an optional model-written digest; not implemented in v1 (must stay `false`). | – | – |
| `logLevel` | `info` | `error`, `warn`, `info` or `debug` (stderr; never content). | – | – |

---

## Environment

| Variable | Key |
|---|---|
| `KITZUR_CONFIG` | the config file (`--config`) |
| `KITZUR_PRESET` | the preset (`--preset`) |
| `KITZUR_SET` | `a.b=v;c.d=w` assignments (write `\;` for a literal `;`), applied after the variables below |
| `KITZUR_UPSTREAM_ORIGIN` | `upstream.origin` |
| `KITZUR_HOST` | `listen.host` |
| `KITZUR_PORT` | `listen.port` |
| `KITZUR_SERVER_TYPE` | `server.type` |
| `KITZUR_WINDOW` | `budget.window` |
| `KITZUR_MAX_TOKENS` | `budget.defaultMaxTokens` |
| `KITZUR_TOKENIZER_PATH` | `tokenizer.path` |
| `KITZUR_TEMPLATE` | `tokenizer.template.name` |
| `KITZUR_STATE_DIR` | `stateDir` |
| `KITZUR_STATS_PATH` | `stats.path` |
| `KITZUR_CA_FILE` | `upstream.caFile` |
| `KITZUR_LOG_LEVEL` | `logLevel` |
| `KITZUR_SHADOW` | `shadow` |
| `KITZUR_PRESETS_DIR` | directory of the preset files (default: `presets/` of the installation) |

Empty values are ignored. Other `KITZUR_*` variables produce a warning, except `KITZUR_TEST_*` and
`KITZUR_BENCH_*` (tests and benchmarks). `NODE_EXTRA_CA_CERTS` is honoured by Node for TLS;
`HTTP_PROXY`/`HTTPS_PROXY` are not honoured (kitzur connects to `upstream.origin` directly).

---

## gateway-probes import

```
kitzur config import-eval <dir|file>... [--out kitzur.config.json] [--merge FILE] [--provenance FILE]
        [--dry-run] [--force-keys a.b,c] [--allow-pack-version N] [--json-report] [--port N] [--force]
        [--tokenizer tokenizer.json [--template qwen3]]
```

- **Inputs**: result files (`*.json` with `script` and `pack_version`), pasted blocks
  (`===RESULT-BEGIN name===` … `===RESULT-END name sha256:<16 hex>===` in `*.out|*.txt|*.md|*.log`; the
  checksum is verified, a block altered while copying is ignored with a warning), and optionally the raw
  `capture.jsonl` (for the completion-token p99). A file that differs from the pack's canonical form is
  reported as hand-edited. With several versions of a script the newest `generated` wins; on equal times a
  verified block beats a differing file.
- **Output**: the config (only the knobs the pack determined) and a provenance sidecar
  (`<out>.provenance.json`) with the value, source (`<script>#/json/pointer`), rule and confidence
  (`measured`, `client-config`, `derived`, `operator-assumption`, `inconclusive`, `default`, `manual`) of every
  knob, plus informational values (`tinyPromptTokens`, snapshot `maxTokens`, the base path, observed tool names).
  The report prints the table, the derived budget, the client `baseURL`, warnings, what to set by hand
  (`upstream.origin`, `tokenizer.path`, the tokenize endpoint) and the human questions that affect config.
- **Merge** (`--merge FILE`): a knob is overwritten only if it is absent, or the previous sidecar lists it with
  the value still in the file (imported and not edited since), or it is named in `--force-keys` (a key or a
  section). Hand-set values survive, with a warning when they differ from the measurement. Knobs the pack
  could not determine never overwrite anything. The previous file is kept as `FILE.bak`; comments are not preserved.
- **Never written**: `compaction.triggerTokens`/`targetTokens`, `server.budgetMode`, a base path.
- **`--tokenizer`**: counts the probe's tiny request with the given tokenizer and template and compares it
  with the server's count (`tokenizer.calibration.tinyPromptCheck` in the sidecar).
- **Error rules** come only from overflow statuses (400, 413, 422, 5xx, in-stream): a 401 "invalid token" or a
  429 never becomes an overflow rule. A captured in-stream error gives a rule from the error event in its SSE
  tail, never from content. A JSON body the pack truncated gives its `"message"` string, else a rule on the
  raw body (`on: "body"`).
- **Exit codes**: `0` written and every safety-critical knob (`budget.window`, `budget.limitCountsMaxTokens`,
  `budget.defaultMaxTokens`, overflow recognition) is measured or from the client config; `10` some
  safety-critical knob fell back to a default or is inconclusive; `11` conflicting measurements (different
  measured windows, contradictory overflow cases, different server fingerprints) or a config that is not
  usable (it fails validation, or the measured window and the client's `max_tokens` leave a prompt budget
  under a quarter of the window: set `budget.planMaxTokens`); `1` invalid input.
