"""Encode an existing corpus with another tokenizer.json: ref_encode.py <tokenizer.json> <corpus.jsonl> <out.jsonl>"""
import json, sys
from tokenizers import Tokenizer
tok = Tokenizer.from_file(sys.argv[1])
texts = [json.loads(l)["text"] for l in open(sys.argv[2], encoding="utf-8")]
with open(sys.argv[3], "w") as f:
    for e in tok.encode_batch(texts, add_special_tokens=False):
        f.write(json.dumps({"ids": e.ids}) + "\n")
