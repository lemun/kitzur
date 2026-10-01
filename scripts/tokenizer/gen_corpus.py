"""Generate the agreement corpus (data/corpus.jsonl) and Python reference ids (data/ref.jsonl).

Usage: <venv>/bin/python scripts/gen_corpus.py <sim_dir> <tokenizer.json> [n_fuzz]
Each corpus line: {"cat": <category>, "text": <string>}; ref line: {"ids": [...]}.
Deterministic (fixed seeds).
"""
import json
import os
import random
import sys
import unicodedata

SIM = sys.argv[1]
TOK = sys.argv[2]
N_FUZZ = int(sys.argv[3]) if len(sys.argv) > 3 else 5000
sys.path.insert(0, SIM)
import scenario  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
os.makedirs(OUT, exist_ok=True)

corpus = []


def add(cat, text):
    corpus.append({"cat": cat, "text": text})


# ---------------------------------------------------------------- realistic agent traffic
rng = random.Random(7)
for i in range(30):
    add("snapshot", scenario.snapshot(rng, rng.choice([2000, 8000, 20000, 60000]), f"https://staging-3.shop.example/checkout/p{i}"))
add("snapshot-300k", scenario.snapshot(random.Random(99), 300_000, "https://staging-3.shop.example/checkout/big"))
for i in range(20):
    add("code", scenario.code_file(rng, rng.choice([1000, 5000, 20000]), f"src/pages/P{i}.ts"))
for i in range(20):
    add("test-output", scenario.test_output(rng, rng.choice([500, 3000, 12000]), rng.random() < 0.5))
add("system+tools", scenario.render({"messages": [{"role": "system", "content": scenario.system_prompt()}], "tools": scenario.tools()}))

# full rendered chat-template requests (contain <|im_start|>, <tool_call>, <tool_response> ...)
msgs = [{"role": "system", "content": scenario.system_prompt()}, {"role": "user", "content": scenario.GOAL_TEXT}]
for step in range(47):
    msgs.append(scenario.assistant_message(step))
    msgs.append({"role": "tool", "tool_call_id": f"call_{step:04d}_0", "content": scenario.tool_output(step)})
    if step in scenario.USER_INJECT:
        msgs.append({"role": "user", "content": scenario.USER_INJECT[step]})
    if step in (3, 12, 25, 46):
        add("rendered-request", scenario.render({"messages": list(msgs), "tools": scenario.tools()}))

# ---------------------------------------------------------------- Hebrew UI text
HE = ("עגלה קופה תשלום משלוח כתובת הזמנה סיכום מחיר כמות מוצר המשך אישור ביטול חזרה התחברות אורח "
      "דואל טלפון עיר מיקוד שגיאה הצלחה נא להזין שדה חובה קוד קופון הנחה מע״מ סה״כ ש״ח").split()
NIQQUD = [chr(c) for c in range(0x05B0, 0x05BD)] + ["\u05C1", "\u05C2", "\u05C7", "\u05BF"]
for i in range(200):
    parts = []
    for _ in range(rng.randint(3, 40)):
        w = rng.choice(HE)
        if rng.random() < 0.15:
            w = "".join(ch + (rng.choice(NIQQUD) if rng.random() < 0.5 else "") for ch in w)
        r = rng.random()
        if r < 0.1:
            w = f'- button "{w}" [ref=e{rng.randint(1, 999)}]'
        elif r < 0.15:
            w = f"{w} {rng.randint(1, 9999)}.{rng.randint(0, 99):02d} ₪"
        elif r < 0.2:
            w = "\u200f" + w + "\u200e"
        elif r < 0.25:
            w = w + "\u05be" + rng.choice(HE)
        elif r < 0.3:
            w = rng.choice(["checkout", "Cart", "ID", "OK"]) + " " + w
        parts.append(w)
    add("hebrew", rng.choice([" ", "\n", " | ", "\n  - "]).join(parts))

# ---------------------------------------------------------------- JSON with escapes
def rand_json(depth=0):
    r = rng.random()
    if depth > 3 or r < 0.3:
        return rng.choice([
            rng.randint(-10**9, 10**9), rng.random() * 1e6, True, None,
            "quote\" back\\slash\n tab\t", "path C:\\\\repo\\src", "ünïcödé ✓ ✘ →", "emoji 😀👍🏽",
            "שלום", "\u0000\u001f ctrl", "line1\r\nline2", "'it's'", "<|im_start|> not special in json",
        ])
    if r < 0.65:
        return {f"k{rng.randint(0, 99)}_{rng.choice(['id', 'name', 'value', 'שם'])}": rand_json(depth + 1) for _ in range(rng.randint(1, 6))}
    return [rand_json(depth + 1) for _ in range(rng.randint(0, 6))]


