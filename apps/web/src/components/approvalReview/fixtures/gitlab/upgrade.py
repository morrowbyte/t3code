#!/usr/bin/env python3
"""Readable example: one approved, rootful, single-node GitLab patch upgrade.

No SSH client or private key is part of this program. A separate proxy would
verify approval and run the frozen package on the already authenticated target.
The shipped example settings intentionally refuse execution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class Change:
    request_id: str
    example_only: bool
    machine_id: str
    current_version: str
    target_version: str
    target_image: str
    expected_systemd_unit_sha256: str
    expected_mounts: dict[str, str]
    database_names: list[str]
    readiness_url: str
    quadlet: str = "/etc/containers/systemd/gitlab.container"
    service: str = "gitlab.service"
    container: str = "gitlab"
    backup_root: str = "/var/backups/gitlab-approved-upgrades"

    @property
    def backup_directory(self) -> Path:
        return Path(self.backup_root) / self.request_id


def upgrade_gitlab(change: Change) -> None:
    """The complete process, in execution order. Open any function for details."""
    check_expected_installation(change)
    download_target_image(change)
    stop_gitlab_and_start_only_backup_dependencies(change)
    create_and_check_backups(change)
    install_reviewed_quadlet(change)
    recreate_gitlab_container(change)
    wait_until_gitlab_is_ready(change)
    check_running_image_and_version(change)
    wait_until_background_migrations_finish(change)
    write_success_receipt(change)


# Everything called above is implemented below, using Python's standard library.

PACKAGE = Path(__file__).resolve().parent


def load_change(path: Path) -> Change:
    return Change(**json.loads(path.read_text(encoding="utf-8")))


def reviewed_quadlet() -> bytes:
    return (PACKAGE / "gitlab.before.container").read_bytes()


def updated_quadlet(change: Change) -> bytes:
    before = reviewed_quadlet().decode("utf-8")
    after, replacements = re.subn(
        r"(?m)^Image=[^\r\n]+$", f"Image={change.target_image}", before
    )
    if replacements != 1:
        raise ValueError("Expected exactly one Image= line in the reviewed Quadlet")
    return after.encode("utf-8")


def validate_change(change: Change) -> None:
    if change.example_only:
        raise ValueError("Example only: supply verified inventory and a real approved plan")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", change.request_id):
        raise ValueError("Invalid request ID")
    if not re.fullmatch(r"[0-9a-f]{32}", change.machine_id):
        raise ValueError("A verified target machine ID is required")
    if not re.fullmatch(r"[0-9a-f]{64}", change.expected_systemd_unit_sha256):
        raise ValueError("A verified systemd unit SHA-256 is required")
    versions = []
    for version in (change.current_version, change.target_version):
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("Only stable, explicitly specified patch versions are supported")
        versions.append(tuple(map(int, version.split("."))))
    old, new = versions
    if old[:2] != new[:2] or new[2] != old[2] + 1:
        raise ValueError("This example supports exactly the next patch, same major/minor")
    image_pattern = (
        r"docker\.io/gitlab/gitlab-(ee|ce):"
        + re.escape(change.target_version)
        + r"-\1\.0@sha256:[0-9a-f]{64}"
    )
    if not re.fullmatch(image_pattern, change.target_image):
        raise ValueError("Pin the official target version and its verified image digest")
    before = reviewed_quadlet().decode("utf-8")
    target_edition = re.search(r"gitlab-(ee|ce):", change.target_image).group(1)
    if f"gitlab-{target_edition}:{change.current_version}-{target_edition}.0" not in before:
        raise ValueError("Reviewed Quadlet must match the current version and edition")
    if change.quadlet != "/etc/containers/systemd/gitlab.container":
        raise ValueError("This example is written for the named system-wide Quadlet")
    if change.service != "gitlab.service" or change.container != "gitlab":
        raise ValueError("This example is written for gitlab.service and container gitlab")
    if change.backup_root != "/var/backups/gitlab-approved-upgrades":
        raise ValueError("Unexpected backup location")
    if set(change.expected_mounts) != {"/etc/gitlab", "/var/log/gitlab", "/var/opt/gitlab"}:
        raise ValueError("Supply all three persistent GitLab bind mounts")
    if not change.database_names or not all(
        re.fullmatch(r"[a-zA-Z0-9_]+", name) for name in change.database_names
    ):
        raise ValueError("Supply all local GitLab database names")
    health = urllib.parse.urlsplit(change.readiness_url)
    if (health.scheme != "http" or health.hostname != "127.0.0.1"
            or health.path != "/-/readiness" or health.query != "all=1"):
        raise ValueError("This example checks a loopback-published readiness endpoint")
    updated_quadlet(change)


def event(change: Change, kind: str, **details) -> None:
    record = {"time": datetime.now(timezone.utc).isoformat(), "kind": kind, **details}
    with (change.backup_directory / "events.jsonl").open("a", encoding="utf-8") as output:
        output.write(json.dumps(record) + "\n")
        output.flush()
        os.fsync(output.fileno())


def command(change: Change, *argv: str, timeout: int = 300,
            read_output: bool = False) -> str:
    """Keep complete stdout/stderr on the target; read small answers only on request."""
    command_id = str(time.time_ns())
    stdout_path = change.backup_directory / f"{command_id}.stdout"
    stderr_path = change.backup_directory / f"{command_id}.stderr"
    event(change, "command_started", argv=argv, stdout=stdout_path.name, stderr=stderr_path.name)
    try:
        with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
            result = subprocess.run(
                argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                check=False, timeout=timeout, shell=False,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
            )
    except subprocess.TimeoutExpired:
        event(change, "command_timed_out", argv=argv,
              outcome="Container-side work may still be running; do not retry automatically")
        raise
    event(change, "command_finished", argv=argv, exit_code=result.returncode)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}); inspect {stderr_path.name}")
    if not read_output:
        return ""
    if stdout_path.stat().st_size > 65_536:
        raise RuntimeError(f"Unexpectedly large answer; original retained in {stdout_path.name}")
    return stdout_path.read_text(encoding="utf-8").strip()


def in_container(change: Change, *argv: str, **options) -> str:
    return command(change, "podman", "exec", change.container, *argv, **options)


def installed_version(change: Change) -> str:
    answer = in_container(
        change, "gitlab-rails", "runner", "puts Gitlab::VERSION", read_output=True
    ).splitlines()[-1]
    return answer.removesuffix("-ee").removesuffix("-ce")


def pending_migrations(change: Change) -> int:
    sql = "SELECT count(*) FROM batched_background_migrations WHERE status NOT IN (3, 6);"
    return sum(int(in_container(
        change, "gitlab-psql", "-d", database, "-A", "-t", "-c", sql, read_output=True
    )) for database in change.database_names)


def check_expected_installation(change: Change) -> None:
    """Check machine, service, Quadlet, persistent mounts, version and migrations."""
    if Path("/etc/machine-id").read_text().strip() != change.machine_id:
        raise RuntimeError("Wrong target machine")
    quadlet = Path(change.quadlet)
    if quadlet.is_symlink() or not quadlet.is_file() or quadlet.read_bytes() != reviewed_quadlet():
        raise RuntimeError("Quadlet differs from the reviewed snapshot")
    unit = command(change, "systemctl", "cat", change.service, read_output=True)
    # systemctl output is normalized here in exactly the same way as inventory must be.
    if hashlib.sha256(unit.encode()).hexdigest() != change.expected_systemd_unit_sha256:
        raise RuntimeError("Effective systemd unit differs from the reviewed inventory")
    command(change, "systemctl", "is-active", "--quiet", change.service)
    details = json.loads(command(
        change, "podman", "inspect", change.container, read_output=True
    ))[0]
    mounts = {item["Destination"]: item["Source"] for item in details["Mounts"]}
    if any(mounts.get(dest) != source for dest, source in change.expected_mounts.items()):
        raise RuntimeError("Persistent data mounts differ from the reviewed inventory")
    if installed_version(change) != change.current_version:
        raise RuntimeError("Current GitLab version differs from the approved plan")
    if pending_migrations(change) != 0:
        raise RuntimeError("Finish existing background migrations before upgrading")
    event(change, "preconditions_passed")


def download_target_image(change: Change) -> None:
    """Pull the pinned image before starting the downtime."""
    command(change, "podman", "pull", change.target_image, timeout=1200)
    command(change, "podman", "image", "inspect", change.target_image)


def stop_gitlab_and_start_only_backup_dependencies(change: Change) -> None:
    """Downtime starts: stop GitLab's supervised services; enable local backup dependencies."""
    in_container(change, "gitlab-ctl", "stop", timeout=600)
    for service in ("postgresql", "redis", "gitaly"):
        in_container(change, "gitlab-ctl", "start", service)
    event(change, "downtime_started")


