"""Offline simulation of OpenCode's built-in compaction mechanics on the same
session (OpenCode commit b471c2b, packages/opencode/src/session/compaction.ts
and overflow.ts). No model: the summary is a placeholder of SUMMARY_TOKENS.

Modelled (READ from source):
- trigger: last step's reported tokens (prompt+completion) >= usable, where
  usable = context - min(model.limit.output, 32000) = 100k - 32k = 68k; and a
  provider context-overflow error on a request.
- tail kept verbatim: newest user-turns within preserve_recent_tokens =
  min(15000, max(2000, usable*0.25)) estimated as JSON chars/4, splitting the
  newest turn at message granularity (a tool call and its result are parts of
  one assistant message, so pairs are never split).
- summarizer input: the head serialized with each tool result cut to 2000
  chars, plus the previous summary, plus the fixed template; one LLM call.
- after compaction the model sees [compaction marker, summary, tail, "Continue..."];
  the original first user message is not kept unless it is in the tail.
Not modelled: the overflow path's "replay" of the last user message; prune
(off by default); the summarizer model's actual retention (reported as
"visible to the summarizer" = best case).

usage: baseline.py [--summary-tokens N] [--steps N]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenario  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--summary-tokens", type=int, default=1500)
ap.add_argument("--steps", type=int, default=46)
ap.add_argument("--limit", type=int, default=100_000)
ap.add_argument("--max-out", type=int, default=32_000)
A = ap.parse_args()
USABLE = A.limit - A.max_out
PRESERVE = min(15_000, max(2_000, USABLE * 25 // 100))
TEMPLATE_CHARS = 2400  # SUMMARY_TEMPLATE + instructions, approx
SHORT = {"GOAL-CHK-7F3A": "goal", "DECISION-D42": "decision", "USER-RULE-Q7": "user-rule",
         "UNFINISHED-9K": "unfinished(text)", "TODO-P3-RETRY": "unfinished(todo)",
         "src/pages/legacy/PromoBanner.ts": "path(call arg)", "staging-3.override.yaml": "path(tool output)"}

system = {"role": "system", "content": scenario.system_prompt()}
tools = scenario.tools()
goal = {"role": "user", "content": scenario.GOAL_TEXT}


def est(msgs):
    return len(json.dumps(msgs, ensure_ascii=False)) // 4


def serialize(unit):
    out = []
    for m in unit:
        if m["role"] == "user":
            out.append(f"[User]: {m['content']}")
        elif m["role"] == "assistant":
            if m.get("content"):
                out.append(f"[Assistant]: {m['content']}")
            for c in m.get("tool_calls") or []:
                out.append(f"[Assistant tool call]: {c['function']['name']}({c['function']['arguments']})")
        elif m["role"] == "tool":
            t = m["content"]
            out.append("[Tool result]: " + (t if len(t) <= 2000 else t[:2000] + "\n[truncated]"))
    return "\n".join(out)


# visible units after the last compaction; a unit is a list of chat messages
units = [[goal]]
summary = None          # (text, facts it may contain)
rows, totals = [], {"main": 0, "rejected": 0, "summ_in": 0, "summ_out": 0, "compactions": 0,
                     "overflow_errors": 0, "completion": 0}
rewrites = {f: 0 for f in scenario.FACTS}


def context():
    msgs = [system]
    if summary is not None:
        msgs.append({"role": "user", "content": "What did we do so far?"})
        msgs.append({"role": "assistant", "content": summary[0]})
    for u in units:
        msgs.extend(u)
    return msgs


def compact(step, reason, before):
    global units, summary
    # turns start at user units
    starts = [i for i, u in enumerate(units) if u[0]["role"] == "user"]
    keep, total = None, 0
    for t in reversed(range(len(starts))):
        s, e = starts[t], (starts[t + 1] if t + 1 < len(starts) else len(units))
        size = est([m for u in units[s:e] for m in u])
        if total + size <= PRESERVE:
            total += size
            keep = s
            continue
        for s2 in range(s + 1, e):
            if est([m for u in units[s2:e] for m in u]) <= PRESERVE - total:
                keep = s2
                break
        break
    if keep is None or keep == 0:
        head, tail = units, []
    else:
        head, tail = units[:keep], units[keep:]
    text = "\n\n".join(serialize(u) for u in head)
    prior = summary[0] if summary else ""
    summ_in = scenario.count_text(text + prior) + TEMPLATE_CHARS // 4
    visible = {f for f in scenario.FACTS if f in text or (summary and f in summary[1])}
    for f in scenario.FACTS:
        if f in visible and not any(f in json.dumps(u) for u in tail):
            rewrites[f] += 1
    filler = ("- " + "summary bullet " * 6 + "\n") * (A.summary_tokens // 14)
    summary = (filler + "\n" + " ".join(sorted(visible)), visible)
    units = tail + [[{"role": "user", "content": "Continue if you have next steps, or stop and ask for "
                                                  "clarification if you are unsure how to proceed."}]]
    after = scenario.count_tokens({"messages": context(), "tools": tools})
    totals["summ_in"] += summ_in
    totals["summ_out"] += A.summary_tokens
    totals["compactions"] += 1
    rows.append({"n": totals["compactions"], "step": step, "reason": reason, "before": before, "after": after,
                 "summ_in": summ_in, "head_units": len(head), "tail_units": len(tail),
                 "goal_verbatim": any(goal is m for u in tail for m in u),
                 "visible": {SHORT[f]: (f in visible) for f in scenario.FACTS},
                 "tail_has": {SHORT[f]: any(f in json.dumps(u) for u in tail) for f in scenario.FACTS}})


for step in range(A.steps):
    for attempt in range(3):
        body = {"messages": context(), "tools": tools}
        prompt = scenario.count_tokens(body)
        if prompt + A.max_out > A.limit:
            totals["rejected"] += prompt
            totals["overflow_errors"] += 1
            compact(step, "provider overflow error", prompt)
            continue
        break
    else:
        print(f"step {step}: could not fit after compaction")
        break
    totals["main"] += prompt
    msg = scenario.assistant_message(step)
    completion = scenario.count_text((msg["content"] or "") + json.dumps(msg["tool_calls"]))
    totals["completion"] += completion
    unit = [msg, {"role": "tool", "tool_call_id": msg["tool_calls"][0]["id"], "content": scenario.tool_output(step)}]
    units.append(unit)
    if step in scenario.USER_INJECT:
        units.append([{"role": "user", "content": scenario.USER_INJECT[step]}])
    if prompt + completion >= USABLE:
        compact(step + 1, "reported tokens >= usable (68k)", prompt + completion)

print(f"usable={USABLE} preserve_recent_tokens={PRESERVE} summary_tokens={A.summary_tokens}")
print("| # | before next step | reason | before (Qwen) | after (Qwen) | summarizer input (Qwen) | goal msg verbatim | "
      + " | ".join(SHORT[f] for f in scenario.FACTS) + " |")
print("|" + "---|" * (7 + len(scenario.FACTS)))
for r in rows:
    plant = {"GOAL-CHK-7F3A": 0, "staging-3.override.yaml": 2, "DECISION-D42": 3, "TODO-P3-RETRY": 4,
             "src/pages/legacy/PromoBanner.ts": 6, "USER-RULE-Q7": 10, "UNFINISHED-9K": 15}
    cells = ["·" if r["step"] < plant[f] else "tail" if r["tail_has"][SHORT[f]] else ("sum" if r["visible"][SHORT[f]] else "✗")
             for f in scenario.FACTS]
    print(f"| {r['n']} | {r['step']} | {r['reason']} | {r['before']:,} | {r['after']:,} | {r['summ_in']:,} | "
          f"{'yes' if r['goal_verbatim'] else 'no'} | " + " | ".join(cells) + " |")
tot = totals["main"] + totals["rejected"] + totals["summ_in"]
print(json.dumps(dict(totals, total_prompt_tokens=tot, rewrites={SHORT[f]: v for f, v in rewrites.items()})))
