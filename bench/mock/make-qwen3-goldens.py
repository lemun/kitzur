"""Golden renders for the bench mock's qwen3 render (bench/mock/qwen3-render.ts).

    python make-qwen3-goldens.py CORPUS.json TOKENIZER.json OUT.json.gz

CORPUS.json comes from `node dist/bench/mock/qwen3-corpus.js`. Each body is json.loads'ed and preprocessed with
vLLM's own logic, transcribed from vLLM @8cc9aa5 (see the function docstrings), then rendered with jinja2 in the
environment transformers uses (ImmutableSandboxedEnvironment(trim_blocks, lstrip_blocks, loopcontrols), the
`tojson` override, `raise_exception`) over reference implementation, and tokenized with HF `tokenizers`
(add_special_tokens=False). Output per case: body sha256, render sha256/length (and the text when < 20,000 chars),
token count, or the error (type template | validation | other, message).
"""
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

TEMPLATE_PATH = os.environ.get(
    "QWEN_TEMPLATE",
    os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "tokenizer", "qwen3.6-chat-template.jinja"),
)


class VLLMValidationError(ValueError):
    pass


def raise_exception(msg):
    raise jinja2.exceptions.TemplateError(msg)


def tojson(x, ensure_ascii=False, indent=None, separators=None, sort_keys=False):
    # transformers.utils.chat_template_utils._compile_jinja_template tojson override
    return json.dumps(x, ensure_ascii=ensure_ascii, indent=indent, separators=separators, sort_keys=sort_keys)


# ---------------------------------------------------------------- vLLM (transcribed)

TEXT_TYPES = {"text": "text", "input_text": "text", "output_text": "text", "refusal": "refusal", "thinking": "thinking"}
MEDIA = {"image_url": "image", "input_image": "image", "image_embeds": "image", "image_pil": "image",
         "video_url": "video", "video_embeds": "video", "audio_url": "audio", "input_audio": "audio", "audio_embeds": "audio"}
DIRECT_KEYS = ["image_url", "image_pil", "image_embeds", "audio_embeds", "video_embeds", "prompt_embeds", "audio_url",
               "input_audio", "video_url", "tool_reference"]


def parse_part(part):
    """chat_utils._parse_chat_message_content_part(wrap_dicts=True) + _parse_chat_message_content_mm_part."""
    if isinstance(part, str):
        return {"type": "text", "text": part}
    if not isinstance(part, dict):
        raise VLLMValidationError("Invalid content part.")
    part_type = part.get("type", None)
    uuid = part.get("uuid", None)
    if part_type is None or uuid is not None:
        found = next((k for k in DIRECT_KEYS if k in part), None)
        if found is None:
            raise VLLMValidationError("Missing 'type' field in multimodal part.")
        part_type = found
    if not isinstance(part_type, str):
        raise VLLMValidationError("Invalid 'type' field in multimodal part.")
    if part_type in TEXT_TYPES:
        content = part.get(TEXT_TYPES[part_type], None)
        if part_type in ("text", "refusal") and content is None:
            return None  # PART_TYPES_TO_SKIP_NONE_CONTENT
        return {"type": "text", "text": content}
    if part_type in MEDIA:
        return {"type": MEDIA[part_type]}
    if part_type == "tool_reference":
        return {"type": "tool_reference", "name": part.get("name", None)}
    raise VLLMValidationError(f"Unsupported chat content part type: {part_type!r}.")


def parse_message(message):
    """chat_utils._parse_chat_message_content (content_format 'openai')."""
    role = message["role"] if "role" in message else None
    content = message.get("content")
    reasoning = message.get("reasoning")
    if content is None:
        content = []
    elif isinstance(content, str):
        content = [{"type": "text", "text": content}]
    elif not isinstance(content, list):
        raise VLLMValidationError("Invalid message content.")
    parts = [p for p in (parse_part(p) for p in content) if p]
    result_msg = {"role": role, "content": parts}
    if role == "assistant":
        if "tool_calls" in message and message["tool_calls"] is not None:
            if not isinstance(message["tool_calls"], list):
                raise VLLMValidationError("tool_calls must be a list.")
            result_msg["tool_calls"] = list(message["tool_calls"])
        if reasoning is not None:
            result_msg["reasoning"] = reasoning
            result_msg["reasoning_content"] = reasoning
    elif role == "tool":
        if "tool_call_id" in message:
            result_msg["tool_call_id"] = message["tool_call_id"]
        msg_content = result_msg.get("content")
        if isinstance(msg_content, list):
            has_non_text = any(isinstance(item, dict) and item.get("type") != "text" for item in msg_content)
            if not has_non_text:
                texts = [item.get("text", "") for item in msg_content if isinstance(item, dict) and item.get("type") == "text"]
                result_msg["content"] = "\n".join(texts) if texts else ""
    return result_msg


def postprocess_messages(messages):
    """chat_utils._postprocess_messages (verbatim logic)."""
    for message in messages:
        if message["role"] == "assistant" and "tool_calls" in message:
            tool_calls = message.get("tool_calls")
            if not isinstance(tool_calls, list):
                continue
            if len(tool_calls) == 0:
                message.pop("tool_calls", None)
                continue
            for item in tool_calls:
                if not isinstance(item, dict):
                    raise VLLMValidationError("assistant tool_calls entries must be objects.")
                function = item.get("function")
                if item.get("type", "function") != "function" or not isinstance(function, dict):
                    raise VLLMValidationError("chat completions only support assistant tool_calls of type 'function'.")
                if content := function.get("arguments"):
                    if isinstance(content, dict):
                        parsed = content
                    else:
                        if isinstance(content, str):
                            try:
                                parsed = json.loads(content)
                            except json.JSONDecodeError:
                                parsed = None
                        else:
                            parsed = content
                        if not isinstance(parsed, dict):
                            parsed = {}
                    function["arguments"] = parsed
                else:
                    function["arguments"] = {}


