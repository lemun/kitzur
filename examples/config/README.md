# Config examples

Ready-to-copy kitzur config files. Copy one to `~/.config/kitzur/kitzur.jsonc` (or pass it with
`--config FILE`), replace the `example.com` host and the `<placeholder>` paths, then run
`kitzur config validate`. Every key is described in [CONFIG.md](../../CONFIG.md).

| File | Setup |
|---|---|
| [single-model-32k.jsonc](single-model-32k.jsonc) | one local model with a 32k window |
| [multi-model-gateway.jsonc](multi-model-gateway.jsonc) | a large and a small model behind one gateway, each with its own window |
| [windows-intranet.jsonc](windows-intranet.jsonc) | a Windows intranet gateway with a company CA, loopback only |
