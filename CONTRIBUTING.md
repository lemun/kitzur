# Contributing

Use Node.js 22 or newer; CI runs the tests on Node 22, 24 and 26. Run `npm ci`,
`scripts/fetch-tokenizer.sh` (needs `curl`), then `npm test`.
The tokenizer download is development data and must stay untracked. Without it,
tokenizer-dependent tests skip (CI runs them). Where the download host is blocked,
`KITZUR_TOKENIZER_OPTIONAL=1 scripts/fetch-tokenizer.sh` reports the failure and
exits 0. See [bench/README.md](bench/README.md) for optional comparisons and
fixture generation.

To run one test file, build and pass its compiled path, for example
`npm run build && node --test dist/test/docs/hygiene.test.js`. CI runs
`npm test -- --test-concurrency=2`. `scripts/run-tests.mjs` fails the run when a
test leaves a `kitzur-proxy-test-*` folder behind in the temp directory.

Keep runtime dependencies at zero. For behavior changes, include a focused regression
test and update the relevant documentation. Preserve tool-call pairing, deterministic
planning and bounded retries. Bump `ENGINE_ALGO_VERSION` when planning or generated
summary text changes, so persisted plans cannot be reused incorrectly. Add a
plain-language line under `## [Unreleased]` in `CHANGELOG.md` for every
user-visible change.

Tests scan every tracked file for private details: home directory paths, internal
hostnames, private IP addresses, email addresses and ULID-shaped ids fail the run.
Use placeholders such as `<user>` and reserved example domains instead.

Open an issue describing the problem or a pull request explaining the change and
validation. Use synthetic examples; remove credentials, prompts and private URLs
from reports. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
