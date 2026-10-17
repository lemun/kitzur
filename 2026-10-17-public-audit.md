# Kitzur public-repo audit, 2026-10-17

Audited commit `4927643` on `main` (v0.1.0 plus the 2026-10-16 commits). Linux container, Node 22.22.0, npm 10.9.4.
Report only: no source changed.

## Top issues

| # | Area | Severity | Finding |
|---|---|---|---|
| S1 | Proxy security | **High** when `upstream.headers` carries a gateway key, Low for an unauthenticated local server | Any web page can send chat requests through the proxy. The Host check stops DNS rebinding but not a direct cross-site request to `127.0.0.1:8270`. The request is forwarded with `upstream.headers` attached. If the upstream sends permissive CORS, the page can also read the response. |
| S2 | Proxy security | Medium | There is no client authentication, so every local process and user on the machine gets the configured gateway credentials. |
| S3 | Proxy security | Medium | Each request may be up to 256 MiB, fully buffered, with no concurrency cap. One 200 MiB request peaked at 1.3 GB RSS. |
| D1 | Docs | Medium | SECURITY.md says there is no per-request log line. Since `bae4742` there is one. |
| D2 | Docs / CI | Medium | The README and Windows docs say CI runs Node 20 and 22, but `ci.yml` runs 22, 24 and 26. `engines` is still `>=20` (Node 20 is end-of-life and untested). |
| F1 | First run | Low | The dev tokenizer download is the only step that needs a non-npm host. Where that host is blocked, `fetch-tokenizer.sh` fails with a bare curl error, which breaks the `&&` chain even though the tests skip cleanly without the tokenizer. |
| F2 | Tests | Low | `test/proxy/state.test.ts:31` ("planning and sample writes coalesce off the request path") is timing-dependent: it waits a fixed 100 ms for a 30 ms debounced async write. It failed on this PR's `test (22)` CI job, which touches no code, while the same source is green on `main`. |
| P1 | Private data | Low | No secrets, personal paths, emails or credentials were found anywhere. Two low-sensitivity items about internal process are listed in section 3. |

## 1. First-run experience on a clean machine

### The requested command

| Step | Result |
|---|---|
| `npm ci` | OK, 1.5 s, 3 packages (dev only), 0 vulnerabilities. |
| `sh scripts/fetch-tokenizer.sh` | **Failed here**: `curl: (22) ... 403`. The cause is this audit container's network policy blocking huggingface.co, not the repo. The script is correct: it pins a revision and checks a SHA-256. Because the chain uses `&&`, the tests would not run. I ran them anyway. |
| `npm test -- --test-concurrency=2` | **Pass**: 646 tests, 553 pass, 0 fail, 93 skipped, 70 s wall time including `tsc`. 90 of the skips say the dev tokenizer is missing, 2 need exact counts, and 1 needs a Windows runner. Exact-tokenizer coverage was therefore not exercised here. CI's `test` job covers it. |

The dot reporter prints no totals, so a passing run looks like rows of dots and nothing else. I reran with `--test-reporter=tap` to get the counts.

### Following README.md step by step

| README step (line) | What happened | Status |
|---|---|---|
| Requirements (88-89): "Node.js 20+ ... and its model tokenizer" | The tokenizer is optional. With `tokenizer.path: null`, serve starts and uses the per-class estimate, with a warning in the log. The README makes it sound mandatory. | Unclear |
| `git clone`, `npm ci`, `npm run build` (91-95) | OK. | OK |
| `config init --preset 100k --out ~/.config/kitzur/kitzur.jsonc` (96) | OK. It writes 37 lines and prints the next step (`config validate`). | OK |
| "Edit upstream.origin and tokenizer.path" (97, 101-104) | The generated file explains both keys well. Running `serve` without editing exits 2 with a clear message naming three ways to set the origin. | OK |
| `serve -c ...` (98) | OK. It prints `listening on http://127.0.0.1:8270` to stdout. Everything else goes to `<stateDir>/logs/kitzur-YYYY-MM-DD.log` (dir 0700, file 0600). New users won't know where the warnings went. The README explains this only at line 231. | Unclear |
| Base URL `http://127.0.0.1:8270/v1` (106-108, 115) | OK against a mock upstream. A chat request returned 200 with `x-kitzur-action` and `x-kitzur-tokens` headers. | OK |
| OpenCode example (118-142) | `"apiKey": "{env:GATEWAY_API_KEY}"` is not explained. A local server usually needs no key, and the reader isn't told whether to set the variable, leave it unset, or use any value. | Unclear |
| `node dist/src/cli.js status` (152) | OK while serving. With no server it prints `cannot reach ...: connect ECONNREFUSED` and exits 1, which is clear. On a non-default port it needs `-c` or `--url`, and the quick start doesn't say so. | Minor |
| Commands table (177-193) | Matches `--help`, except that `version` is missing from the table. "After installing a locally built package" is never explained. The quick start has no `npm pack` / `npm i -g` step. The only packaging path is `scripts/pack-offline.sh` in `deploy/README.md`. | Gap |
| `kitzur doctor` | OK. It reports 2 warnings for an unedited tokenizer and exits 0. | OK |
| Development (201-209) | `scripts/fetch-tokenizer.sh` is executable (mode 755) and needs `curl`, which isn't listed. The CI claim is wrong (see D2). | Wrong |
| Background running, Linux (256-273) | The README unit differs from `deploy/kitzur.service`: it uses `--config` where the deploy unit uses `KITZUR_CONFIG`, and it adds StandardOutput files. Both work, but two variants side by side confuse readers. The macOS and Windows steps weren't run (no hosts). | Minor |

