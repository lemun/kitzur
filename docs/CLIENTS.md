# Connect any OpenAI-compatible client

Kitzur speaks OpenAI Chat Completions. Any client that lets you set a base URL can use it; OpenCode and Kilo have their own [client setup](../CONFIG.md#client-setup-opencode-and-kilo);
Continue, Aider and Open WebUI are under [other coding tools](#other-coding-tools).

## What the client needs
- Base URL `http://127.0.0.1:8270/v1` (the port is [`listen.port`](../CONFIG.md#listen)).
- A model name the upstream serves.
- An API key: `listen.token` when it is set. Without `listen.token` the key is forwarded to the upstream,
  so use the upstream key, or any placeholder when the upstream needs none or `upstream.headers` carries the authorization.
- The model's real context window and output limit, so the client does not compact at a point Kitzur does not know (see [budgets](../CONFIG.md#budgets-and-the-presets)).
- Chat Completions only. Kitzur compacts `POST /v1/chat/completions`; other paths, such as `GET /v1/models`, are forwarded to the upstream unchanged.
  OpenAI Responses and Anthropic Messages are not supported.

## Smoke test with curl
```sh
curl -sS -D - http://127.0.0.1:8270/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <listen.token>' \
  -d '{"model":"<model>","messages":[{"role":"user","content":"Say hi"}]}'
```
Drop the `Authorization` line when `listen.token` is not set. The response headers show Kitzur is in the path:
```text
x-kitzur-action: passthrough
x-kitzur-tokens: <in>/<out>/<trigger>
```
A short request stays below the trigger, so the action is `passthrough`; long sessions show `compact`, `reuse`, `clamp` or `truncate` ([request visibility](../CONFIG.md#request-visibility)).
Add `"stream":true` to the body and `-N` to curl: the same headers arrive before the first `data:` chunk.
Then run `kitzur status`; the request appears among the recent requests.

## OpenAI Python SDK
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8270/v1", api_key="<listen.token>")
raw = client.chat.completions.with_raw_response.create(
    model="<model>", messages=[{"role": "user", "content": "Say hi"}])
print(raw.headers.get("x-kitzur-action"), raw.parse().choices[0].message.content)
```
Streaming works unchanged: `client.chat.completions.create(..., stream=True)`.

## OpenAI Node SDK
```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8270/v1', apiKey: '<listen.token>' });
const { data, response } = await client.chat.completions
  .create({ model: '<model>', messages: [{ role: 'user', content: 'Say hi' }] })
  .withResponse();
console.log(response.headers.get('x-kitzur-action'), data.choices[0].message.content);
```
Streaming works unchanged: `create({ ..., stream: true })`.

## Tools that read environment variables
Both SDKs, and tools built on them, read these when no base URL or key is passed:
```sh
export OPENAI_BASE_URL=http://127.0.0.1:8270/v1
export OPENAI_API_KEY='<listen.token>'
```
On Windows (PowerShell): `$env:OPENAI_BASE_URL = 'http://127.0.0.1:8270/v1'`.

## Other coding tools
Each tool needs the same two things: a base URL ending in `/v1`, and `listen.token` as the key when one is set
(otherwise the upstream key or a placeholder, as above). To check it worked, send a request from the tool and run `kitzur status`.

### Continue
A model entry in `~/.continue/config.yaml`:
```yaml
name: kitzur
version: 0.0.1
schema: v1
models:
  - name: Kitzur
    provider: openai
    model: <model>
    apiBase: http://127.0.0.1:8270/v1
    apiKey: <listen.token>
```

### Aider
```sh
aider --openai-api-base http://127.0.0.1:8270/v1 --openai-api-key '<listen.token>' --model openai/<model>
```
Or set `OPENAI_API_BASE=http://127.0.0.1:8270/v1` and `OPENAI_API_KEY`, and pass only `--model openai/<model>`.
The `openai/` prefix tells Aider to use the OpenAI-compatible API at that base URL.

### Open WebUI
In Admin settings, Connections, add an OpenAI API connection: URL `http://<host>:8270/v1`, key `<listen.token>`.
On the same machine, `<host>` is `127.0.0.1`. When Open WebUI runs in a container, `127.0.0.1` is the container itself:
use an address the container can reach, and Kitzur's `listen.host` must accept connections on it.
Read [network](../SECURITY.md#network) and the [shared server setup](SETUPS.md#shared-team-server-several-people-or-models)
before binding beyond loopback, and set `listen.token` when you do.

## If it does not work
Run `kitzur doctor`, then look up its codes in [troubleshooting](TROUBLESHOOTING.md).

| Symptom | Codes | Where |
|---|---|---|
| Connection refused | `config.valid`, `instance.responsive` | [port taken](TROUBLESHOOTING.md#the-proxy-does-not-start-or-the-port-is-taken) |
| 401 from Kitzur or the upstream | `listen.token`, `upstream.reachable` | [401/403](TROUBLESHOOTING.md#401403-from-the-upstream-or-from-v1models) |
| No `x-kitzur-*` headers | `client.base_url` | [client overflows](TROUBLESHOOTING.md#the-client-overflows-anyway-client-limit-versus-served-window) |
| Never compacts | `budget.compatible`, `upstream.skipped` | [pass through](TROUBLESHOOTING.md#requests-pass-through-uncompacted) |
| Overflows anyway | `budget.client_limits` | [client overflows](TROUBLESHOOTING.md#the-client-overflows-anyway-client-limit-versus-served-window) |
| Stream stops early | `upstream.reachable` | [stream ends early](TROUBLESHOOTING.md#a-stream-ends-early-or-with-an-error-event) |

A 415 means the client did not send `Content-Type: application/json`.
No `x-kitzur-*` headers on a chat response means the client is not using the Kitzur base URL; `client.base_url` checks a client config passed with `kitzur doctor --client-config`.
