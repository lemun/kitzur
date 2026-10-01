# Installing kitzur as a user service (offline)

kitzur has no runtime dependencies: the offline bundle is the compiled `dist/src`, the presets, this
directory and the docs. It needs Node.js 20 or newer and nothing else. No step below uses the network.

## 0. Build the bundle (on a machine with the repository)

```sh
scripts/pack-offline.sh            # -> dist/offline/kitzur-<version>-offline.tar.gz, kitzur-<version>.tgz, SHA256SUMS
```

Copy `kitzur-<version>-offline.tar.gz` and `SHA256SUMS` to the deployment host, plus the served model's
`tokenizer.json` (for Qwen3.x: `https://huggingface.co/Qwen/<model>/resolve/main/tokenizer.json`).

## 1. Unpack and verify

```sh
sha256sum -c --ignore-missing SHA256SUMS
mkdir -p ~/.local/lib && tar -xzf kitzur-<version>-offline.tar.gz -C ~/.local/lib
mv ~/.local/lib/kitzur-<version> ~/.local/lib/kitzur        # the unit expects this path
(cd ~/.local/lib/kitzur && sha256sum -c SHA256SUMS)          # every file of the bundle
node --version                                                # v20 or newer
mkdir -p ~/.local/bin && ln -sf ~/.local/lib/kitzur/dist/src/cli.js ~/.local/bin/kitzur
kitzur version
```

`~/.local/bin` must be on your `PATH` for the `kitzur` command; otherwise run
`node ~/.local/lib/kitzur/dist/src/cli.js`.

## 2. Configure

```sh
mkdir -p ~/.config/kitzur ~/.local/share/kitzur
cp tokenizer.json ~/.local/share/kitzur/tokenizer.json
kitzur config init --preset 100k --out ~/.config/kitzur/kitzur.jsonc
```

Edit `~/.config/kitzur/kitzur.jsonc`:
- `upstream.origin`: the gateway as `scheme://host[:port]`, **without** its path (`https://gw.example`);
- `tokenizer.path`: `~/.local/share/kitzur/tokenizer.json`;
- `server.type`, if known (`vllm`, `sglang`, `llamacpp`, `tgi`, `ollama`, `lmstudio`, `litellm`);
- `preset` to the served window: `32k`, `64k`, `100k` (32k output) or `128k`.

If you have gateway probe results in the supported JSON format, import measured settings (hand edits are kept):

```sh
kitzur config import-eval ~/gateway-probes/results --merge ~/.config/kitzur/kitzur.jsonc
```

Then check it: `kitzur config validate -c ~/.config/kitzur/kitzur.jsonc` (errors exit 2) and
`kitzur config show -c ~/.config/kitzur/kitzur.jsonc` (every value with its source, and the derived budget).

### TLS

For an `https` gateway with an custom CA, either set `upstream.caFile` in the config, or uncomment
`NODE_EXTRA_CA_CERTS` in the unit. At startup kitzur sends `GET <origin>/v1/models`: a certificate that does
not verify makes the service exit 1 with the cause in the journal (systemd retries it every few seconds until
the CA is fixed); an unreachable gateway is only logged (and shown in `/status`), and the proxy keeps running.
A config error exits 2, which the unit does not restart (`RestartPreventExitStatus=2`). `upstream.insecureTls: true` disables verification (not recommended).
`HTTP_PROXY`/`HTTPS_PROXY` are not honoured: the gateway must be reachable directly.

## 3. Install the service

```sh
mkdir -p ~/.config/systemd/user
cp ~/.local/lib/kitzur/deploy/kitzur.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kitzur
loginctl enable-linger "$USER"            # optional: run without an open login session
```

If `node` is not on the user manager's `PATH` (nvm, mise, a tarball install), edit `ExecStart` in the unit
to the absolute path of `node`, then `systemctl --user daemon-reload && systemctl --user restart kitzur`.

Check it:

```sh
systemctl --user status kitzur
journalctl --user -u kitzur -f           # sizes and decisions only, never prompt content
kitzur status                            # GET /status: budget, counter mode, learned entries, counters
```

## 4. Point the agent at it

The client's `baseURL` is `http://127.0.0.1:8270` plus the gateway's path, e.g. `http://127.0.0.1:8270/v1`
or `http://127.0.0.1:8270/llm/v1`. Declare the served limits truthfully (OpenCode/Kilo
`limit.context`/`limit.output` equal to the preset). See CONFIG.md "Client setup".

## Operations

- **Restart / upgrade**: `systemctl --user restart kitzur`. SIGTERM drains in-flight streams, then flushes
  learned state and stats. Plans are a pure function of each request's history, so a restart changes nothing
  the agent sees. To upgrade, unpack the new bundle next to the old one, verify it, replace
  `~/.local/lib/kitzur` with it (so no file of the old version stays behind) and restart.
- **State**: `~/.local/state/kitzur` (`$XDG_STATE_HOME/kitzur`): `learned.json` (windows and limits learned
  from errors, calibration), the tokenizer cache, and `plans/` when `store.persist` is on. Entries learned under
  another `budget.window` or tokenizer are discarded automatically. Inspect or clear them with
  `kitzur state show` and `kitzur state reset [--key <origin|model>]`, then restart the service.
- **Stats**: set `stats.path` to get one JSONL record per request (sizes only).
- **Uninstall**: `systemctl --user disable --now kitzur`, remove `~/.config/systemd/user/kitzur.service`,
  `~/.local/lib/kitzur`, `~/.local/bin/kitzur`, `~/.config/kitzur` and `~/.local/state/kitzur`.
