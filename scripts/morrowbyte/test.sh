#!/usr/bin/env bash
set -euo pipefail
python3 scripts/morrowbyte/release62-recovery.test.py

bash -n scripts/morrowbyte/*.sh
python3 - <<'PY'
from pathlib import Path
import re
import subprocess

source = Path("scripts/morrowbyte/check.sh").read_text()
paths = set(re.findall(r"\b(?:apps|packages|scripts|packaging)/[\w./-]+\.test\.(?:tsx|ts|cjs|py|sh)\b", source))
optional = set(re.findall(r'^\w+=([^\s]+)\nif \[\[ -f "\$\w+" \]\]; then', source, re.MULTILINE))
tracked = set(subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0"))
missing = sorted(path for path in paths - optional if path not in tracked or not Path(path).is_file())
if missing:
    raise SystemExit("Required source qualification tests are missing or untracked:\n" + "\n".join(missing))
print(f"Source qualification test paths: {len(paths - optional)} required paths resolved.")
PY
bash scripts/morrowbyte/sync-upstream-nightly.test.sh
bash scripts/morrowbyte/verify-desktop-source.test.sh
actual="$(bash scripts/morrowbyte/resolve-version.sh 0.0.46 20261013 1)"
if [[ "$actual" != "version=0.0.47-nightly.20261013.1" ]]; then
  echo "Unexpected fork version: $actual" >&2
  exit 1
fi

if bash scripts/morrowbyte/resolve-version.sh invalid 20261013 1 >/dev/null 2>&1; then
  echo "Invalid base versions must be rejected." >&2
  exit 1
fi

run_date="$(bash scripts/morrowbyte/resolve-run-date.sh 2026-10-13T23:59:58Z)"
if [[ "$run_date" != "20261013" ]]; then
  echo "Release date must come from the immutable workflow run creation time." >&2
  exit 1
fi

bash scripts/morrowbyte/verify-published-release.test.sh
bash scripts/morrowbyte/read-draft-release-assets.test.sh
bash scripts/morrowbyte/verify-nixos-closure.test.sh
