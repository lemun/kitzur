"""Extra Python json vectors for src/tokenize/pyjson.ts (dev only):

    python scripts/tokenizer/gen_pyjson_extra.py | gzip -9n > test/fixtures/pyjson-extra.json.gz

floats:  [IEEE-754 bits as 16 hex digits, repr(x), json.dumps(x)] for special values, powers of ten
         around the fixed/exponent switch, and seeded random doubles (random bit patterns and
         "human" decimals);
loads:   [text, json.dumps(json.loads(text), ensure_ascii=False)] round trips (int vs float lexemes,
         big ints, -0, exponents, duplicate keys, escapes, lone surrogates, NaN/Infinity).
"""
import json
import random
import struct
import sys


def bits(x):
    return struct.pack(">d", x).hex()


vals = [0.0, -0.0, 1.0, -1.0, 0.1, 0.5, 1.5, 2.5, 1e-4, 1e-5, 1.5e-5, 0.0001234, 1e15, 1e16, 1.5e16, 9999999999999998.0,
        1e17, 1e21, 1e22, 1e23, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 123456789.123, 3e-07,
        0.30000000000000004, 100.0, 12345678901234567.0, float(2 ** 53), 2.0 ** 53 + 2.0, float("inf"), float("-inf"), float("nan")]
vals += [10.0 ** k for k in range(-12, 25)] + [-(10.0 ** k) * 1.5 for k in range(-12, 25)]
rng = random.Random(20260928)
for _ in range(600):
    x = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0]
    if x == x and abs(x) != float("inf"):
        vals.append(x)
for _ in range(400):
    vals.append(round(rng.uniform(-1e6, 1e6), rng.randint(0, 8)))
    vals.append(rng.randint(1, 999) * 10.0 ** rng.randint(-10, 20))

floats = [[bits(v), repr(v), json.dumps(v)] for v in vals]

loads_src = [
    '1', '-0', '-0.0', '0.0', '1.0', '1e5', '1E+2', '1.5e300', '1e400', '-1e400', '12345678901234567890', '-9007199254740993',
    '9007199254740992', '0.1', '2.50', '[1, 2.0, 3e0, -4.5e-3]', '{"b": 1, "a": 2, "10": 3, "2": 4}', '{"k": 1, "k": 2}',
    '{"s": "\\u00e9\\ud83d\\ude00\\n\\t\\"\\\\\\/"}', '{"lone": "\\ud800x"}', '[NaN, Infinity, -Infinity]', ' {"a" : [ true , false , null ] } ',
    '{"nested": {"deeper": [{"x": [null, false, 1.25, {}]}]}}', '"plain"', '[]', '{}', '"שלום"',
]
loads = [[s, json.dumps(json.loads(s), ensure_ascii=False)] for s in loads_src]
bad = ['', '01', '[1,]', '{"a" 1}', '"\x01"', 'tru', '[1] x', '{"a": 1', '"\\x"', '1.', '.5', '+1', "'a'"]
errors = []
for s in bad:
    try:
        json.loads(s)
        errors.append([s, False])
    except json.JSONDecodeError:
        errors.append([s, True])
json.dump({"python": sys.version.split()[0], "floats": floats, "loads": loads, "errors": errors}, sys.stdout)  # ASCII file: lone surrogates survive as \\u escapes
