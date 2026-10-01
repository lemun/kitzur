"""Deterministic simulated browser-automation agent session, shared by the mock
model server and the simulated agent client.

The agent works like an OpenCode/Kilo session on a Playwright MCP task:
large accessibility snapshots, file reads, edits, test runs. Seven facts are
planted through different channels so we can see which channels survive the
proxy's compactions.
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENIZER_PATH = os.environ.get("KITZUR_BENCH_TOKENIZER", os.path.join(HERE, "..", "tok", "Qwen_Qwen3.6-27B.json"))

# marker -> (label, channel)
FACTS = {
    "GOAL-CHK-7F3A": ("task goal", "first user message (head)"),
    "DECISION-D42": ("decision", "assistant visible text, step 2"),
    "USER-RULE-Q7": ("user constraint", "user message typed mid-session, after step 9"),
    "UNFINISHED-9K": ("unfinished item", "assistant visible text, step 14"),
    "TODO-P3-RETRY": ("unfinished item (todo)", "todowrite tool-call args + its tool result, step 3"),
    "src/pages/legacy/PromoBanner.ts": ("file path", "read tool-call argument only, step 5"),
    "staging-3.override.yaml": ("file path", "inside a long tool output only, step 1"),
}

GOAL_TEXT = (
    "Task GOAL-CHK-7F3A: migrate the checkout E2E suite (tests/e2e/checkout/*.spec.ts) "
    "to the new page-object pattern under src/pages/, then make every checkout spec pass "
    "against the staging-3 environment using the Playwright MCP browser to inspect pages. "
    "Do not change application code."
)
USER_INJECT = {
    9: "Important, USER-RULE-Q7: do NOT modify anything under tests/legacy/ - the compatibility suite covers "
       "those files. Also keep using the staging-3 environment only.",
}

# ---------------------------------------------------------------- tokenizer
_tok = None


def tokenizer():
    global _tok
    if _tok is None:
        from tokenizers import Tokenizer
        _tok = Tokenizer.from_file(TOKENIZER_PATH)
    return _tok


def render(body):
    """Approximate the Qwen chat template: tools JSON in the system turn,
    one <|im_start|> block per message, tool calls as JSON in <tool_call>."""
    out = []
    tools = body.get("tools") or []
    msgs = body.get("messages") or []
    sys_text = ""
    if msgs and msgs[0].get("role") == "system":
        sys_text = content_text(msgs[0].get("content"))
        msgs = msgs[1:]
    if tools:
        sys_text += "\n\n# Tools\n\n<tools>\n" + "\n".join(
            json.dumps(t, ensure_ascii=False) for t in tools) + "\n</tools>"
    out.append(f"<|im_start|>system\n{sys_text}<|im_end|>\n")
    for m in msgs:
        role = m.get("role")
        text = content_text(m.get("content"))
        if role == "assistant":
            calls = "".join(
                "\n<tool_call>\n" + json.dumps({"name": c["function"]["name"],
                                                 "arguments": c["function"]["arguments"]},
                                                ensure_ascii=False) + "\n</tool_call>"
                for c in m.get("tool_calls") or [])
            out.append(f"<|im_start|>assistant\n{text}{calls}<|im_end|>\n")
        elif role == "tool":
            out.append(f"<|im_start|>user\n<tool_response>\n{text}\n</tool_response><|im_end|>\n")
        else:
            out.append(f"<|im_start|>{role}\n{text}<|im_end|>\n")
    out.append("<|im_start|>assistant\n")
    return "".join(out)


def count_tokens(body):
    return len(tokenizer().encode(render(body), add_special_tokens=False).ids)


def count_text(text):
    return len(tokenizer().encode(text, add_special_tokens=False).ids)


def content_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return str(content)


def est_tokens(value):
    """gobstopper's estimate: spaced-JSON characters / 4 (close enough)."""
    return len(json.dumps(value, ensure_ascii=False)) // 4


# ---------------------------------------------------------------- fixed fields
def system_prompt():
    rng = random.Random(1)
    rules = [
        "Prefer editing existing files over creating new ones.",
        "Run the relevant spec after every change and read the failure output carefully.",
        "Use the Playwright MCP browser tools to inspect the live page before writing selectors.",
        "Never commit, push, or change git configuration.",
        "Keep responses short; the user reads them in a terminal.",
        "When a tool call fails, explain why before retrying.",
        "Use todowrite to track multi-step work and keep it current.",
        "Quote exact file paths and line numbers when referring to code.",
    ]
    paras = []
    for i in range(46):
        r = rng.sample(rules, 4)
        paras.append(f"## Guideline {i}\n" + " ".join(r) + " " +
                     "This project uses TypeScript, Playwright test runner, and page objects. " * 2)
    return "You are a browser automation coding agent working in the user's repository.\n\n" + "\n\n".join(paras)


