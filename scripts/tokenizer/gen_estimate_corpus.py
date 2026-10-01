"""Estimate-mode corpus with exact Qwen3.6 counts (dev only):

    <venv>/bin/python scripts/tokenizer/gen_estimate_corpus.py --gateway-probes <gateway-probes dir with content.py> \
        --sim <dir with scenario.py> --tokenizer <tokenizer.json> > /dev/null   # writes test/fixtures/estimate-corpus.json.gz

Rows: {"cat", "text" | "step", "tokens"}:
  ep:<kind>   gateway-probes content.py kinds (english_prose, typescript_code, playwright_snapshot_en,
              test_runner_output, json_api, playwright_snapshot_he) at 3,000 and 12,000 chars;
  sim:<kind>  the reference session's raw tool outputs, by step (text in sim-history.json.gz);
  sim:system  the session's system prompt; he:plain / he:prose  plain Hebrew UI words and sentences.
"""
import argparse
import gzip
import json
import os
import random
import sys

from tokenizers import Tokenizer

ap = argparse.ArgumentParser()
ap.add_argument("--gateway-probes", required=True)
ap.add_argument("--sim", required=True)
ap.add_argument("--tokenizer", required=True)
ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "test", "fixtures", "estimate-corpus.json.gz"))
args = ap.parse_args()
sys.path.insert(0, args.gateway_probes)
sys.path.insert(0, args.sim)
import content  # noqa: E402
import scenario  # noqa: E402

tok = Tokenizer.from_file(args.tokenizer)


def n(t):
    return len(tok.encode(t, add_special_tokens=False).ids)


rows = []
for kind, fn in content.KINDS.items():
    for chars in (3000, 12000):
        t = fn(chars)
        rows.append({"cat": "ep:" + kind, "text": t, "tokens": n(t)})
for k in ("SIM_CAP_BYTES", "SIM_CHATTY", "SIM_HUGE_AT"):
    os.environ.pop(k, None)
for step in range(46):
    rows.append({"cat": "sim:" + scenario._kind(step), "step": step, "tokens": n(scenario.tool_output(step))})
rows.append({"cat": "sim:system", "step": -1, "tokens": n(scenario.system_prompt())})
rng = random.Random(7)
for i in range(4):
    t = " ".join(rng.choice(content.HEBREW) for _ in range(300 + 200 * i))
    rows.append({"cat": "he:plain", "text": t, "tokens": n(t)})
sent = ["אני רוצה שתעדכן את הבדיקות של עמוד התשלום.", "אל תשנה קבצים בתיקייה tests/legacy.", "הכפתור 'המשך לתשלום' לא מופיע בזמן.",
        "תריץ שוב את הבדיקה ותבדוק את הסכום הכולל אחרי מע״מ.", "הסביבה היא staging-3 בלבד."]
for i in range(4):
    t = " ".join(rng.choice(sent) for _ in range(20 + 20 * i))
    rows.append({"cat": "he:prose", "text": t, "tokens": n(t)})
with gzip.GzipFile(args.out, "wb", mtime=0, compresslevel=9) as f:
    f.write(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode())
print(len(rows), "rows", file=sys.stderr)