def convert_developer_to_system(conversation):
    """renderers/hf.py _convert_developer_to_system."""
    converted = []
    for msg in conversation:
        if msg["role"] == "developer":
            new_msg = dict(msg)
            new_msg["role"] = "system"
            new_msg.pop("tools", None)
            converted.append(new_msg)
        else:
            converted.append(msg)
    return converted


def consolidate_system_messages(conversation):
    """renderers/hf.py _consolidate_system_messages (verbatim logic)."""
    system_contents = []
    non_system = []
    needs_consolidation = False
    for i, msg in enumerate(conversation):
        if msg["role"] == "system":
            if i > 0 or system_contents:
                needs_consolidation = True
            content = msg.get("content", "")
            if isinstance(content, list):
                parts = []
                for part in content:
                    if isinstance(part, dict) and "text" in part:
                        parts.append(part["text"])
                    elif isinstance(part, str):
                        parts.append(part)
                content = "\n".join(parts)
            if content:
                system_contents.append(content)
        else:
            non_system.append(msg)
    if not needs_consolidation:
        return conversation
    return [{"role": "system", "content": "\n\n".join(system_contents)}, *non_system]


def normalize_tool(t):
    """ChatCompletionToolsParam / FunctionDefinition model_dump (generate/base/protocol.py, chat_completion/protocol.py)."""
    if not isinstance(t, dict) or not isinstance(t.get("function"), dict) or not isinstance(t["function"].get("name"), str) \
            or ("type" in t and t["type"] != "function"):
        raise VLLMValidationError("Invalid tool definition.")
    fn = t["function"]
    top = t.get("defer_loading")
    f = {"name": fn["name"], "description": fn.get("description"), "parameters": fn.get("parameters")}
    if fn.get("strict") is not None:
        f["strict"] = fn["strict"]
    d = fn.get("defer_loading") if fn.get("defer_loading") is not None else top
    if d is not None:
        f["defer_loading"] = d
    out = {"type": "function", "function": f}
    if top is not None:
        out["defer_loading"] = top
    return out


def vllm_request(body):
    if not isinstance(body, dict):
        raise VLLMValidationError("The request body must be a JSON object.")
    messages = copy.deepcopy(body.get("messages"))
    if not isinstance(messages, list):
        raise VLLMValidationError("messages must be a list.")
    for msg in messages:  # protocol.py _normalize_messages_before
        if not isinstance(msg, dict):
            raise VLLMValidationError("Each message must be an object.")
        reasoning_content = msg.pop("reasoning_content", None)
        if reasoning_content is not None and msg.get("reasoning") is None:
            msg["reasoning"] = reasoning_content
    conversation = [parse_message(m) for m in messages]
    postprocess_messages(conversation)
    if any(m["role"] == "developer" for m in conversation):
        conversation = consolidate_system_messages(convert_developer_to_system(conversation))
    tools = None
    if body.get("tools") is not None:
        if not isinstance(body["tools"], list):
            raise VLLMValidationError("tools must be a list.")
        tools = [normalize_tool(t) for t in body["tools"]]
    kwargs = {}
    kw = body.get("chat_template_kwargs")
    if isinstance(kw, dict):
        for k in ("enable_thinking", "preserve_thinking"):
            if k in kw:
                kwargs[k] = kw[k]
    agp = body.get("add_generation_prompt", True)
    return conversation, tools, kwargs, agp


def main():
    corpus_path, tok_path, out_path = sys.argv[1:4]
    template = open(TEMPLATE_PATH, encoding="utf-8").read()
    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=[loopcontrols])
    env.filters["tojson"] = tojson
    env.globals["raise_exception"] = raise_exception
    tpl = env.from_string(template)
    tok = Tokenizer.from_file(tok_path)
    cases = json.load(open(corpus_path, encoding="utf-8"))
    out = []
    for c in cases:
        rec = {"name": c["name"], "body_sha256": hashlib.sha256(c["body"].encode("utf-8", "surrogatepass")).hexdigest()}
        try:
            conversation, tools, kwargs, agp = vllm_request(json.loads(c["body"]))
            text = tpl.render(messages=conversation, tools=tools, add_generation_prompt=agp, **kwargs)
            rec["render_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
            rec["render_len"] = len(text)
            rec["render"] = text if len(text) < 20000 else None
            rec["tokens"] = len(tok.encode(text, add_special_tokens=False).ids)
            rec["error"] = None
        except jinja2.exceptions.TemplateError as e:
            rec["error"] = {"type": "template", "message": str(e)}
        except VLLMValidationError as e:
            rec["error"] = {"type": "validation", "message": str(e)}
        except Exception as e:  # noqa: BLE001
            rec["error"] = {"type": "other", "message": f"{type(e).__name__}: {e}"}
        out.append(rec)
    meta = {
        "template_sha256": hashlib.sha256(template.encode("utf-8")).hexdigest(),
        "jinja2": jinja2.__version__,
        "tokenizer_sha256": hashlib.sha256(open(tok_path, "rb").read()).hexdigest(),
        "vllm_logic": "vllm-project/vllm @8cc9aa5 (chat_utils.py, renderers/hf.py, protocol.py), transcribed",
        "cases": out,
    }
    with gzip.GzipFile(out_path, "wb", mtime=0) as f:  # mtime=0: byte-reproducible fixture
        f.write(json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    ok = sum(1 for r in out if r["error"] is None)
    print(f"{len(out)} cases ({ok} rendered, {len(out) - ok} errors) -> {out_path}")


if __name__ == "__main__":
    main()
