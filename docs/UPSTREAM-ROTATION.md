# Rotating gateway keys

Kitzur forwards one client key to one configured upstream. It does not rotate or
pool upstream keys. If you have several authorized keys or accounts for one
gateway, put a dedicated rotator between Kitzur and that gateway:

```text
client -> Kitzur -> rotator -> gateway
```

For example, LiteLLM can route a model across deployments and manage cooldowns
for deployments that fail. Configure each deployment with a key you are
authorized to use, then point Kitzur's `upstream.origin` at the LiteLLM router
and send the router's client key from your agent (or configure it in
`upstream.headers`). Kitzur's origin is the rotator's `scheme://host[:port]`;
the request path is appended as usual. See LiteLLM's current router
documentation for its configuration syntax and cooldown behavior.

This adds a network hop and another service to operate. Keep Kitzur's own
retry behavior as configured; let the rotator own key failover. Stacking
independent retries can multiply attempts and delay errors. A mandatory policy:
pool only keys you are authorized to pool. Rotation does not increase a
department's shared quota or bypass its limits. A perimeter 403, such as an
account or IP policy denial, can affect every key at once and is not fixed by
rotation.
