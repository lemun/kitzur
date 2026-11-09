# Proposal: legacy `/v1/completions` prompts

Status: option A is implemented, B is not. Kitzur only compacts chat requests. Tools that send plain
prompts to `/v1/completions` (editor autocomplete with fill-in-the-middle, plain-prompt
endpoints, some agent frameworks) get no help when a prompt overflows the served window,
and no document says so.

## 1. Today

- `isChatCompletionsPath` (`src/dialect/openai-chat.ts:22`) matches only `POST .../chat/completions`;
  `test/proxy/dialect.test.ts:19` asserts that `POST /v1/completions` does not match.
- Every other request goes through `passthrough()` (`src/proxy/server.ts:397`) unchanged. It only
  bumps `passthrough_requests` in `/status`: no token count, no stats record, no `x-kitzur-*` header.
- `test/proxy/server.test.ts:584-585` pins the `/v1/embeddings` passthrough.

| Endpoint | Compacted | Counted | Passthrough |
| --- | --- | --- | --- |
| `POST .../chat/completions` | yes | yes | only when it fits or cannot be parsed |
| `POST /v1/completions` | no | no | yes |
| `POST /v1/embeddings` | no | no | yes |
| `GET /v1/models` | no | no | yes (Kitzur also probes it at startup) |
| `GET /props` | no | no | yes (Kitzur also reads it to learn the window) |
| `GET /status`, `/kitzur/status` | served locally | n/a | no |
| anything else | no | no | yes |

## 2. Options

- **A. Document the limit.** State it in the README and CONFIG.md; `kitzur doctor` and the first
  passthrough of a `/v1/completions` request log one line: "legacy completions are not compacted".
- **B. Count only.** Parse `prompt` (string or string array), count it with the model's counter, and
  when it exceeds the budget set `x-kitzur-action: passthrough` and `x-kitzur-tokens`, and write a
  stats record with action `passthrough`. The body is never rewritten.
- **C. Head+tail truncation.** Cut a plain string prompt with `truncateHeadTail`
  (`src/engine/text.ts:102`, used by `src/engine/oversize.ts`) and `oversize.headShare`.
- **D. Map to one user message** and run the chat engine. Unsafe: a fill-in-the-middle prompt is
  `<fim_prefix>…<fim_suffix>…<fim_middle>` with no chat template. The engine would keep the head and
  tail of the text, may cut a sentinel or the suffix, and the model would then complete at the
  wrong place without any error. Chat-template counting would also be wrong for raw prompts.

## 3. Recommendation

A first, then B. Both are read-only towards the prompt, so they cannot corrupt it. A silently
corrupted FIM prompt is worse than an overflow error: the server's error is visible and the
client can retry with less context, a bad completion is not.

New config keys (B): `legacyCompletions.count` (default `true`) and `legacyCompletions.warn`
(default `true`, controls the log line from A). C would add `legacyCompletions.truncate`
(default `false`) and must refuse prompts that contain known FIM sentinels. D is not recommended.

Failure modes:
- A: none in the request path; the line may be missed if logs are not read.
- B: counting adds latency on large prompts; a counter that is wrong for raw text gives a wrong
  "over budget" signal, but the request is still forwarded unchanged.
- C: drops the middle of a prompt the user wrote; sentinel detection can miss model-specific tokens.
- D: silent corruption of FIM prompts (see above).

## 4. Effect on status, stats and JSON output

- `/status`: a new informational counter `legacy_completions` and `legacy_over_budget` next to
  `passthrough_requests`; `actions.passthrough` counts B's records.
- Stats records: one record per counted legacy request with `action: "passthrough"` and an
  `endpoint: "completions"` field, so existing chat-only readers can filter it out.
- `docs/JSON-OUTPUT.md`: list the two counters as informational and the new `endpoint` field.

## 5. Test plan

Use `test/proxy/harness.ts` (`fakeUpstream`, `startProxy`, `request`, `waitRecords`):
- a `/v1/completions` body reaches the upstream byte for byte, with and without B enabled;
- B: an over-budget string prompt and a string-array prompt set `x-kitzur-action: passthrough`
  and produce one stats record; an under-budget prompt produces none;
- B: an unparseable body is forwarded unchanged with `unknown` counts;
- A: the warning line is logged once per process, and `kitzur doctor` reports it;
- C (if built): a prompt with `<fim_prefix>` is never rewritten.

## 6. Follow-up units

1. Docs and warning (A): `README.md`, `CONFIG.md`, `src/proxy/server.ts`, `src/cli/commands/diagnostics.ts`,
   `test/proxy/server.test.ts`. About 80 lines.
2. Count-only (B): `src/dialect/openai-completions.ts` (new), `src/proxy/server.ts`,
   `src/proxy/stats.ts`, `src/proxy/status.ts`, `src/config/schema.ts`, `src/config/spec.ts`,
   `test/proxy/legacy-completions.test.ts` (new). Under 300 lines.
3. JSON output docs: `docs/JSON-OUTPUT.md`, `docs/proposals/legacy-completions.md` (mark done).

## 7. Open questions

- Should B's stats records go into the same file as chat records, or be counted only in `/status`?
- Is truncation (C) wanted at all, or should over-budget legacy prompts stay an upstream error?
- Should `/v1/embeddings` inputs be counted the same way as B?
- Which FIM sentinel sets (StarCoder, CodeLlama, DeepSeek, Qwen) must C recognise before it ships?