def tools():
    def fn(name, desc, props):
        return {"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": {
                k: {"type": v[0], "description": v[1]} for k, v in props.items()},
                "required": list(props)[:1]}}}
    long = ("Detailed usage notes: call this tool only when needed, prefer precise arguments, "
            "and read the returned output fully before acting. ") * 6
    agent_tools = [
        fn("bash", "Run a shell command. " + long, {"command": ("string", "command to run"), "timeout": ("number", "ms")}),
        fn("read", "Read a file. " + long, {"filePath": ("string", "absolute path"), "offset": ("number", "line"), "limit": ("number", "lines")}),
        fn("edit", "Edit a file by exact string replacement. " + long, {"filePath": ("string", "path"), "oldString": ("string", "old"), "newString": ("string", "new")}),
        fn("write", "Write a file. " + long, {"filePath": ("string", "path"), "content": ("string", "content")}),
        fn("glob", "Find files by pattern. " + long, {"pattern": ("string", "glob")}),
        fn("grep", "Search file contents. " + long, {"pattern": ("string", "regex"), "path": ("string", "dir")}),
        fn("todowrite", "Update the todo list. " + long, {"todos": ("array", "todo items")}),
        fn("task", "Launch a subagent. " + long, {"prompt": ("string", "task"), "description": ("string", "short")}),
        fn("webfetch", "Fetch a URL. " + long, {"url": ("string", "url")}),
    ]
    pw = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form",
          "browser_select_option", "browser_hover", "browser_press_key", "browser_wait_for",
          "browser_take_screenshot", "browser_console_messages", "browser_network_requests",
          "browser_evaluate", "browser_tabs", "browser_close", "browser_resize", "browser_drag",
          "browser_file_upload", "browser_handle_dialog", "browser_navigate_back", "browser_install"]
    pw_tools = [fn(n, f"Playwright MCP: {n.replace('_', ' ')}. " + long[:300],
                   {"element": ("string", "Human-readable element description"),
                    "ref": ("string", "Exact target element reference from the page snapshot"),
                    "url": ("string", "URL")}) for n in pw]
    return agent_tools + pw_tools


# ---------------------------------------------------------------- tool outputs
WORDS = ("cart promo coupon shipping billing address payment card total subtotal tax order "
         "summary checkout continue apply remove quantity item product delivery express "
         "standard gift wrap newsletter account login guest email phone country city zip").split()


def snapshot(rng, chars, url):
    """Playwright MCP style ARIA snapshot of roughly `chars` characters."""
    lines = [f"### Page state\n- Page URL: {url}\n- Page Title: Checkout - Shop\n- Page Snapshot:\n```yaml"]
    ref = 1
    depth = 0
    size = sum(len(x) for x in lines)
    roles = ["generic", "link", "button", "textbox", "listitem", "cell", "row", "heading", "img",
             "combobox", "option", "checkbox", "paragraph", "list", "region", "navigation"]
    while size < chars:
        role = rng.choice(roles)
        name = " ".join(rng.choice(WORDS).capitalize() if i == 0 else rng.choice(WORDS)
                        for i in range(rng.randint(1, 4)))
        extra = ""
        if role in ("link", "button"):
            extra = " [cursor=pointer]"
        if role == "cell":
            name = f"${rng.randint(1, 999)}.{rng.randint(10, 99)}"
        line = "  " * depth + f'- {role} "{name}" [ref=e{ref}]{extra}' + (":" if role in ("generic", "list", "row", "region", "navigation") else "")
        if role == "link":
            line += "\n" + "  " * (depth + 1) + f"- /url: /{rng.choice(WORDS)}/{rng.randint(100, 9999)}"
        if role == "textbox":
            line += "\n" + "  " * (depth + 1) + f'- text: "{rng.choice(WORDS)}"'
        lines.append(line)
        size += len(line) + 1
        ref += 1
        if line.endswith(":"):
            depth = min(depth + 1, 9)
        elif rng.random() < 0.25 and depth > 0:
            depth -= rng.randint(1, depth)
    lines.append("```")
    return "\n".join(lines)