def backup_names(change: Change) -> set[str]:
    output = in_container(
        change, "find", "/var/opt/gitlab/backups", "-maxdepth", "1", "-type", "f",
        "-name", "*_gitlab_backup.tar", "-printf", "%f\n", read_output=True,
    )
    return set(output.splitlines())


def sha256_file(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def create_and_check_backups(change: Change) -> None:
    """Back up local application data, configuration/secrets and the original Quadlet."""
    previous = backup_names(change)
    in_container(change, "gitlab-backup", "create", timeout=3600)
    created = backup_names(change) - previous
    if len(created) != 1:
        raise RuntimeError("Cannot unambiguously identify the newly created backup")
    name = created.pop()
    archive = change.backup_directory / name
    command(change, "podman", "cp", f"{change.container}:/var/opt/gitlab/backups/{name}",
            str(archive), timeout=1800)
    command(change, "podman", "cp", f"{change.container}:/etc/gitlab",
            str(change.backup_directory / "etc-gitlab"))
    shutil.copy2(change.quadlet, change.backup_directory / "gitlab.original.container")
    if not (change.backup_directory / "etc-gitlab/gitlab-secrets.json").is_file():
        raise RuntimeError("Secrets file missing from configuration backup")
    if not (change.backup_directory / "etc-gitlab/gitlab.rb").is_file():
        raise RuntimeError("gitlab.rb missing from configuration backup")
    with tarfile.open(archive) as backup:
        names = {member.name.removeprefix("./") for member in backup}
    if "backup_information.yml" not in names or not any(n.startswith("db/") for n in names):
        raise RuntimeError("Backup archive lacks expected metadata/database entries")
    event(change, "backups_created", archive=name, sha256=sha256_file(archive),
          restore_tested=False)


def install_reviewed_quadlet(change: Change) -> None:
    """Replace only the Image= line; stop if the reviewed file changed meanwhile."""
    path = Path(change.quadlet)
    if path.read_bytes() != reviewed_quadlet():
        raise RuntimeError("Quadlet changed during the upgrade; new review required")
    old_stat = path.stat()
    fd, name = tempfile.mkstemp(prefix=".gitlab-approved-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(updated_quadlet(change))
            output.flush()
            os.fsync(output.fileno())
        shutil.copystat(path, temporary)
        os.chown(temporary, old_stat.st_uid, old_stat.st_gid)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)
    event(change, "quadlet_replaced", sha256=sha256_file(path))


def recreate_gitlab_container(change: Change) -> None:
    """Regenerate the systemd service from the Quadlet and restart it."""
    command(change, "systemctl", "daemon-reload")
    command(change, "systemctl", "restart", change.service, timeout=1500)


def wait_until_gitlab_is_ready(change: Change) -> None:
    """Check Rails and its dependencies through the loopback-published HTTP endpoint."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 900
    last_problem = "No response yet"
    while time.monotonic() < deadline:
        try:
            with opener.open(change.readiness_url, timeout=10) as response:
                body = response.read(65_537)
                if len(body) > 65_536:
                    raise RuntimeError("Unexpectedly large readiness response")
                data = json.loads(body)
                checks = [check for values in data.values() for check in values]
                if checks and all(check.get("status") == "ok" for check in checks):
                    event(change, "readiness_passed", checks=data)
                    return
                last_problem = "A readiness dependency has not passed"
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            last_problem = str(error)
        time.sleep(10)
    raise RuntimeError(f"Readiness timed out: {last_problem}")


def check_running_image_and_version(change: Change) -> None:
    """Check the actual container image ID and the version reported by GitLab."""
    expected = json.loads(command(
        change, "podman", "image", "inspect", change.target_image, read_output=True
    ))[0]["Id"]
    actual = json.loads(command(
        change, "podman", "inspect", change.container, read_output=True
    ))[0]["Image"]
    if actual.removeprefix("sha256:") != expected.removeprefix("sha256:"):
        raise RuntimeError("The container is not running the approved image")
    if installed_version(change) != change.target_version:
        raise RuntimeError("GitLab does not report the approved target version")
    event(change, "target_image_and_version_passed", image_id=actual,
          version=change.target_version)


def wait_until_background_migrations_finish(change: Change) -> None:
    """Wait for each explicitly inventoried local database; never start repairs."""
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        if pending_migrations(change) == 0:
            event(change, "background_migrations_complete")
            return
        time.sleep(30)
    raise RuntimeError("Background migrations did not finish within the approved wait")


def write_success_receipt(change: Change) -> None:
    receipt = {
        "request_id": change.request_id, "status": "completed",
        "machine_id": change.machine_id, "version": change.target_version,
        "image": change.target_image, "backup_directory": str(change.backup_directory),
        "acceptance": "Image, GitLab version, readiness and migration counts checked",
        "restore_tested": False,
    }
    (change.backup_directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Execute on the approved Linux target")
    parser.add_argument("--plan", type=Path, default=PACKAGE / "change.example.json")
    args = parser.parse_args()
    if not args.apply:
        parser.error("Nothing executed. Use review.py for the read-only review")
    change = load_change(args.plan)
    validate_change(change)  # Reject example values before any target writes.
    if os.geteuid() != 0:
        raise PermissionError("This rootful Quadlet example requires root on the target")
    import fcntl
    os.umask(0o077)
    # This serializes this example's own runs; it does not lock out other administrators.
    with Path("/run/gitlab-approved-upgrade.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        change.backup_directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        try:
            upgrade_gitlab(change)
        except Exception as error:
            event(change, "upgrade_stopped", error=str(error), automatic_rollback=False)
            print(json.dumps({"status": "stopped", "error": str(error),
                              "evidence": str(change.backup_directory),
                              "warning": "GitLab may be offline or partially upgraded; no automatic retry"}),
                  file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
