"""Exhaustive per-code-point agreement probe.
For every Unicode scalar value c (U+0000..U+10FFFF minus surrogates) build one text that puts c in
several pre-tokenizer / NFC contexts, plus one extra text with Python's NFD(c) when it differs.
Writes data/cp_texts.jsonl (one JSON string per line) and data/cp_ref.txt ("len hash" per line),
hash = h*31+id mod 2^32 over the ids.
Usage: <venv>/bin/python scripts/gen_exhaustive.py <tokenizer.json>
"""
import json, os, sys, unicodedata
from tokenizers import Tokenizer
tok = Tokenizer.from_file(sys.argv[1])
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
texts = []
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    c = chr(cp)
    texts.append(f"x'{c}x {c}{c}a1{c}1 {c}\t{c}\n{c}{c}\n q{c}̴ qͅ{c}<|im_end|>{c}")
    d = unicodedata.normalize("NFD", c)
    if d != c:
        texts.append(f"{d}x{d}̴{d}")
with open(os.path.join(OUT, "cp_texts.jsonl"), "w", encoding="utf-8") as f:
    for t in texts:
        f.write(json.dumps(t, ensure_ascii=False) + "\n")
M = (1 << 32) - 1
with open(os.path.join(OUT, "cp_ref.txt"), "w") as f:
    B = 50000
    for i in range(0, len(texts), B):
        for e in tok.encode_batch(texts[i:i + B], add_special_tokens=False):
            h = 0
            for x in e.ids:
                h = (h * 31 + x) & M
            f.write(f"{len(e.ids)} {h}\n")
print(len(texts), "texts")
