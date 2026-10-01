# Contributing

Use Node.js 20 or newer. Run `npm ci`, `scripts/fetch-tokenizer.sh`, then `npm test`.
The tokenizer download is development data and must stay untracked. Without it,
tokenizer-dependent tests skip. See [bench/README.md](bench/README.md) for optional
comparisons and fixture generation.

Keep runtime dependencies at zero. For behavior changes, include a focused regression
test and update the relevant documentation. Preserve tool-call pairing, deterministic
planning and bounded retries. Bump `ENGINE_ALGO_VERSION` when planning or generated
summary text changes, so persisted plans cannot be reused incorrectly.

Open an issue describing the problem or a pull request explaining the change and
validation. Use synthetic examples; remove credentials, prompts and private URLs
from reports. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
