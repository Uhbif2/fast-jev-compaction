"""B: intentionally unsafe global content SHA shadow-ledger baseline.

Its expected rc=1 rejects this naive design, not all shadow ledgers.
"""
import hashlib
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixture import evaluate, replay_fixture


def compact(records):
    seen = set()
    kept = []
    for record in records:
        if record["role"] == "user":
            kept.append(record)
            continue
        key = hashlib.sha256("\0".join(
            (record["role"], record["kind"], record["text"],
             record["tool_id"])).encode("utf-8")).hexdigest()
        if key not in seen:
            seen.add(key)
            kept.append(record)
    return kept


if __name__ == "__main__":
    source, pages = replay_fixture()
    sys.exit(evaluate(compact(source), pages))
