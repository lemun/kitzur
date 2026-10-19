# Upstream key rotation

For several authorized keys/accounts on one OpenAI-compatible gateway, chain a dedicated router:

`client → Kitzur → rotator → gateway`

Kitzur compacts context; it does not select keys, hold a key pool or manage cooldowns.
Keeping rotation in a dedicated router avoids adding credential custody and quota scheduling to core.
**Policy:** use only keys your organization authorizes you to pool. Rotation does not raise a shared
department limit and must not be used to evade per-user limits or terms of service.

## LiteLLM example

[LiteLLM Router](https://docs.litellm.ai/docs/routing) supports several deployments under one
`model_name`. This illustrative proxy config uses two keys for the same gateway model; replace
`gateway.example` and `gateway-model` with your gateway's OpenAI-compatible endpoint and model.
Keep secrets in the rotator's environment, not this file or Kitzur's config:

```yaml
model_list:
  - model_name: gateway-model
    litellm_params:
      model: openai/gateway-model
      api_base: https://gateway.example/v1
      api_key: os.environ.GATEWAY_KEY_A
  - model_name: gateway-model
    litellm_params:
      model: openai/gateway-model
      api_base: https://gateway.example/v1
      api_key: os.environ.GATEWAY_KEY_B
router_settings:
  routing_strategy: simple-shuffle
  num_retries: 1
  allowed_fails: 1
  cooldown_time: 60
```

Run the LiteLLM proxy with this config on loopback port 4000 (`litellm --config router.yaml --port 4000`).
These are bounded retry/cooldown example values, not a guarantee of failover for every gateway error;
verify your LiteLLM version's error mapping and cooldown behavior against a mock gateway first.
In your existing Kitzur config, set `upstream.origin` to `http://127.0.0.1:4000` (no `/v1` path).
The client's base URL stays `http://127.0.0.1:8270/v1`, with model `gateway-model`.

## Composition rules

- This adds one hop and another service to operate. Keep Kitzur retries as is; let the rotator own key
  failover. Bound its attempts and waits so retries do not stack into excessive gateway traffic.
- Preserve 400 context-overflow bodies unchanged so Kitzur can recognize them and compact/retry.
  Kitzur relays 429 responses without treating them as context overflow; the rotator handles key failover.
- Set `upstream.timeoutMs` above the rotator's total per-request rotation time, including waits and
  gateway prefill. Account for streaming silence separately with `upstream.idleTimeoutMs`.
- Without `listen.token`, client Authorization passes through to the rotator. With `listen.token`,
  the client sends that local token and Kitzur strips it; configure the rotator's credential separately
  in `upstream.headers.Authorization` if required. Gateway keys belong only in the rotator.
- Perimeter/WAF 403s can affect every key behind the same egress IP at once. Do not interpret them as
  proof that each key is invalid; stop rotation and investigate the gateway/perimeter policy.
