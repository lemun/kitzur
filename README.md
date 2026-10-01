# kitzur

[![CI](https://github.com/lemun/kitzur/actions/workflows/ci.yml/badge.svg)](https://github.com/lemun/kitzur/actions/workflows/ci.yml)
[![Node.js ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Kitzur** (Hebrew for “shortcut”) is a zero-dependency Node.js proxy that compacts
OpenAI Chat Completions requests for coding agents using local LLMs with small
context windows. It runs on loopback between your agent and its model server.

It extracts instructions, decisions, todos, file paths and browser state into a
mechanical summary, keeps recent tool calls paired with their results, and trims
oversized tool outputs. No model call is needed for compaction. Forwarded prefixes
stay stable between compactions under the default policy.

Counting uses a supported model tokenizer plus a matching chat-template profile;
unsupported tokenizers can use conservative estimates. Server usage calibrates
counts, and recognized overflow errors trigger bounded retries with smaller requests.
See [DESIGN.md](DESIGN.md) for behavior and limitations.

## Quick start

Node.js 20 or newer is required. From a checkout:

```sh
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

### OpenCode and Kilo Code

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

## Benchmark example

**Historical measurements of simulated sessions with a mock server**, using a
46-step browser automation scenario, a 100,000-token context window and a
32,000-token output allowance. These are token-processing measurements, not
real-model task-quality or inference-speed results.

| System | Prompt tokens, all attempts | Compactions | Planted facts retained |
|---|---:|---:|---:|
| OpenCode compaction mechanics (offline simulation) | 2,492,784 | 6 | Not evaluated |
| gobstopper v0.7.2, tuned | 1,734,118 | 7 | 4/7 |
| kitzur predecessor, defaults | 1,710,746 | 7 | 7/7 |

The figures were transcribed from the pre-release benchmark report's `qa46-ref`
100k/32k rows. The OpenCode simulation uses a scripted summary, not an LLM.
Gobstopper used `--threshold 58000 --keep-recent 2 --carry-max-chars 40000`;
tool outputs were capped at 51,200 bytes. Renaming markers and sanitizing scenario
text changes tokenization, so these figures are not exact targets for this release.
At 32k, the historical run used fewer total tokens but had worse prefix reuse than
the OpenCode comparator; no universal cache-performance advantage is claimed.

The [benchmark guide](bench/README.md) explains how to run fresh comparisons.
Benchmark code ships; generated results and the tokenizer do not.

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

MIT licensed. Portions derive from gobstopper and other upstream projects;
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/](LICENSES/) preserve their notices.
