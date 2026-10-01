"""Golden fixtures for the template profiles and the TokenCounter (test/tokenize/*). Dev only.

    <venv>/bin/python scripts/tokenizer/gen_template_goldens.py \
        --sim <dir with reference-harness sim/scenario.py> --tokenizer <Qwen3.6-27B tokenizer.json> \
        [--render-golden <reference implementation>] [--out test/fixtures]

The venv needs `tokenizers` (0.23.2) and `jinja2`. Writes (all deterministic):
  sim-history.json.gz     the reference session from scenario.py, uncapped: system prompt, tools, goal,
                          46 steps (assistant content/tool call + raw tool output), the user inject, CHATTY.
                          The tests rebuild SIM_CAP_BYTES / SIM_CHATTY variants from it.
  sim-counts.json         scenario.count_tokens(body) (the mock's prompt_tokens, sim render()) for requests
                          of that session (uncapped, SIM_CAP_BYTES=51200, SIM_CHATTY=1+51200) and edge bodies.
  sim-render-golden.json  render sha256/len per step copied from reference implementation (+ its edge renders).
  qwen3-goldens.json.gz   the real Qwen3.6-27B chat template (scripts/tokenizer/qwen3.6-chat-template.jinja,
                          identical to tokenizer_config.json) rendered with jinja2 the way HF transformers
                          does (ImmutableSandboxedEnvironment, trim_blocks, lstrip_blocks, loopcontrols,
                          tojson = json.dumps(ensure_ascii=False)), after the vLLM-style message preparation
                          that kitzur's qwen3 profile mirrors (vllm_prepare below): rendered text (or its
                          sha256 for session-size requests), token count, or the template's error.
"""
import argparse
import copy
import gzip
import hashlib
import json
import os
import sys

import jinja2
from jinja2.ext import loopcontrols
from jinja2.sandbox import ImmutableSandboxedEnvironment
from tokenizers import Tokenizer

HERE = os.path.dirname(os.path.abspath(__file__))

ap = argparse.ArgumentParser()
ap.add_argument("--sim", required=True)
ap.add_argument("--tokenizer", required=True)
ap.add_argument("--render-golden", default=None)
ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "test", "fixtures"))
args = ap.parse_args()

sys.path.insert(0, args.sim)
import scenario  # noqa: E402

TOK = Tokenizer.from_file(args.tokenizer)
scenario._tok = TOK  # count_tokens() uses the same tokenizer file


def ntok(text):
    return len(TOK.encode(text, add_special_tokens=False).ids)


def sha(text):
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def set_env(cap=None, chatty=False):
    for k in ("SIM_CAP_BYTES", "SIM_CHATTY", "SIM_HUGE_AT"):
        os.environ.pop(k, None)
    if cap:
        os.environ["SIM_CAP_BYTES"] = str(cap)
    if chatty:
        os.environ["SIM_CHATTY"] = "1"


def history(steps):
    """agent_client.py's history after `steps` steps (message key order as the client builds it)."""
    h = [{"role": "system", "content": scenario.system_prompt()}, {"role": "user", "content": scenario.GOAL_TEXT}]
    for step in range(steps):
        a = scenario.assistant_message(step)
        h.append(a)
        for call in a["tool_calls"]:
            h.append({"role": "tool", "tool_call_id": call["id"], "content": scenario.tool_output(step)})
        if step in scenario.USER_INJECT:
            h.append({"role": "user", "content": scenario.USER_INJECT[step]})
    return h


def body(steps):
    return {"model": "local-model", "messages": history(steps), "tools": scenario.tools(), "max_tokens": 32000,
            "stream": True, "stream_options": {"include_usage": True}}


os.makedirs(args.out, exist_ok=True)
STEPS = 46

# ---------------------------------------------------------------- sim-history.json.gz
set_env()
hist = {"system": scenario.system_prompt(), "goal": scenario.GOAL_TEXT, "tools": scenario.tools(),
        "inject": {str(k): v for k, v in scenario.USER_INJECT.items()}, "chatty": scenario.CHATTY, "steps": []}
