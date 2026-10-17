# Offline approach spikes

Same hand-authored, segment-level replay fixture in `fixture.py` for both.
From project root:

- `py -3 spikes/inplace-hook/spike.py`: expected rc=0 and 4/4 checks.
- `py -3 spikes/shadow-store/spike.py`: expected rc=1 and 3/4 checks.

The B failure shows a global SHA hash incorrectly deletes a legitimate repeated
assistant segment in a subsequent user turn. This does not disprove a more
complex sidecar with turn provenance. A presumes segment provenance **before**
the hook merges assistant text and cannot repair an already-merged opaque
string safely. The page and messages are synthetic; no network or user data.

Actual TypeScript hook baseline and its known failures: `py -3 intent/scenarios.py`.
Neither spike alone proves a production change.
