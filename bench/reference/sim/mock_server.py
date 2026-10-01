"""Mock OpenAI-compatible Chat Completions server with a hard context limit.

- Counts prompt tokens with the Qwen tokenizer over an approximate chat template.
- Rejects prompt_tokens + max_tokens > LIMIT with a configurable error style.
- Rejects broken tool-call/tool-result pairing (as OpenAI/vLLM do).
- Returns the scripted assistant turn for the step in the X-Sim-Step header.
- Logs every request (JSONL) and saves every received body for diffing.

usage: mock_server.py PORT OUTDIR [--limit 100000] [--error-style vllm|llamacpp|gateway502|tgi422]
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenario  # noqa: E402

SUMMARY_HEADER = "The following is a summary of your previous actions (long observations omitted):"

ap = argparse.ArgumentParser()
ap.add_argument("port", type=int)
ap.add_argument("outdir")
ap.add_argument("--limit", type=int, default=100_000)
ap.add_argument("--error-style", default="vllm")
ARGS = ap.parse_args()
os.makedirs(os.path.join(ARGS.outdir, "reqs"), exist_ok=True)
LOG = open(os.path.join(ARGS.outdir, "mock.jsonl"), "a")
LOCK = threading.Lock()
SEQ = [0]


def check_pairing(msgs):
    pending = set()
    for i, m in enumerate(msgs):
        role = m.get("role")
        if role == "tool":
            tid = m.get("tool_call_id")
            if tid not in pending:
                return f"message {i}: tool result {tid} has no preceding tool call"
            pending.discard(tid)
        else:
            if pending:
                return f"message {i}: tool calls {sorted(pending)} were never answered"
            if role == "assistant":
                pending = {c.get("id") for c in m.get("tool_calls") or []}
    if pending:
        return f"end: tool calls {sorted(pending)} were never answered"
    return None


def context_error(prompt, max_tokens):
    total = prompt + max_tokens
    style = ARGS.error_style
    if style == "vllm":
        return 400, {"object": "error", "type": "BadRequestError", "param": None, "code": 400,
                     "message": f"This model's maximum context length is {ARGS.limit} tokens. However, you "
                                f"requested {total} tokens ({prompt} in the messages, {max_tokens} in the "
                                f"completion). Please reduce the length of the messages or completion."}
    if style == "llamacpp":
        return 400, {"error": {"code": 400, "type": "exceed_context_size_error",
                               "message": "the request exceeds the available context size, try increasing it",
                               "n_prompt_tokens": prompt, "n_ctx": ARGS.limit}}
    if style == "gateway502":
        return 502, {"error": {"type": "upstream_error", "message": "Upstream model server returned an error"}}
    if style == "tgi422":
        return 422, {"error_type": "validation",
                     "error": f"Input validation error: `inputs` tokens + `max_new_tokens` must be <= "
                              f"{ARGS.limit}. Given: {prompt} `inputs` tokens and {max_tokens} `max_new_tokens`"}
    raise ValueError(style)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        body = json.loads(raw)
        msgs = body.get("messages", [])
        step = int(self.headers.get("x-sim-step", "-1"))
        with LOCK:
            SEQ[0] += 1
            seq = SEQ[0]
        prompt = scenario.count_tokens(body)
        max_tokens = int(body.get("max_tokens") or body.get("max_completion_tokens") or 0)
        blob = json.dumps(msgs, ensure_ascii=False)
        rec = {"seq": seq, "step": step, "ts": time.time(), "prompt_tokens": prompt,
               "max_tokens": max_tokens, "n_messages": len(msgs),
               "has_summary": any(scenario.content_text(m.get("content")).startswith(SUMMARY_HEADER) for m in msgs),
               "facts": {k: (k in blob) for k in scenario.FACTS},
               "body_chars": len(raw)}
        with open(os.path.join(ARGS.outdir, "reqs", f"{seq:04d}_step{step}.json"), "w") as f:
            json.dump(body, f, ensure_ascii=False)
        pairing = check_pairing(msgs)
        rec["pairing_error"] = pairing
        if pairing:
            rec["status"] = 400
            self._log(rec)
            return self.send_json(400, {"error": {"type": "invalid_request_error",
                                                  "message": f"Invalid messages: {pairing}"}})
        if prompt + max_tokens > ARGS.limit:
            status, err = context_error(prompt, max_tokens)
            rec["status"] = status
            rec["rejected_for_length"] = True
            self._log(rec)
            return self.send_json(status, err)
        msg = scenario.assistant_message(step)
        completion = scenario.count_text((msg["content"] or "") + json.dumps(msg["tool_calls"]))
        usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
        rec["status"] = 200
        rec["completion_tokens"] = completion
        self._log(rec)
        if body.get("stream"):
            include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            base = {"id": f"chatcmpl-{seq}", "object": "chat.completion.chunk", "model": body.get("model")}
            delta = {"role": "assistant", "content": msg["content"] or "",
                     "tool_calls": [dict(c, index=i) for i, c in enumerate(msg["tool_calls"])]}
            chunks = [dict(base, choices=[{"index": 0, "delta": delta, "finish_reason": None}]),
                      dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls"}])]
            if include_usage:
                chunks.append(dict(base, choices=[], usage=usage))
            for c in chunks:
                self._chunk(f"data: {json.dumps(c)}\n\n".encode())
            self._chunk(b"data: [DONE]\n\n")
            self._chunk(b"")
        else:
            self.send_json(200, {"id": f"chatcmpl-{seq}", "object": "chat.completion", "model": body.get("model"),
                                 "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls"}],
                                 "usage": usage})

    def _chunk(self, data):
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def _log(self, rec):
        with LOCK:
            LOG.write(json.dumps(rec) + "\n")
            LOG.flush()


scenario.tokenizer()
print(f"mock listening on {ARGS.port} limit={ARGS.limit} style={ARGS.error_style}", flush=True)
ThreadingHTTPServer(("127.0.0.1", ARGS.port), H).serve_forever()
