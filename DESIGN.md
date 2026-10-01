# Design

Kitzur is a loopback HTTP proxy for the OpenAI Chat Completions API. Its compactor
is a synchronous, deterministic function of the original request and explicit
planning inputs. It does not call a model or change transcript files.

## Request path

```text
agent → HTTP listener → Chat Completions parser → engine → upstream server
                            ↓                     ↓            ↓
                     unchanged passthrough     plan cache   SSE relay
                                                           usage / errors
                                                                 ↓
                                                         learned limits
```

`src/config/` loads JSON/JSONC, presets, environment variables and CLI overrides.
`src/dialect/` handles the wire format. `src/engine/` plans and guards rewrites;
`src/tokenize/` counts them locally. `src/proxy/` owns network I/O, streaming,
calibration and persistence. `bench/` contains independent mock-server counters,
scripted clients, scenario generators and result analysis.

## Planning and prefix stability

The head contains the initial system/developer/user messages. The rest is divided
into units that keep an assistant's tool calls with their results. Compaction cuts
only at unit boundaries and retains the newest assistant unit and later user input.

The engine folds over request boundaries in the original history. Message digests
include all fields; a chain digest and planning inputs identify cached plans.
A cache miss replays the fold, so restarting with an empty cache produces the same
output for identical history and planning inputs. Algorithm version, configuration,
tokenizer identity, template settings, learned limits and calibration are inputs.
`ENGINE_ALGO_VERSION` must change when summary text or planning behavior changes.

Between compactions, already forwarded messages retain their canonical values under
the default policy. Newly arrived oversized results can be slimmed on admission.
A compaction, changed planning inputs or a client history edit starts a new prefix
epoch. The optional eager snapshot policy relaxes prefix stability.

## Budgets and counting

The prompt budget reserves the configured planning output allowance and a safety
margin from the context window. The compaction trigger also leaves room below the
client's own compaction threshold. Planning uses a configured output allowance;
the requested output length is fitted separately for each request.

Exact text counting supports the implemented ByteLevel BPE tokenizer features,
pinned NFC data and supported chat-template profiles. Unsupported tokenizer features
are rejected, with configurable estimate fallback. Exact tokenization alone does
not guarantee a matching server count: template choice, tools, reasoning and images
also affect rendering. Images use a configured estimate.

Usage and optional remote token counts calibrate future requests. The engine never
performs a network count inside its fold. Calibration is filtered, bounded and
quantized; a changed correction invalidates affected plans.

## Mechanical summary

At each compaction the summary is rebuilt from the original messages, rather than
repeatedly summarizing earlier summaries. It records user instructions, decisions,
open todos, files, browser state, the last test result and concise assistant/tool notes.
A deterministic priority order chooses what fits; user instructions have the highest
priority. Correction detection uses explicit IDs and word overlap, including Hebrew
cues. It is heuristic and can miss corrections or retain obsolete instructions.

The standard summary header interoperates with gobstopper and CliffCompaction.
A `[kitzur]` footer marks the compacted range. Summaries default to a user message
after the head; a configuration option merges them into the first user message.

## Oversized input and guards

Old snapshots can become stubs. Large current snapshots retain interactive elements
and headings; other oversized results keep a head and tail with an omission marker.
The fit loop first reduces old context and low-priority summary material, then tool
outputs, images and reasoning. Under pressure it can shorten facts and user text.
The first user message may be truncated under the default head policy; system prompts
and tool definitions are preserved.

Before forwarding a rewrite, guards check tool pairing, prompt size, message count,
head preservation and request validity. A rewrite must not increase the input's token
or message-body size. A fixed prompt that cannot fit returns
`kitzur_fixed_prompt_too_large` without an upstream request. Some fallback paths
reduce the output allowance to fit the server even when the normal prompt budget is
exceeded. If counting itself fails, the documented fail-open path can forward the
original request. See [CONFIG.md](CONFIG.md) for configuration and error behavior.

## Recovery and streaming

Recognized overflow errors update per-origin/model limits and trigger bounded
replanning. Overflow retries must shrink tokens or output allowance, and cannot
increase message-body bytes. A rejected rewrite can resend the original once when
it fits. Unrelated errors pass through.

The SSE relay holds headers until the first event or a bounded timeout so an early
stream error can be recovered. It handles backpressure, disconnects, usage records
and incomplete streams. Learned state is persisted before requests use it.

## State, scope and limitations

Plan persistence is optional and contains user content. Default disk state holds
learned limits and tokenizer caches. The listener checks Host headers and forwards
to one configured upstream. See [SECURITY.md](SECURITY.md).

This release supports Chat Completions, not Responses or Anthropic Messages.
It performs mechanical extraction, not semantic reasoning. Short windows can require
lossy truncation. Some reserved configuration hooks are unimplemented and warn when
set. Ledger word classification uses the runtime's Unicode properties, so unusual
characters may behave differently across Node versions even though tokenizer tables
are pinned. Mock benchmarks validate mechanics and invariants; real-model usefulness
must be evaluated on representative workloads.
