"""Synthetic segment-level replay; never reads real session contents or secrets."""
PAGE_REF = "C:/synthetic-home/.claude/fast-jev-pages/synthetic/t1.call.txt"
PAGE = "command: npm test\n" + "synthetic old stdout " * 300
SKILL = "skill_listing: synthetic listing"
RULES = "instructions: synthetic rules"


def replay_fixture():
    def event(turn, role, segment, kind, text, tool_id=""):
        return dict(turn=turn, role=role, segment=segment, kind=kind,
                    text=text, tool_id=tool_id)

    original = [
        event("T1", "user", "u1", "text", "Fix synthetic code."),
        event("T1", "assistant", "call:t1", "tool_use", "npm test", "t1"),
        event("T1", "tool", "result:t1", "tool_result", PAGE_REF, "t1"),
        event("T1", "assistant", "skill:1", "text", SKILL),
        event("T1", "assistant", "rules:1", "text", RULES),
        event("T2", "user", "u2", "text", "Continue with result."),
        event("T2", "assistant", "skill:2", "text", SKILL),
        event("T2", "assistant", "rules:2", "text", RULES),
    ]
    duplicates = [dict(item, replay_handle="new-handle")
                  for item in original[1:5]]
    return original[:5] + duplicates + original[5:], {PAGE_REF: PAGE}


def evaluate(items, pages):
    def count(turn, text):
        return sum(x["turn"] == turn and x["text"] == text for x in items)
    checks = [
        ("original turn has one copy of each assistant segment",
         all(count("T1", t) == 1 for t in (SKILL, RULES))),
        ("genuine repeated text in next turn survives",
         all(count("T2", t) == 1 for t in (SKILL, RULES))),
        ("user-authored messages preserved",
         [x["text"] for x in items if x["role"] == "user"]
         == ["Fix synthetic code.", "Continue with result."]),
        ("tool pair one-to-one and original immutable page intact",
         [x["tool_id"] for x in items if x["kind"] == "tool_use"] == ["t1"]
         and [x["tool_id"] for x in items if x["kind"] == "tool_result"] == ["t1"]
         and count("T1", PAGE_REF) == 1
         and pages == {PAGE_REF: PAGE}),
    ]
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'} S2 {name}")
    print(f"RESULT {sum(ok for _, ok in checks)}/{len(checks)}")
    return 0 if all(ok for _, ok in checks) else 1