### Other first-run notes

- `deploy/kitzur.service:5` and `deploy/README.md:85` still say `journalctl --user -u kitzur -f` shows the logs. Since `4927643`, serving logs go to the rotating file in the state dir. The journal gets only the startup line and fatal errors.
- `npm pack --dry-run` produces 185 files, 399 kB packed. There are no tests, bench files, tokenizer or `.env` files in it, and the `files` allowlist plus `.gitignore` keep tokenizers out.

## 2. Security of the local proxy

### Bind address

- The default is `127.0.0.1:8270` (`src/config/schema.ts:206`). A non-loopback `listen.host` only produces a warning (`src/config/validate.ts:302-304`), and `allowedHosts: ['*']` produces a warning too (`:305`). This is a reasonable default.
- `status` and `doctor` map `0.0.0.0` and `::` to loopback when probing (`src/cli.ts:535`, `src/diagnostics/doctor.ts:27`). OK.

### S1: cross-site requests reach the upstream with injected credentials

`handle()` (`src/proxy/server.ts:180-209`) checks only `Host`. It doesn't look at `Origin`, `Sec-Fetch-Site` or `Content-Type`. `parseChatRequest` (`src/dialect/openai-chat.ts:51-64`) parses any body as JSON whatever its content type. `forwardRequestHeaders` (`src/proxy/upstream.ts:44-58`) passes the browser's `Origin` through and adds `upstream.headers`.

The attack: a page on any site does `fetch('http://127.0.0.1:8270/v1/chat/completions', {method:'POST', mode:'no-cors', headers:{'content-type':'text/plain'}, body:'{"model":..,"messages":[..]}'})`. That is a CORS "simple request", so there is no preflight. Its `Host` is `127.0.0.1:8270`, which is allowed.

I reproduced this with a mock upstream that answers with `Access-Control-Allow-Origin: *`, and kitzur started with `--set upstream.headers.Authorization='Bearer <synthetic>'`:

| Probe | Result |
|---|---|
| `POST /v1/chat/completions`, `Origin: https://evil.example`, `Content-Type: text/plain` | 200. The upstream received it with the injected `Authorization` and the attacker's `Origin`. The response carried the upstream's `access-control-allow-origin: *`. |
| `OPTIONS /v1/chat/completions` (preflight) | Passed through to the upstream with the injected `Authorization`. The upstream's CORS approval came back, which also enables non-simple requests (JSON bodies, custom headers) and reading the replies. |
| Same request with `Host: evil.example:8270` (rebinding) | 403. The guard works for its stated case. |
| `GET /status` with an `Origin` header | 200 with no CORS headers, so a page can trigger it but can't read it. |

Impact:
- With a remote gateway and a key in `upstream.headers`, which is the setup `deploy/README.md` describes, any website the user visits can spend the gateway quota and reach every gateway path through the pass-through route.
- If the gateway or local server sends permissive CORS, the site can also read model output. That includes anything the model was primed with, but not other sessions' history, which kitzur doesn't store by default.
- With an unauthenticated local llama.cpp or vLLM, the proxy adds little risk beyond what the bare server already has.
- Some browsers now gate public-to-loopback requests behind a permission prompt (Private/Local Network Access). I inferred this and did not test it in a browser, so it can't be relied on.

Suggested fix, smallest first:
1. Reject any request that has an `Origin` header (or `Sec-Fetch-Site: cross-site|same-site`) unless the origin is in a new `listen.allowedOrigins`, empty by default. CLI agents don't send `Origin`. An Electron-based client would need its origin listed.
2. Answer `OPTIONS` locally with 403 instead of passing it through.
3. Optionally require `Content-Type: application/json` on chat requests.
4. Add a test next to the Host-check tests in `test/proxy/adversarial-http.test.ts`, and a line in SECURITY.md "Network".

### S2: no client authentication

No setting asks clients for a secret. SECURITY.md says so implicitly ("every request that passes the Host check"). On a shared machine, every local user can reach `127.0.0.1:8270` and get the `upstream.headers` credentials. Suggested fix: an optional `listen.token` (or a token file under the 0700 state dir) checked against a client header, with a startup warning when `upstream.headers` is set and no token is. Document the threat model either way.

### S3: request size and memory

