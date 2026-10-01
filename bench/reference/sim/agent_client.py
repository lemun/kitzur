"""Simulated agent: resends its whole history each step, like OpenCode/Kilo.

usage: agent_client.py BASE_URL OUTDIR [--steps N] [--no-stream] [--no-usage]
"""
import argparse
import http.client
import json
import os
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenario  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("outdir")
ap.add_argument("--steps", type=int, default=46)
ap.add_argument("--max-tokens", type=int, default=32_000)
ap.add_argument("--no-stream", action="store_true")
ap.add_argument("--no-usage", action="store_true", help="do not ask for usage in the stream")
ap.add_argument("--save-origs", action="store_true")
A = ap.parse_args()
os.makedirs(os.path.join(A.outdir, "origs"), exist_ok=True)
log = open(os.path.join(A.outdir, "client.jsonl"), "w")
u = urlparse(A.base)


def post(body, step):
    data = json.dumps(body).encode()
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=600)
    conn.request("POST", u.path.rstrip("/") + "/v1/chat/completions", body=data, headers={
        "content-type": "application/json", "authorization": "Bearer sim-key", "x-sim-step": str(step)})
    r = conn.getresponse()
    raw = r.read()
    conn.close()
    return r.status, r.getheader("content-type") or "", raw


def parse(ctype, raw):
    if "event-stream" in ctype:
        msg = {"role": "assistant", "content": "", "tool_calls": []}
        for line in raw.decode().splitlines():
            if not line.startswith("data:") or line.strip() == "data: [DONE]":
                continue
            ev = json.loads(line[5:])
            for ch in ev.get("choices", []):
                d = ch.get("delta", {})
                msg["content"] += d.get("content") or ""
                for tc in d.get("tool_calls") or []:
                    tc = dict(tc)
                    tc.pop("index", None)
                    msg["tool_calls"].append(tc)
        msg["content"] = msg["content"] or None
        return msg
    return json.loads(raw)["choices"][0]["message"]


history = [{"role": "system", "content": scenario.system_prompt()},
           {"role": "user", "content": scenario.GOAL_TEXT}]
tools = scenario.tools()
for step in range(A.steps):
    body = {"model": "local-model", "messages": history, "tools": tools,
            "max_tokens": A.max_tokens, "stream": not A.no_stream}
    if not A.no_stream and not A.no_usage:
        body["stream_options"] = {"include_usage": True}
    rec = {"step": step, "orig_messages": len(history), "orig_est_tokens": scenario.est_tokens(body),
           "orig_qwen_tokens": scenario.count_tokens(body)}
    if A.save_origs:
        with open(os.path.join(A.outdir, "origs", f"step{step}.json"), "w") as f:
            json.dump(body, f, ensure_ascii=False)
    t = time.time()
    status, ctype, raw = post(body, step)
    rec.update(status=status, secs=round(time.time() - t, 2))
    if status != 200:
        rec["error_body"] = raw.decode(errors="replace")[:600]
        log.write(json.dumps(rec) + "\n")
        log.flush()
        print(f"step {step}: HTTP {status}: {rec['error_body'][:200]}", flush=True)
        break
    msg = parse(ctype, raw)
    history.append(msg)
    for call in msg.get("tool_calls") or []:
        history.append({"role": "tool", "tool_call_id": call["id"], "content": scenario.tool_output(step)})
    if step in scenario.USER_INJECT:
        history.append({"role": "user", "content": scenario.USER_INJECT[step]})
    log.write(json.dumps(rec) + "\n")
    log.flush()
print("done", flush=True)
