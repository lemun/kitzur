"""Summarize one run: per-compaction table, fact survival, totals.

usage: analyze.py RUN_DIR [--md]
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenario  # noqa: E402

SUMMARY_HEADER = "The following is a summary of your previous actions (long observations omitted):"
SHORT = {"GOAL-CHK-7F3A": "goal", "DECISION-D42": "decision", "USER-RULE-Q7": "user-rule",
         "UNFINISHED-9K": "unfinished(text)", "TODO-P3-RETRY": "unfinished(todo)",
         "src/pages/legacy/PromoBanner.ts": "path(call arg)", "staging-3.override.yaml": "path(tool output)"}


def jl(path):
    return [json.loads(x) for x in open(path)] if os.path.exists(path) else []


def tool_kind(name, args):
    if name.startswith("browser_"):
        return "snapshot"
    if name == "read":
        return "read"
    if name == "bash":
        return "test/bash"
    return name


def analyze(run):
    client = jl(os.path.join(run, "client.jsonl"))
    ledger = jl(os.path.join(run, "ledger.jsonl"))
    mock = jl(os.path.join(run, "mock.jsonl"))
    by_step_mock = {}
    for m in mock:
        by_step_mock.setdefault(m["step"], []).append(m)
    # ledger has one record per client request, in order
    led = {c["step"]: ledger[i] for i, c in enumerate(client) if i < len(ledger)}
    planted = {}
    for c in client:
        p = os.path.join(run, "origs", f"step{c['step']}.json")
        if os.path.exists(p):
            blob = json.dumps(json.load(open(p))["messages"], ensure_ascii=False)
            for f in scenario.FACTS:
                if f in blob and f not in planted:
                    planted[f] = c["step"]
    rows = []
    comp_i = 0
    prev_compacted_step = None
    b2b = 0
    for c in client:
        s = c["step"]
        attempts = by_step_mock.get(s, [])
        last = attempts[-1] if attempts else {}
        L = led.get(s, {})
        row = {"step": s, "orig_qwen": c["orig_qwen_tokens"], "orig_est": c["orig_est_tokens"],
               "sent_qwen": last.get("prompt_tokens"), "attempts": len(attempts),
               "length_rejections": sum(1 for a in attempts if a.get("rejected_for_length")),
               "pairing_errors": [a["pairing_error"] for a in attempts if a.get("pairing_error")],
               "client_status": c["status"], "compacted": L.get("compacted", False),
               "reused": L.get("reused_prefix", False), "rung": L.get("rung"), "over_budget": L.get("over_budget"),
               "est_out": L.get("est_tokens_out"), "summary_est": L.get("est_summary_tokens"),
               "carry_chars": L.get("carry_chars"), "threshold": L.get("threshold_tokens"),
               "ratio": L.get("ratio_permille"), "facts": last.get("facts", {})}
        # reactive retries also rewrite the request even when the ledger says not compacted
        row["reactive"] = len(attempts) > 1
        if row["compacted"] or row["reactive"]:
            comp_i += 1
            row["compaction_no"] = comp_i
            if prev_compacted_step is not None and s - prev_compacted_step == 1:
                b2b += 1
            prev_compacted_step = s
            row.update(dropped(run, s, attempts[-1]["seq"] if attempts else None))
        rows.append(row)
    return rows, planted, b2b, mock


def dropped(run, step, seq):
    orig_p = os.path.join(run, "origs", f"step{step}.json")
    sent_p = glob.glob(os.path.join(run, "reqs", f"{seq:04d}_step{step}.json")) if seq else []
    if not os.path.exists(orig_p) or not sent_p:
        return {}
    orig = json.load(open(orig_p))["messages"]
    sent = json.load(open(sent_p[0]))["messages"]
    calls = {}
    for m in orig:
        for tc in m.get("tool_calls") or []:
            calls[tc["id"]] = tool_kind(tc["function"]["name"], tc["function"]["arguments"])
    sent_ids = {m.get("tool_call_id") for m in sent if m.get("role") == "tool"}
    summary = next((scenario.content_text(m.get("content")) for m in sent
                    if scenario.content_text(m.get("content")).startswith(SUMMARY_HEADER)), "")
    drop = {}
    in_summary = 0
    budget = {}
    for m in orig:
        if m.get("role") != "tool" or m.get("tool_call_id") in sent_ids:
            continue
        k = calls.get(m["tool_call_id"], "?")
        key = "result: " + m["content"].strip()
        if key not in budget:
            budget[key] = summary.count(key)
        if len(m["content"]) <= 500 and budget[key] > 0:
            budget[key] -= 1
            in_summary += 1
            continue
        d = drop.setdefault(k, [0, 0])
        d[0] += 1
        d[1] += len(m["content"])
    kept_tools = sum(1 for m in sent if m.get("role") == "tool")
    return {"dropped": drop, "short_results_in_summary": in_summary, "kept_tool_results": kept_tools,
            "sent_messages": len(sent), "orig_messages": len(orig),
            "summary_chars": len(summary)}


def fmt_drop(d):
    return ", ".join(f"{v[0]} {k} ({v[1] // 1000}k ch)" for k, v in sorted(d.items())) or "-"


def report(run):
    rows, planted, b2b, mock = analyze(run)
    comps = [r for r in rows if r.get("compaction_no")]
    lines = []
    args = open(os.path.join(run, "proxy.args")).read() if os.path.exists(os.path.join(run, "proxy.args")) else "(direct)"
    sent_total = sum(m["prompt_tokens"] for m in mock)
    ok_total = sum(m["prompt_tokens"] for m in mock if m["status"] == 200)
    compl = sum(m.get("completion_tokens", 0) for m in mock)
    orig_total = sum(r["orig_qwen"] for r in rows)
    lines.append(f"### Run `{os.path.basename(run)}` — proxy args: `{args}`\n")
    lines.append(f"- steps completed: {sum(1 for r in rows if r['client_status'] == 200)}/{len(rows)}; "
                 f"client-visible errors: {sum(1 for r in rows if r['client_status'] != 200)}")
    lines.append(f"- upstream requests: {len(mock)}; length rejections upstream: "
                 f"{sum(1 for m in mock if m.get('rejected_for_length'))}; pairing errors: "
                 f"{sum(1 for m in mock if m.get('pairing_error'))}")
    lines.append(f"- prompt tokens processed (Qwen count, all upstream attempts): {sent_total:,} "
                 f"(accepted: {ok_total:,}); completion: {compl:,}; "
                 f"what the agent would have sent without compaction: {orig_total:,}")
    lines.append(f"- compactions: {len(comps)}; back-to-back (consecutive steps): {b2b}; "
                 f"peak accepted prompt: {max((m['prompt_tokens'] for m in mock if m['status'] == 200), default=0):,}")
    ratios = [r["ratio"] for r in rows if r.get("ratio")]
    if ratios:
        lines.append(f"- calibration ratio applied: first {ratios[0] / 1000:.2f}, last {ratios[-1] / 1000:.2f}")
    lines.append("")
    facts = list(scenario.FACTS)
    lines.append("| # | step | before (Qwen / est) | after (Qwen / est) | msgs | rung | dropped tool results | short results kept in summary | summary chars | carry chars | pairs valid | " +
                 " | ".join(SHORT[f] for f in facts) + " |")
    lines.append("|" + "---|" * (11 + len(facts)))
    for r in comps:
        cells = []
        for f in facts:
            if f not in planted or r["step"] < planted[f]:
                cells.append("·")
            else:
                cells.append("✓" if r["facts"].get(f) else "✗")
        lines.append(
            f"| {r['compaction_no']} | {r['step']} | {r['orig_qwen']:,} / {r['orig_est']:,} | "
            f"{(r['sent_qwen'] or 0):,} / {(r['est_out'] or 0):,} | {r.get('orig_messages')}→{r.get('sent_messages')} | "
            f"{r['rung']}{' R' * r['length_rejections']} | {fmt_drop(r.get('dropped', {}))} | {r.get('short_results_in_summary', '-')} | "
            f"{r.get('summary_chars', '-'):,} | {r['carry_chars']} | {'yes' if not r['pairing_errors'] else 'NO'} | "
            + " | ".join(cells) + " |")
    lines.append("")
    # survival: present in every accepted request after planting?
    lines.append("| fact | channel | planted before step | present in every later request | first step missing |")
    lines.append("|---|---|---|---|---|")
    for f in facts:
        if f not in planted:
            lines.append(f"| {SHORT[f]} | {scenario.FACTS[f][1]} | never planted | - | - |")
            continue
        miss = [r["step"] for r in rows if r["step"] >= planted[f] and r["sent_qwen"] is not None
                and not r["facts"].get(f)]
        lines.append(f"| {SHORT[f]} | {scenario.FACTS[f][1]} | {planted[f]} | {'yes' if not miss else 'no'} | "
                     f"{miss[0] if miss else '-'} |")
    return "\n".join(lines), {"compactions": len(comps), "b2b": b2b, "sent_total": sent_total,
                              "rejections": sum(1 for m in mock if m.get("rejected_for_length")),
                              "client_errors": sum(1 for r in rows if r["client_status"] != 200),
                              "steps_ok": sum(1 for r in rows if r["client_status"] == 200),
                              "survival": {SHORT[f]: (f in planted and not [r for r in rows if r["step"] >= planted[f] and r["sent_qwen"] is not None and not r["facts"].get(f)]) for f in facts},
                              "peak": max((m['prompt_tokens'] for m in mock if m['status'] == 200), default=0)}


if __name__ == "__main__":
    text, summ = report(sys.argv[1])
    print(text)
    print(json.dumps(summ))