for step in range(STEPS):
    a = scenario.assistant_message(step)
    hist["steps"].append({"content": a["content"], "id": a["tool_calls"][0]["id"],
                          "name": a["tool_calls"][0]["function"]["name"],
                          "arguments": a["tool_calls"][0]["function"]["arguments"],
                          "output": scenario.tool_output(step)})
with gzip.GzipFile(os.path.join(args.out, "sim-history.json.gz"), "wb", mtime=0, compresslevel=9) as f:
    f.write(json.dumps(hist, ensure_ascii=False, separators=(",", ":")).encode())

# ---------------------------------------------------------------- sim-counts.json
counts = {"note": "scenario.count_tokens(body): len(Qwen3.6 encode(render(body), add_special_tokens=False))",
          "variants": {}, "edge": []}
for name, cap, chatty, steps in (("uncapped", None, False, (0, 1, 2, 5, 10, 20, 30, 46)),
                                  ("cap51200", 51200, False, tuple(range(0, STEPS + 1))),
                                  ("chatty_cap51200", 51200, True, (3, 15, 46))):
    set_env(cap, chatty)
    rows = []
    for s in steps:
        b = body(s)
        r = scenario.render(b)
        rows.append({"steps": s, "messages": len(b["messages"]), "render_sha256": sha(r), "tokens": scenario.count_tokens(b)})
    counts["variants"][name] = {"cap": cap, "chatty": chatty, "rows": rows}
    print(name, [(r["steps"], r["tokens"]) for r in rows][-3:], file=sys.stderr)
set_env()
if args.render_golden:
    rg = json.load(open(args.render_golden))
    for e in rg["edge"]:
        counts["edge"].append({"body": e["body"], "render": e["render"], "tokens": ntok(scenario.render(e["body"]))})
        assert scenario.render(e["body"]) == e["render"]
with open(os.path.join(args.out, "sim-counts.json"), "w") as f:
    json.dump(counts, f, ensure_ascii=False, indent=0)

