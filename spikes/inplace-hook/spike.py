"""A: per-turn/provenance replay normalization before assistant text joining.

The prototype assumes reliable per-segment provenance, not currently proved
to be exposed by the Desktop engine in all cases.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixture import evaluate, replay_fixture


def compact(records):
    seen = set()
    kept = []
    for record in records:
        if record["role"] == "user":
            kept.append(record)  # User-authored text is never deduplicated.
            continue
        key = (record["turn"], record["role"], record["segment"],
               record["kind"], record["tool_id"])
        if key not in seen:
            seen.add(key)
            kept.append(record)
    return kept


if __name__ == "__main__":
    source, pages = replay_fixture()
    sys.exit(evaluate(compact(source), pages))
