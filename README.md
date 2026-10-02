# kitzur

### Keep coding in a smaller context window.

A local proxy that shrinks coding-agent requests before they reach your model.
Keeps a structured record of instructions, decisions and open work alongside recent
messages—without calling another LLM.

[![CI](https://github.com/lemun/kitzur/actions/workflows/ci.yml/badge.svg)](https://github.com/lemun/kitzur/actions/workflows/ci.yml)
[![Node.js ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Local compaction · Zero runtime dependencies · OpenAI Chat Completions**

[Try it](#run-a-session-through-kitzur) · [See the numbers](#fewer-tokens-across-the-session) · [Configuration](CONFIG.md) · [Design](DESIGN.md)

## Same session. More room for the next step.

Long coding sessions accumulate file reads, browser snapshots and tool output.
Kitzur sits between your agent and its model server, replacing older history with
a mechanical summary and trimming oversized results as the request fills up.

```text
Without Kitzur   Agent ────────────────────────→ Model server
With Kitzur      Agent → Kitzur on localhost ──→ Model server
                        summary + recent work
```

Here is a **46-step simulated browser session** with a 100,000-token context
window and 32,000 tokens reserved for output. Both arms use the same scripted
scenario; the direct client has no compaction of its own.

| Point in the session | Without Kitzur: direct client | Through the Kitzur proxy |
|---|---:|---:|
| Start · step 1 | 9,376 prompt tokens | 9,376 prompt tokens |
| First overflow · step 11 | 74,445 · **rejected** | 28,251 · accepted |
| Halfway · step 23 | Stopped at step 11 | 30,196 · accepted |
| End · step 46 | Stopped at step 11 | 45,176 · accepted |

**46/46 steps completed through Kitzur · 7/7 planted facts retained · No client errors**

These are measured mock-server requests, not a live model solving a task. The
32,000-token output reservation leaves 68,000 tokens for the prompt at the server;
the direct request at step 11 exceeds that allowance. Kitzur compacts earlier.
[Inspect the recorded measurements](bench/examples/readme-qa46.json).

## Fewer tokens across the session

An agent with its own compaction can also finish. In the same scenario, Kitzur
processed **31.4% fewer prompt tokens** than the offline OpenCode compaction
simulation:

| System | Steps completed | Prompt tokens, all attempts | Planted facts retained |
|---|---:|---:|---:|
| Direct client, no compaction | 10/46 | 429,881¹ | Not comparable: stopped early |
| OpenCode compaction mechanics, offline simulation | 46/46 | 2,492,849 | Not evaluated |
| **Kitzur, default 100k preset** | **46/46** | **1,710,787** | **7/7** |

¹ The direct client's total covers only its partial session, including the rejected
request. The 31.4% comparison uses the two completed sessions.

Measured October 2, 2026, using `qa46-ref` and the Qwen3.6-27B tokenizer. Totals
include rejected attempts and simulated summary requests. OpenCode's simulation
uses scripted summaries, not an LLM. Fact retention checks marker presence, not
model comprehension. These measurements establish compaction behavior, not
inference speed, billing savings or real-model task quality.

[Reproduce this comparison](bench/README.md#readme-demonstration) ·
[Benchmark methodology and historical Gobstopper comparison](bench/README.md)

## What Kitzur keeps in view

| During a long session | What Kitzur does |
|---|---|
| Earlier instructions get buried in tool output | Extracts instructions, decisions, todos, file paths and browser state into a structured summary. |
| The next step depends on recent tool results | Keeps recent tool calls paired with their results. |
| A snapshot or command output dominates the request | Trims oversized outputs to leave room for other context. |
| Requests repeat the same history | Preserves forwarded prefixes between compactions under the default policy. |
| The server counts tokens differently | Calibrates from usage and retries recognized overflows with smaller requests. |

Compaction runs locally and leaves transcript files unchanged. Each summary is
rebuilt from the original history the agent sends. Retention is bounded by the
available budget: under pressure, facts and user text can be shortened.
[How compaction works and where it can lose information](DESIGN.md).

## Run a session through Kitzur

Requires **Node.js 20+**, a running OpenAI-compatible Chat Completions server,
and its model tokenizer. Build from source:

```sh
git clone https://github.com/lemun/kitzur.git
cd kitzur
npm ci
npm run build
node dist/src/cli.js config init --preset 100k --out ~/.config/kitzur/kitzur.jsonc
# Edit upstream.origin and tokenizer.path in the generated file.
node dist/src/cli.js serve -c ~/.config/kitzur/kitzur.jsonc
```

Set `upstream.origin` to the server origin, for example `http://127.0.0.1:8000`,
and `tokenizer.path` to the served model's `tokenizer.json`. The development
helper `scripts/fetch-tokenizer.sh` downloads the Qwen3.6-27B tokenizer for tests;
use your actual model's tokenizer for deployment. The tokenizer is not bundled.

The proxy listens on `http://127.0.0.1:8270`. It appends the client's request path
unchanged: for an upstream API at `http://127.0.0.1:8000/v1`, set the agent's
base URL to `http://127.0.0.1:8270/v1`.

Presets pair context/output limits: `32k`/8k, `64k`/16k, `100k`/32k and `128k`/32k.
Choose limits your server actually serves and configure the agent with the same limits.

### Point your agent at the proxy

Change the agent’s API base URL to **`http://127.0.0.1:8270/v1`**. Requests now
travel through Kitzur before reaching your model server.

An OpenCode provider example (`opencode.json`):

```json
{
  "provider": {
    "kitzur": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local model via kitzur",
      "options": {
        "baseURL": "http://127.0.0.1:8270/v1",
        "apiKey": "{env:GATEWAY_API_KEY}"
      },
      "models": {
        "local-model": {
          "name": "Local model",
          "tool_call": true,
          "limit": { "context": 100000, "output": 32000 }
        }
      }
    }
  },
  "model": "kitzur/local-model",
  "compaction": { "auto": true }
}
```

Replace `local-model` with the model ID your server exposes. Keep the client's
own compaction enabled as a fallback. Kilo uses a similar provider block in
`kilo.json[c]`; its `max_tokens` behavior may need
`budget.maxTokensRestore.enabled: true`. See [CONFIG.md](CONFIG.md).

Check the running proxy from another terminal:

```sh
node dist/src/cli.js status
```

This shows budgets, counters and learned limits. For a packaged installation or a
persistent user service, see [deployment](deploy/README.md).

## Will it work with my setup?

**Which API and agents?** Kitzur supports OpenAI **Chat Completions**. Use an agent
that lets you configure an OpenAI-compatible base URL, such as OpenCode or Kilo
Code. This release does not support OpenAI Responses or Anthropic Messages.

**Which context sizes?** Presets cover 32k, 64k, 100k and 128k windows. Set the
proxy and agent to the limits your server actually serves. Counting uses a supported
tokenizer and matching chat-template profile; unsupported tokenizers can use
conservative estimates. See [tokenizer and budget configuration](CONFIG.md).

**Does it replace the agent's own compaction?** Keep native compaction enabled as
a fallback. Kitzur reduces outgoing requests; client limits and client compaction
can still apply.

**Does compaction call another model?** No. It uses deterministic extraction and
trimming. The configured upstream still receives the forwarded request. Optional
plan persistence stores user content locally; see [security and privacy](SECURITY.md).

## Commands

After installing a locally built package, the CLI is `kitzur`. In a checkout,
use `node dist/src/cli.js` in its place.

```text
kitzur serve                         run the proxy
kitzur status [--url URL]            inspect budgets, counters and learned limits
kitzur config init|show|validate      create or inspect configuration
kitzur config import-eval DIR        import gateway probe results as configuration
kitzur replay FILE|DIR               replay captured request bodies locally
kitzur count request.json            count a request
kitzur state show|reset              inspect or clear learned limits
kitzur bench [--quick]               run benchmarks from a development checkout
```

Status is available at `/status` and `/kitzur/status`. State defaults to
`~/.local/state/kitzur` (or `$XDG_STATE_HOME/kitzur`).
[Deployment instructions](deploy/README.md) cover local packaging and a systemd user service.

## Development

```sh
npm ci
scripts/fetch-tokenizer.sh
npm test
```

Tests that require the development tokenizer skip when it is absent. CI downloads
it and runs the suite on Node 20 and 22. Gobstopper comparisons require a separately
built gobstopper; an external Python reference harness and virtual environment are
optional and used only for the parity cross-check.

See [CONTRIBUTING.md](CONTRIBUTING.md), [CONFIG.md](CONFIG.md),
[DESIGN.md](DESIGN.md) and [SECURITY.md](SECURITY.md).

Kitzur is Hebrew for “shortcut”. MIT licensed. Portions derive from gobstopper and other upstream projects;
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/](LICENSES/) preserve their notices.