- `MAX_REQUEST_BYTES = 256 MiB` (`src/proxy/server.ts:110`). `readRequest` (`:211-225`) buffers the whole body, then `JSON.parse` makes another copy. There is no limit on concurrent requests.
- Measured: one 200 MiB chat request took peak RSS from 76 MB to 1.32 GB and ran for 31 s. A few in parallel would exhaust memory on a typical laptop and kill every session using the proxy.
- An oversize body keeps being read to the end before the 413 (`:218`). Node's default `requestTimeout` (300 s) bounds that.
- Suggested fix: a configurable `listen.maxRequestBytes` with a default near 32 MiB (real agent requests for a 128k window are a few MiB), a small in-flight byte budget, and `req.destroy()` once the limit is passed.

### Log contents

- Verified: the startup and per-request log lines hold the origin, budgets, sizes, action, model and timing. They don't contain message content or header values, and the synthetic key never appeared in the log, `/status` or stdout. `model` comes from the client but is written with `JSON.stringify`, so it can't inject newlines (`src/proxy/server.ts:287`).
- Error paths log `e.message` (`:152`, `:377`, `:582`). For network errors that is host and port only. For an unexpected engine exception I didn't prove it can never include content (inferred to be low risk).
- Stats, learned state, plans and logs are written 0600 under 0700 dirs (`src/proxy/stats.ts:57`, `src/proxy/state.ts:45,75`, `src/app.ts:109-110`, `src/diagnostics/runtime.ts:49,66`).
- **D1**: SECURITY.md:45-46 says "There is no per-request log line". It's out of date since `bae4742`. The new line is content-free, so the fix is wording only.

## 3. Private data in the tree and history

What I scanned:
- every tracked file on `main`, plus the decompressed contents of all 17 `*.gz` fixtures
- every public ref: 5 non-main branches, `refs/pull/1..9`, and tag `v0.1.0`
- added lines across all fetched history
- all 19 commit messages on `main` and every commit on the other refs
- titles and bodies of PRs #1 to #9

Patterns: home-directory paths (macOS, Linux and Windows forms), email addresses, IPv4 addresses, API-key and token shapes (OpenAI, GitHub, Hugging Face, AWS), private hostnames (`.local`, `.lan`, `.internal`, tailnet, ngrok), and names of the owner's other projects and tools.

| Result | Detail |
|---|---|
| Secrets / keys / tokens | None. The only key-like strings are the public tokenizer SHA-256 and a placeholder in `deploy/windows/profile.example.json`. |
| Personal paths | None. The fixtures use `/users/example/...` placeholders. The gateway-probe fixture uses a `<host>` placeholder and `null` origins. |
| Emails | Commit author emails are GitHub noreply addresses. No other addresses. |
| IPs / hostnames | Loopback and test-net only. |
| Captured sessions | The two engine repro files and the scenario fixtures are synthetic: scripted shop-checkout pages and placeholder paths. Nit: they use the domain `staging.shop`, which is under a real TLD and could be registered. `.example` would be safer (`test/engine/repros/repro-4873.json.gz`, `repro-8648.json.gz`). |
| Internal process notes (low) | `IMPROVEMENT-PROGRAM.md` (tracked but not in the npm package) and the body of open PR #4 name internal agent reviewer roles and describe private workflow decisions such as deferred model capacity and paid endpoints. Nothing secret, but it's internal process in a public repo. Consider trimming it or moving it out of the public tree. |
| Branch names (low) | The head branch of closed PR #1 hints at the owner's intended deployment environment. A merge commit on the PR #9 branch (`f0054ab`) names an internal working branch. Neither is sensitive. Deleting merged/closed branches would tidy this. |

## Suggested follow-up units

1. **proxy-origin-guard**: reject cross-origin requests and answer `OPTIONS` locally (S1), with tests and a SECURITY.md note.
2. **proxy-request-limits**: configurable body limit, an in-flight byte budget, and early `destroy()` (S3).
3. **proxy-client-token**: optional client token, plus a warning when `upstream.headers` is set without one (S2).
4. **docs-public-refresh**: fix SECURITY.md:45, the README CI and Node lines (207-209), Windows ADMIN.md:69-72, the `journalctl` lines in `deploy/`, mark the tokenizer as optional in the requirements, explain `GATEWAY_API_KEY`, add a local-install step, add `version` to the command table, and decide on `engines` (Node 20 is end-of-life and no longer tested).
5. **state-test-deflake**: in `test/proxy/state.test.ts:31`, poll until `s.writes === 1` (with a generous deadline) instead of a fixed `sleep(100)` (F2).
6. **dev-tokenizer-hint**: make `fetch-tokenizer.sh` print "tests will skip tokenizer cases without it" on download failure, and have `run-tests.mjs` print a pass/skip summary line.
7. **repo-hygiene**: switch the `staging.shop` fixtures to `.example`, trim internal notes from `IMPROVEMENT-PROGRAM.md`, and delete stale merged branches.