def code_file(rng, chars, name, inject=None):
    out = [f"// {name}", "import { test, expect, Page } from '@playwright/test';", ""]
    size = 0
    i = 0
    while size < chars:
        w = rng.choice(WORDS)
        block = (f"export async function {w}Step{i}(page: Page) {{\n"
                 f"  await page.getByTestId('{w}-{i}').click();\n"
                 f"  await expect(page.getByTestId('{w}-summary')).toContainText('{rng.choice(WORDS)}');\n"
                 f"  // TODO({rng.choice(WORDS)}): verify {rng.choice(WORDS)} {rng.choice(WORDS)} flow\n}}\n")
        out.append(block)
        size += len(block)
        i += 1
        if inject and i == 7:
            out.append(inject)
    return "\n".join(out)


def test_output(rng, chars, ok):
    lines = ["Running 14 tests using 4 workers", ""]
    size = 0
    n = 0
    while size < chars:
        n += 1
        w = rng.choice(WORDS)
        mark = "✓" if ok or rng.random() < 0.8 else "✘"
        line = f"  {mark}  {n} [chromium] › checkout/{w}.spec.ts:{rng.randint(5, 200)}:{rng.randint(3, 9)} › {w} {rng.choice(WORDS)} ({rng.randint(300, 9000)}ms)"
        if mark == "✘":
            line += (f"\n    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()\n"
                     f"    Locator: getByTestId('{w}-{n}')\n    at tests/e2e/checkout/{w}.spec.ts:{rng.randint(5, 200)}")
        lines.append(line)
        size += len(line)
    lines.append(f"\n  {n} passed" if ok else f"\n  {n - 2} passed, 2 failed")
    return "\n".join(lines)


# ---------------------------------------------------------------- step script
def _kind(step):
    fixed = {0: "ls", 1: "read_config", 2: "navigate", 3: "todo", 4: "snapshot", 5: "read_legacy"}
    if step in fixed:
        return fixed[step]
    cycle = ["click", "read", "edit", "snapshot", "test", "navigate", "grep", "edit", "snapshot", "test"]
    return cycle[(step - 6) % len(cycle)]


CHATTY = (" My reasoning so far: the checkout flow has several page objects that still rely on "
          "class selectors; I compared the snapshot with the spec, noted which elements expose "
          "data-testid attributes, and planned the next edit so the spec stays readable. ") * 4


def _text(step, kind, rng):
    t = _text_base(step, kind, rng)
    if os.environ.get("SIM_CHATTY") and step not in (2, 14):
        return (t or "Continuing.") + CHATTY
    return t


def _text_base(step, kind, rng):
    if step == 2:
        return ("DECISION-D42: we will use data-testid selectors only, never CSS classes, because "
                "the design system renames classes every release. Opening the checkout page now.")
    if step == 14:
        return ("Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky "
                "(the promo banner animates in late); I will come back to it after the payment page.")
    if rng.random() < 0.25:
        return ""  # models often emit a bare tool call
    return {
        "click": "Clicking the next checkout control to see the resulting state.",
        "read": "Reading the page object to update its selectors.",
        "edit": "Replacing the class selector with a data-testid locator.",
        "snapshot": "Taking a fresh snapshot to confirm the change rendered.",
        "test": "Running the checkout specs.",
        "navigate": "Navigating to the next checkout page.",
        "grep": "Searching for remaining class-based selectors.",
        "ls": "Exploring the test layout first.",
        "read_config": "Reading the Playwright config.",
        "todo": "Recording the plan.",
        "read_legacy": "Checking the legacy promo banner helper.",
    }[kind] + f" (step {step})"


def huge_snapshot_step():
    v = os.environ.get("SIM_HUGE_AT")
    return (int(v), int(os.environ.get("SIM_HUGE_CHARS", "240000"))) if v else (None, None)