for i in range(200):
    v = rand_json()
    add("json", json.dumps(v, ensure_ascii=rng.random() < 0.5, indent=rng.choice([None, 2])))

# ---------------------------------------------------------------- emoji / astral / CRLF / whitespace / digits / scripts
EMOJI = ["😀", "👍🏽", "👩‍💻", "🏳️‍🌈", "🇮🇱", "🇺🇸", "1️⃣", "❤️", "✅", "❌", "⚠️", "🔥", "🧪", "👨‍👩‍👧‍👦", "𝐀𝐁𝐂", "𝔘𝔫𝔦", "𠜎𠜱", "🫠"]
for i in range(200):
    add("emoji", "".join(rng.choice(EMOJI) + rng.choice(["", " ", "x", "\n", "1"]) for _ in range(rng.randint(1, 30))))
for i in range(100):
    lines = [f"line {j}: value = {rng.randint(0, 99)};  " for j in range(rng.randint(1, 30))]
    add("crlf", rng.choice(["\r\n", "\r", "\n\r", "\r\r\n"]).join(lines) + rng.choice(["", "\r\n", "\r\n\r\n", "  \r\n"]))
for i in range(200):
    ws = "".join(rng.choice([" ", " ", " ", "\t", "\n", "\r\n", "\u00a0", "\u3000", "\u2028", "\u0085", "\x0b", "\x0c"]) for _ in range(rng.randint(1, 200)))
    n = rng.choice([1, 2, 3, 7, 16, 100, 1000, 5000])
    add("whitespace", rng.choice(["x", "", "def f():", "}"]) + ws + " " * n + rng.choice(["", "y", "\n", "\tz"]) + " " * rng.randint(0, 5))
for i in range(150):
    add("digits", " ".join(rng.choice([str(rng.randint(0, 10**rng.randint(1, 30))), f"{rng.random()*1e6:.4f}", "１２３", "٠١٢٣", "²³¹", "½¼", "ⅫⅣ", "१२३", "0x" + os.urandom(8).hex(), "1e-9", "v1.2.3-rc.4"]) for _ in range(rng.randint(1, 40))))
SCRIPTS = ["Привет мир", "Γειά σου", "مرحبا بالعالم", "नमस्ते दुनिया", "สวัสดีชาวโลก", "你好，世界", "こんにちは世界", "안녕하세요 세계",
           "שלום עולם", "Ｆｕｌｌｗｉｄｔｈ", "ǅemal", "straße", "İstanbul", "ﬁnal ﬂow", "Ω≈ç√∫", "e\u0301\u0327", "\u1100\u1161\u11a8", "ᄀ ᅡ ᆨ"]
for i in range(200):
    add("mixed-scripts", "".join(rng.choice(SCRIPTS) + rng.choice([" ", "", "\n", "123", "'s", "'S", "'ll", "'ſ", "…", "—"]) for _ in range(rng.randint(1, 20))))

