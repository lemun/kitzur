"""Direct NFC oracle: random mark/composite-heavy strings and HF's normalizer output.
Writes data/nfc_oracle.jsonl lines [input, normalized]. Usage: gen_nfc_oracle.py <tokenizer.json> [n]"""
import json, random, sys, unicodedata
from tokenizers import Tokenizer
norm = Tokenizer.from_file(sys.argv[1]).normalizer
N = int(sys.argv[2]) if len(sys.argv) > 2 else 200000
rng = random.Random(42)
ok = lambda c: not (0xD800 <= c <= 0xDFFF)
ALL = [c for c in range(0x110000) if ok(c)]
MARKS = [chr(c) for c in ALL if unicodedata.combining(chr(c))]
DECOMP = [chr(c) for c in ALL if unicodedata.decomposition(chr(c)) and not unicodedata.decomposition(chr(c)).startswith('<')]
BASES = [chr(c) for c in {ord(unicodedata.normalize('NFD', d)[0]) for d in DECOMP}]
JAMO = [chr(c) for c in list(range(0x1100, 0x1113)) + list(range(0x1161, 0x1176)) + list(range(0x11A7, 0x11C3))] + [chr(0xAC00 + rng.randrange(11172)) for _ in range(200)]
NEW = [chr(c) for c in ALL if unicodedata.category(chr(c)) in ('Mn', 'Mc', 'Me') and c > 0x1000]
pools = [MARKS, DECOMP, BASES, JAMO, NEW, list('aeiouAEIOU '), [chr(rng.choice(ALL)) for _ in range(5000)]]
out = open('data/nfc_oracle.jsonl', 'w', encoding='utf-8')
for i in range(N):
    s = ''.join(rng.choice(rng.choice(pools)) for _ in range(rng.randint(1, 12)))
    out.write(json.dumps([s, norm.normalize_str(s)]) + '\n')
print(N, 'cases; python unicodedata', unicodedata.unidata_version, 'marks', len(MARKS), 'decomp', len(DECOMP))
