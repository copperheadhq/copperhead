"""Restore a hash-checked final source view into a new independent directory."""
from pathlib import Path
import hashlib
import json
import sys

source = Path(__file__).resolve().parent
target = Path(sys.argv[1]).resolve()
if target.exists():
    raise SystemExit("Destination already exists; use a new directory")
rows = json.loads((source / "snapshot-files.json").read_text())
for row in rows:
    for key in ["published", "restoreAs"]:
        value = Path(row[key])
        if value.is_absolute() or ".." in value.parts:
            raise SystemExit("Unsafe inventory path")
    raw = (source / row["published"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != row["sha256"]:
        raise SystemExit("Source hash mismatch: " + row["published"])
target.mkdir(parents=True)
for row in rows:
    dst = target / row["restoreAs"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes((source / row["published"]).read_bytes())
print("Restored " + str(len(rows)) + " source files; historical Git is not included")
