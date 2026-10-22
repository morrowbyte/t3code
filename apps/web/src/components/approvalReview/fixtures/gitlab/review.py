#!/usr/bin/env python3
"""Generate a read-only review from the same source and inputs as execution."""

import ast
import dataclasses
import difflib
import hashlib
import inspect
import json
from pathlib import Path

import upgrade


def make_review() -> dict:
    folder = Path(__file__).resolve().parent
    change = upgrade.load_change(folder / "change.example.json")
    source = (folder / "upgrade.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    process = next(node for node in tree.body
                   if isinstance(node, ast.FunctionDef) and node.name == "upgrade_gitlab")
    steps = []
    for statement in process.body:
        if not (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)):
            continue
        function = getattr(upgrade, statement.value.func.id)
        lines, first_line = inspect.getsourcelines(function)
        steps.append({
            "function": function.__name__,
            "description": inspect.getdoc(function),
            "file": "upgrade.py", "line": first_line,
            "source": "".join(lines),
        })
    package_files = ["upgrade.py", "review.py", "change.example.json",
                     "request.example.json", "gitlab.before.container", "NOTES.txt"]
    return {
        "status": "illustrative_not_submitted_not_approved",
        "inputs": dataclasses.asdict(change),
        "transport": json.loads((folder / "request.example.json").read_text(encoding="utf-8")),
        "steps": steps,
        "quadlet_diff": "".join(difflib.unified_diff(
            upgrade.reviewed_quadlet().decode().splitlines(keepends=True),
            upgrade.updated_quadlet(change).decode().splitlines(keepends=True),
            fromfile="gitlab.container (before)", tofile="gitlab.container (after)",
        )),
        "source_files": [
            {"path": name, "sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest()}
            for name in package_files
        ],
        "limits": [
            "Example versions and placeholders; not a current security recommendation.",
            "Root on the Linux target; effects are not sandboxed to the named files.",
            "Single node, local PostgreSQL/Redis/Gitaly, default local backup path.",
            "No Geo, external storage, container registry, custom hooks or cluster orchestration.",
            "Maintenance window, drained existing work, no concurrent administrative changes.",
            "Backup structure and SHA-256 checked; no restore exercise performed.",
            "No automatic retry, rollback, repair or post-timeout resubmission.",
            "No real proxy, SSH transport, approval validation or mobile UI implemented here.",
        ],
        "sources": [
            "https://docs.gitlab.com/update/docker/",
            "https://docs.gitlab.com/install/docker/backup/",
            "https://docs.gitlab.com/update/background_migrations/",
            "https://docs.gitlab.com/administration/monitoring/health_check/",
            "https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(make_review(), indent=2, ensure_ascii=False))
