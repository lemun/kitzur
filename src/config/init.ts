// `kitzur config init`: a commented starting config (JSON with comments, read by load.ts).
import { PRESET_TABLE } from './presets.js';
import { DEFAULT_CONFIG } from './schema.js';

/** The starting config text for a preset (default 100k). Throws on an unknown preset name. */
export function renderInitConfig(preset = '100k'): string {
  const p = PRESET_TABLE[preset];
  if (!p) throw new Error(`unknown preset '${preset}' (available: ${Object.keys(PRESET_TABLE).join(', ')})`);
  const port = DEFAULT_CONFIG.listen.port;
  return `// kitzur configuration: JSON with // and /* */ comments. Every knob is documented in CONFIG.md.
// Precedence: built-in defaults < preset < this file < KITZUR_* environment < --set a.b=v.
//   check it:        kitzur config validate --config <this file>
//   see the result:  kitzur config show --config <this file>   (the source of every value)
{
  // Window preset (presets/${preset}.json): budget.window ${p.window}, budget.defaultMaxTokens ${p.defaultMaxTokens}.
  // One of ${Object.keys(PRESET_TABLE).join(', ')}. Values in this file override it.
  "preset": "${preset}",

  "upstream": {
    // REQUIRED: scheme://host[:port] of the OpenAI-compatible gateway, with no path. The client's request
    // path is appended unchanged, so point the client's baseURL at http://127.0.0.1:${port}/<gateway path>
    // (for example http://127.0.0.1:${port}/v1).
    "origin": null
    // An internal CA:          , "caFile": "/etc/ssl/certs/internal-ca.pem"
    // A request size limit:    , "maxBodyBytes": 1048576
  },

  "server": {
    // vllm | sglang | llamacpp | tgi | ollama | lmstudio | litellm | unknown (the default). Selects the
    // budget mode (does the server count max_tokens against the window?). Left unset here so that
    // config import-eval can fill it in from the measured error bodies.
    // "type": "vllm"
  },

  "tokenizer": {
    // The served model's HF tokenizer.json, for exact counting (a relative path is relative to this
    // file). null = the per-content-class estimate (CONFIG.md "Counting").
    "path": null,
    // qwen3 | chatml | generic (sim only against the benchmark mock)
    "template": { "name": "qwen3" }
  },

  "listen": { "host": "127.0.0.1", "port": ${port} }

  // After the gateway-probes has run:  kitzur config import-eval <results dir> --merge <this file>
}
`;
}