# long single pieces (BPE heap path)
add("long-piece", "a" * 20000)
add("long-piece", "".join(rng.choice("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(30000)))
add("long-piece", " " * 30000 + "x")
add("long-piece", "=" * 10000 + "\n" + "-" * 10000)
add("long-piece", "".join(rng.choice("אבגדהוזחטיכלמנסעפצקרשת") for _ in range(10000)))
add("long-piece", "e\u0301" * 3000)
add("long-piece", "😀" * 3000)

# ---------------------------------------------------------------- random unicode fuzz
WS_SET = [" ", "\t", "\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x1f", "\x85", "\xa0", "\u1680", "\u180e", "\u2000", "\u2007",
          "\u200a", "\u200b", "\u200c", "\u200d", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u00ad", "\u2060"]
MARK_RANGES = [(0x0300, 0x036F), (0x0483, 0x0489), (0x0591, 0x05C7), (0x064B, 0x065F), (0x0900, 0x0903), (0x093C, 0x094D), (0x0E31, 0x0E3A),
               (0x1AB0, 0x1AFF), (0x1DC0, 0x1DFF), (0x20D0, 0x20F0), (0xFE20, 0xFE2F), (0x1D165, 0x1D169), (0x0F71, 0x0F84)]
# chars that differ between the Rust NFC tables (Unicode 9) and ICU, and Unicode 17 additions
EXC = [0x7FD, 0x897, 0x8CA, 0x9FE, 0xC3C, 0xD3B, 0xEBA, 0x1715, 0x1ABF, 0x1ACF, 0x1AE0, 0x1DF6, 0xA82C, 0x105C9, 0x105D2, 0x10D24, 0x10F46,
       0x11070, 0x1133B, 0x11382, 0x113B8, 0x113C2, 0x11935, 0x11938, 0x1611E, 0x16D67, 0x1E08F, 0x1E6E3, 0x88F, 0xA7CE, 0x10940, 0x11DB0,
       0x16EA0, 0x323B0, 0x11DE0, 0x16FF4]
ADDED = ["<|im_start|>", "<|im_end|>", "<|endoftext|>", "<think>", "</think>", "<tool_call>", "</tool_call>", "<tool_response>",
         "</tool_response>", "<|fim_prefix|>", "<|vision_pad|>", "<|im_start", "im_end|>", "<|", "|>", "<think", "<<think>>", "<|im_start|><|im_end|>"]


def rand_cp():
    r = rng.random()
    if r < 0.2:
        return chr(rng.randint(0x20, 0x7E))
    if r < 0.3:
        return rng.choice(WS_SET)
    if r < 0.45:
        a, b = rng.choice(MARK_RANGES)
        return chr(rng.randint(a, b))
    if r < 0.55:
        c = rng.randint(0, 0xFFFF)
        return chr(c) if not (0xD800 <= c <= 0xDFFF) else "?"
    if r < 0.6:
        return chr(rng.randint(0x10000, 0x10FFFF))
    if r < 0.66:
        c = rng.choice(EXC)
        return chr(c + rng.randint(0, 3))
    if r < 0.72:
        return rng.choice(["'", "'s", "'S", "'ſ", "'t", "'RE", "'Ll", "'d", "'m", "'ve", "'K", "'K"])
    if r < 0.78:
        return rng.choice(ADDED)
    if r < 0.84:
        return chr(rng.randint(0x05D0, 0x05EA))
    if r < 0.88:
        return chr(rng.choice([0x1100, 0x1161, 0x11A8, 0xAC00, 0x1112, 0x1175, 0x11C2]) + rng.randint(0, 5))
    if r < 0.92:
        return rng.choice("0123456789٠١٢١٢३४５６²³½Ⅻⅰ")
    if r < 0.96:
        return rng.choice(["\u00e9", "e\u0301", "\u1e9b\u0323", "\u0344", "\u0958", "\u2126", "\u212b", "\uf900", "\u0f73", "\u1f80", "\u0390"])
    return rng.choice(EMOJI)


for i in range(N_FUZZ):
    add("fuzz", "".join(rand_cp() for _ in range(rng.randint(1, rng.choice([8, 40, 200])))))

# canonical-ordering stress: base + random marks from every ccc>0 char of this Python's Unicode
CCC_MARKS = [chr(c) for c in range(0x110000) if not (0xD800 <= c <= 0xDFFF) and unicodedata.combining(chr(c))]
for i in range(2000):
    s = ""
    for _ in range(rng.randint(1, 10)):
        s += rng.choice(["a", "e", "o", "u", "i", "A", "\u05d0", "\u0915", "\u1100", "\u0627", " ", "1"]) + "".join(rng.choice(CCC_MARKS) for _ in range(rng.randint(0, 5)))
    add("nfc-order", s)

tok = Tokenizer.from_file(TOK)
with open(os.path.join(OUT, "corpus.jsonl"), "w", encoding="utf-8") as f:
    for c in corpus:
        f.write(json.dumps(c, ensure_ascii=True) + "\n")
with open(os.path.join(OUT, "ref.jsonl"), "w") as f:
    encs = tok.encode_batch([c["text"] for c in corpus], add_special_tokens=False)
    for e in encs:
        f.write(json.dumps({"ids": e.ids}) + "\n")
cats = {}
for c in corpus:
    k = cats.setdefault(c["cat"], [0, 0])
    k[0] += 1
    k[1] += len(c["text"])
print(json.dumps({"n": len(corpus), "cats": cats, "unicode": unicodedata.unidata_version}))