def step_plan(step):
    """(assistant_text, tool_name, args_dict) for step `step`."""
    rng = random.Random(1000 + step)
    kind = _kind(step)
    text = _text(step, kind, rng)
    page = rng.choice(["cart", "shipping", "payment", "review", "confirmation", "promo"])
    if kind == "ls":
        call = ("bash", {"command": "ls -R tests/e2e | head -300"})
    elif kind == "read_config":
        call = ("read", {"filePath": "/repo/playwright.config.ts"})
    elif kind == "navigate":
        call = ("browser_navigate", {"url": f"https://staging-3.shop.example/checkout/{page}"})
    elif kind == "todo":
        call = ("todowrite", {"todos": [
            {"content": "Migrate cart page objects", "status": "in_progress"},
            {"content": "Migrate payment page objects", "status": "pending"},
            {"content": "TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts", "status": "pending"},
            {"content": "Run full checkout suite on staging-3", "status": "pending"}]})
    elif kind == "snapshot":
        call = ("browser_snapshot", {})
    elif kind == "read_legacy":
        call = ("read", {"filePath": "/repo/src/pages/legacy/PromoBanner.ts"})
    elif kind == "click":
        call = ("browser_click", {"element": f"{page} continue button", "ref": f"e{rng.randint(10, 900)}"})
    elif kind == "read":
        call = ("read", {"filePath": f"/repo/src/pages/{page.capitalize()}Page.ts"})
    elif kind == "edit":
        call = ("edit", {"filePath": f"/repo/src/pages/{page.capitalize()}Page.ts",
                         "oldString": f"page.locator('.{page}-btn')",
                         "newString": f"page.getByTestId('{page}-continue')"})
    elif kind == "test":
        call = ("bash", {"command": f"npx playwright test tests/e2e/checkout/{page}.spec.ts --reporter=line"})
    elif kind == "grep":
        call = ("grep", {"pattern": "locator\\('\\.", "path": "/repo/src/pages"})
    return text, call[0], call[1]


def assistant_message(step):
    text, name, args = step_plan(step)
    return {"role": "assistant", "content": text or None, "tool_calls": [{
        "id": f"call_{step:04d}_0", "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)}}]}


def tool_output(step):
    out = _tool_output(step)
    cap = int(os.environ.get("SIM_CAP_BYTES", "0"))
    if cap:  # OpenCode Truncate.output: head, 2000 lines / cap bytes, full output saved to a file
        lines, kept, size = out.split("\n"), [], 0
        for i, line in enumerate(lines[:2000]):
            b = len(line.encode()) + (1 if i else 0)
            if size + b > cap:
                break
            kept.append(line)
            size += b
        if len(kept) < len(lines):
            removed = len(out.encode()) - size
            out = ("\n".join(kept) + f"\n\n...{removed} bytes truncated...\n\nThe tool call succeeded but the "
                   f"output was truncated. Full output saved to: /users/example/.local/share/opencode/tool-output/"
                   f"tool_{step:04d}\nUse Grep to search the full content or Read with offset/limit to view specific sections.")
    return out


def _tool_output(step):
    rng = random.Random(5000 + step)
    kind = _kind(step)
    huge_at, huge_chars = huge_snapshot_step()
    _, name, args = step_plan(step)
    if huge_at is not None and step == huge_at:
        return snapshot(rng, huge_chars, "https://staging-3.shop.example/checkout/admin-orders")
    if kind == "ls":
        return "\n".join(f"tests/e2e/{rng.choice(WORDS)}/{rng.choice(WORDS)}_{i}.spec.ts" for i in range(90))
    if kind == "read_config":
        return code_file(rng, 6000, "playwright.config.ts",
                         inject="// env overrides are loaded from config/envs/staging-3.override.yaml (see loadEnv)\n")
    if kind == "todo":
        return json.dumps(args["todos"], indent=2)
    if kind in ("navigate", "click", "snapshot"):
        # Playwright MCP returns the page snapshot after navigate/click too.
        chars = rng.choice([30000, 40000, 50000, 60000, 80000]) if kind != "click" else rng.choice([20000, 30000, 45000])
        return snapshot(rng, chars, args.get("url", "https://staging-3.shop.example/checkout/current"))
    if kind == "read_legacy":
        return code_file(rng, 5000, "PromoBanner.ts")
    if kind == "read":
        return code_file(rng, rng.choice([4000, 7000, 10000]), args["filePath"].rsplit("/", 1)[-1])
    if kind == "edit":
        return "Edit applied successfully."
    if kind == "test":
        return test_output(rng, rng.choice([2500, 4000, 6000]), ok=rng.random() < 0.4)
    if kind == "grep":
        return "\n".join(f"/repo/src/pages/{rng.choice(WORDS).capitalize()}Page.ts:{rng.randint(1, 300)}:  await page.locator('.{rng.choice(WORDS)}-btn').click();" for _ in range(40))
    raise ValueError(kind)