# ---------------------------------------------------------------- sim-render-golden.json
if args.render_golden:
    rg = json.load(open(args.render_golden))
    out = {"source": "reference implementation (Python reference)", "variants": {}}
    for name, v in rg["variants"].items():
        out["variants"][name] = {"env": v["env"], "steps": [[s["step"], s["render_sha256"], s["render_pylen"]] for s in v["steps"]]}
    with open(os.path.join(args.out, "sim-render-golden.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))

# ---------------------------------------------------------------- qwen3 goldens
TEMPLATE = open(os.path.join(HERE, "qwen3.6-chat-template.jinja")).read()


def raise_exception(msg):
    raise jinja2.exceptions.TemplateError(msg)


def tojson(x, ensure_ascii=False, indent=None, separators=None, sort_keys=False):
    return json.dumps(x, ensure_ascii=ensure_ascii, indent=indent, separators=separators, sort_keys=sort_keys)


env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=[loopcontrols])
env.filters["tojson"] = tojson
env.globals["raise_exception"] = raise_exception
TPL = env.from_string(TEMPLATE)

TEXT_KEYS = {"text": "text", "input_text": "text", "output_text": "text", "thinking": "thinking", "refusal": "refusal"}
IMAGE_TYPES = {"image_url", "input_image", "image_embeds", "image_pil", "image"}
VIDEO_TYPES = {"video_url", "video_embeds", "video"}


def vllm_part(p):
    if isinstance(p, str):
        return {"type": "text", "text": p}
    t = p.get("type")
    if t in TEXT_KEYS:
        v = p.get(TEXT_KEYS[t])
        return None if v is None else {"type": "text", "text": v}
    if t in IMAGE_TYPES:
        return {"type": "image"}
    if t in VIDEO_TYPES:
        return {"type": "video"}
    return dict(p)  # the template decides (audio etc. -> 'Unexpected item type in content.')


def vllm_tool(t):
    f = t["function"]
    fn = {"name": f.get("name"), "description": f.get("description"), "parameters": f.get("parameters")}
    if f.get("strict") is not None:
        fn["strict"] = f["strict"]
    defer = f.get("defer_loading") if f.get("defer_loading") is not None else t.get("defer_loading")
    if defer is not None:
        fn["defer_loading"] = defer
    out = {"type": "function", "function": fn}
    if t.get("defer_loading") is not None:
        out["defer_loading"] = t["defer_loading"]
    return out


def vllm_prepare(req):
    """What vLLM hands the template (entrypoints/chat_utils.py; see src/tokenize/template.ts qwen3Profile)."""
    msgs = []
    for m in copy.deepcopy(req.get("messages") or []):
        rc = m.pop("reasoning_content", None)  # protocol.py: reasoning_content renamed to reasoning
        if rc is not None and m.get("reasoning") is None:
            m["reasoning"] = rc
        role = m["role"]
        c = m.get("content")
        parts = [] if c is None else ([{"type": "text", "text": c}] if isinstance(c, str) else
                                      [q for q in (vllm_part(p) for p in c) if q is not None])
        out = {"role": "system" if role == "developer" else role}
        if role == "tool" and not any(p.get("type") != "text" for p in parts):
            out["content"] = "\n".join(p.get("text", "") for p in parts)
        else:
            out["content"] = parts
        if role == "assistant":
            if m.get("tool_calls") is not None:
                out["tool_calls"] = m["tool_calls"]
            if m.get("reasoning") is not None:
                out["reasoning"] = out["reasoning_content"] = m["reasoning"]
        msgs.append(out)
    for m in msgs:  # _postprocess_messages
        if m["role"] == "assistant" and "tool_calls" in m:
            if not m["tool_calls"]:
                del m["tool_calls"]
                continue
            for tc in m["tool_calls"]:
                fn = tc["function"]
                a = fn.get("arguments")
                if a:
                    if isinstance(a, dict):
                        parsed = a
                    elif isinstance(a, str):
                        try:
                            parsed = json.loads(a)
                        except json.JSONDecodeError:
                            parsed = None
                    else:
                        parsed = a
                    fn["arguments"] = parsed if isinstance(parsed, dict) else {}
                else:
                    fn["arguments"] = {}
    # renderers/hf.py safe_apply_chat_template: the template has no 'developer' role, so with a developer
    # message present: developer -> system, then _consolidate_system_messages merges every system message
    # into one leading one when any is not first (text parts joined with "\n", non-empty texts with "\n\n")
    if any(m["role"] == "developer" for m in (req.get("messages") or [])):
        sys_texts, rest, need = [], [], False
        for i, m in enumerate(msgs):
            if m["role"] == "system":
                if i > 0 or sys_texts:
                    need = True
                c = m.get("content", "")
                if isinstance(c, list):
                    c = "\n".join(p["text"] for p in c if isinstance(p, dict) and "text" in p)
                if c:
                    sys_texts.append(c)
            else:
                rest.append(m)
        if need:
            msgs = [{"role": "system", "content": "\n\n".join(sys_texts)}] + rest
    tools = [vllm_tool(t) for t in req["tools"]] if req.get("tools") else None
    return msgs, tools


def real_render(req, profile_kw):
    msgs, tools = vllm_prepare(req)
    kw = dict(profile_kw)
    kw.update(req.get("chat_template_kwargs") or {})
    return TPL.render(messages=msgs, tools=tools, add_generation_prompt=True, **kw)


def tc(i, name, arguments):
    return {"id": f"call_{i}", "type": "function", "function": {"name": name, "arguments": arguments}}


def A(content=None, calls=None, **kw):
    m = {"role": "assistant", "content": content}
    if calls is not None:
        m["tool_calls"] = calls
    m.update(kw)
    return m


def T(i, content):
    return {"role": "tool", "tool_call_id": f"call_{i}", "content": content}


def U(content):
    return {"role": "user", "content": content}


SYS = {"role": "system", "content": "You are a coding agent. Keep answers short."}
TOOLS = [
    {"type": "function", "function": {"name": "read", "description": "Read a file.", "parameters": {
        "type": "object", "properties": {"filePath": {"type": "string", "description": "absolute path"},
                                         "offset": {"type": "number"}, "limit": {"type": "number", "default": 2000}},
        "required": ["filePath"]}}},
    {"type": "function", "function": {"name": "bash", "description": "Run a shell command – bounded ⏱ 2 min.", "parameters": {
        "type": "object", "properties": {"command": {"type": "string"}, "timeout": {"type": "number", "minimum": 0.5}},
        "required": ["command"]}}},
]
TOOLS_ODD = [
    {"type": "function", "function": {"name": "no_desc", "parameters": {"type": "object", "properties": {}}}, "defer_loading": True},
    {"type": "function", "function": {"name": "strict_tool", "description": "d", "strict": True,
                                      "parameters": {"type": "object", "properties": {"x": {"type": "integer"}}}, "extra": 1}},
]
HEB = "שלום עולם, נא לא לגעת בתיקייה tests/legacy/ ‏(צוות ב׳)‎ ₪12.90"
NUM_ARGS = '{"n": 5, "f": 1.5, "i": 1.0, "neg0": -0.0, "e": 1e-7, "big": 12345678901234567890, "t": true, "z": null, "o": {"a": [1, "x", 2.50]}, "s": "plain"}'
EDIT_ARGS = json.dumps({"filePath": "/repo/src/pages/CartPage.ts", "oldString": "page.locator('.cart-btn')\n  .click();",
                        "newString": "page.getByTestId(\"cart-continue\")\n  .click();\t// ✓"})

cases = []


def case(name, messages, tools=None, profile=None, **extra):
    req = {"model": "qwen", "messages": messages}
    if tools is not None:
        req["tools"] = tools
    req.update(extra)
    cases.append({"name": name, "request": req, "profile": profile or {}})


case("minimal system+user", [{"role": "system", "content": "S"}, U("U")])
case("user only", [U("hi")])
case("tools, no system", [U("list files")], TOOLS)
case("tools + system + user", [SYS, U("read the config")], TOOLS)
case("tools + blank system", [{"role": "system", "content": "  \n "}, U("x")], TOOLS)
case("read call + result (in loop)", [SYS, U("read a.ts"), A("Reading it.", [tc(1, "read", '{"filePath": "/repo/a.ts"}')]),
                                      T(1, "export const a = 1;\n")], TOOLS)
case("bare call, content null", [SYS, U("go"), A(None, [tc(1, "bash", '{"command": "ls -la"}')]), T(1, "a\nb\n")], TOOLS)
case("non-string args", [SYS, U("go"), A("", [tc(1, "bash", NUM_ARGS)]), T(1, "ok")], TOOLS)
case("parallel calls + grouped results", [SYS, U("two files"),
                                          A("Both.", [tc(1, "read", '{"filePath": "/a"}'), tc(2, "read", '{"filePath": "/b", "limit": 20}')]),
                                          T(1, "A"), T(2, "B")], TOOLS)
case("three results then user then more", [SYS, U("start"),
                                           A(None, [tc(1, "read", '{"filePath": "/a"}'), tc(2, "read", '{"filePath": "/b"}'), tc(3, "bash", '{"command": "pwd"}')]),
                                           T(1, "A"), T(2, "B"), T(3, "/repo"), U("now fix it"),
                                           A("Fixing.", [tc(4, "bash", EDIT_ARGS)]), T(4, "Edit applied successfully.")], TOOLS)
case("reasoning before and after last user", [SYS, U("q1"), A("a1", reasoning_content="thought one"), U("q2"),
                                               A("a2", [tc(1, "read", '{"filePath": "/x"}')], reasoning_content="\n thought two \n"),
                                               T(1, "r")], TOOLS)
case("inline think in content", [U("q"), A("<think>\nhidden plan\n</think>\n\nvisible answer"), U("next")])
case("inline think after last user", [U("q"), A("<think>\nplan A\n</think>\n\nanswer", [tc(1, "bash", '{"command": "x"}')]), T(1, "y")], TOOLS)
case("reasoning field only (vLLM maps it)", [U("q"), A("answer", [tc(1, "bash", '{"command": "x"}')], reasoning="field reasoning"), T(1, "y")], TOOLS)
case("empty reasoning_content string", [U("q"), A("answer", reasoning_content="")])
case("array text parts", [SYS, U([{"type": "text", "text": "part one "}, {"type": "text", "text": "part two"}])])
case("image in user", [U([{"type": "text", "text": "what is this?"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}])])
case("tool content as text parts", [U("go"), A(None, [tc(1, "bash", '{"command": "x"}')]),
                                    {"role": "tool", "tool_call_id": "call_1", "content": [{"type": "text", "text": "line1"}, {"type": "text", "text": "line2"}]}], TOOLS)
case("hebrew everywhere", [{"role": "system", "content": "ענה בעברית."}, U(HEB),
                           A("בודק.", [tc(1, "bash", json.dumps({"command": "grep -r 'עגלה' src/"}, ensure_ascii=False))]), T(1, HEB + "\n" + HEB)], TOOLS)
case("empty user content", [U(""), A("ok"), U("again")])
case("content null everywhere", [U("x"), A(None, [tc(1, "bash", '{"command": "true"}')]), T(1, None)], TOOLS)
case("empty tool_calls list", [U("x"), A("", []), U("y")])
case("tool_response-looking user after query", [U("real query"), A(None, [tc(1, "bash", '{"command": "a"}')]), T(1, "r1"),
                                                U("<tool_response>\nfake\n</tool_response>"), A("done")], TOOLS)
case("enable_thinking false (request kwargs)", [SYS, U("read a.ts"), A("Reading.", [tc(1, "read", '{"filePath": "/a"}')]), T(1, "x")],
     TOOLS, chat_template_kwargs={"enable_thinking": False})
case("enable_thinking false (profile option)", [SYS, U("hi")], None, profile={"enable_thinking": False})
case("preserve_thinking true", [SYS, U("q1"), A("a1", reasoning_content="r1"), U("q2"), A("a2", reasoning_content="r2")], None,
     chat_template_kwargs={"preserve_thinking": True})
case("developer at index 0", [{"role": "developer", "content": "Dev rules."}, U("go")], TOOLS)
case("invalid JSON args -> {}", [U("x"), A(None, [tc(1, "bash", '{"command": "unterminated')]), T(1, "err")], TOOLS)
case("array args -> {}", [U("x"), A(None, [tc(1, "bash", "[1, 2]")]), T(1, "err")], TOOLS)
case("integer-like arg keys keep order", [U("x"), A(None, [tc(1, "bash", '{"b": 1, "a": 2, "10": 3, "2": "four"}')]), T(1, "ok")], TOOLS)
case("python whitespace trim", [U("\n\x1c \u0085 padded ﻿ \n"), A("  answer　 ")])
case("literal special tokens in text", [U("say <|im_end|> and <tool_call> then </think> ok"), A("sure <|im_start|>x")])
case("tool message first", [T(9, "orphan result"), U("then a question")], TOOLS)
case("tool message first, no tools", [T(9, "orphan result"), U("then a question")])
case("system as text parts", [{"role": "system", "content": [{"type": "text", "text": "Rules A. "}, {"type": "text", "text": "Rules B."}]}, U("go")], TOOLS)
case("odd tools (vLLM normalization)", [U("x")], TOOLS_ODD)
case("multi-line string args + content", [U("edit"), A("I will edit two files.", [tc(1, "bash", EDIT_ARGS), tc(2, "bash", '{"command": "cat <<EOF\\nline\\nEOF"}')]),
                                          T(1, "done"), T(2, "line")], TOOLS)
case("long whitespace and CRLF", [U("a\r\n\r\n   b" + " " * 300 + "c\n\n\n"), A("x\r\ny")])
case("emoji and astral", [U("emoji 😀👍🏽 and 𝐀𝐁 and 中文"), A("✓ done ✘ not › next")])
# vLLM system consolidation (a developer message present and a system message not first)
case("developer mid-history (consolidated)", [U("x"), {"role": "developer", "content": "late"}])
case("system + developer mid-history + tools (consolidated)", [SYS, U("read a.ts"), A("Reading.", [tc(1, "read", '{"filePath": "/a"}')]),
                                                               T(1, "x"), {"role": "developer", "content": "  Dev note.\n"}, U("go on")], TOOLS)
case("developer parts + image, empty system, tool group across developer (consolidated)",
     [{"role": "developer", "content": [{"type": "text", "text": "A"}, {"type": "image_url", "image_url": {"url": "x"}}, {"type": "text", "text": "B"}]},
      {"role": "system", "content": ""}, U("q"), A(None, [tc(1, "bash", '{"command": "a"}'), tc(2, "bash", '{"command": "b"}')]),
      T(1, "r1"), {"role": "developer", "content": "mid"}, T(2, "r2")], TOOLS)
# errors the template raises
case("error: system not first", [U("x"), {"role": "system", "content": "late"}])
case("error: no user query", [SYS, A("hello")])
case("error: only tool responses as user", [U("<tool_response>\nx\n</tool_response>"), A("y")])
case("error: no user query after consolidation", [{"role": "developer", "content": "d"}, SYS, A("hello")])
case("error: image in system", [{"role": "system", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}, U("x")])
case("error: unexpected role", [U("x"), {"role": "function", "name": "f", "content": "r"}])

goldens = {"template_sha256": hashlib.sha256(TEMPLATE.encode()).hexdigest(), "jinja2": jinja2.__version__, "cases": [], "session": []}
for cs in cases:
    row = {"name": cs["name"], "request": cs["request"], "profile": cs["profile"]}
    try:
        r = real_render(cs["request"], cs["profile"])
        row["render"] = r
        row["tokens"] = ntok(r)
        row["images"] = r.count("<|image_pad|>") + r.count("<|video_pad|>")
    except jinja2.exceptions.TemplateError as e:
        row["error"] = str(e)
    goldens["cases"].append(row)
    print(cs["name"], row.get("tokens", row.get("error")), file=sys.stderr)

# reference-session requests (SIM_CAP_BYTES=51200): sha + tokens only (the render is ~1 MB)
set_env(51200)
for steps, kw in ((0, {}), (1, {}), (5, {}), (10, {}), (11, {}), (30, {}), (46, {}), (46, {"enable_thinking": False}), (12, {"preserve_thinking": True})):
    b = body(steps)
    r = real_render(b, kw)
    goldens["session"].append({"variant": "cap51200", "steps": steps, "profile": kw, "render_sha256": sha(r),
                               "render_len": len(r), "tokens": ntok(r), "sim_tokens": scenario.count_tokens(b)})
    print("session", steps, kw, goldens["session"][-1]["tokens"], goldens["session"][-1]["sim_tokens"], file=sys.stderr)
set_env()
with gzip.GzipFile(os.path.join(args.out, "qwen3-goldens.json.gz"), "wb", mtime=0, compresslevel=9) as f:
    f.write(json.dumps(goldens, ensure_ascii=False, separators=(",", ":")).encode())
print("ok", file=sys.stderr)
