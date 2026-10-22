"""Trusted operator side only. Bind an existing browser identity; never approve a request."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile


def atomic(path, data):
    fd, name = tempfile.mkstemp(prefix=".approval-policy-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(Path.home()/".local/state/t3-approval-review-20261022/operator.json"))
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--subject", required=True)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    app = Path(config["appRoot"])
    result = subprocess.run([config["node"], str(app/"apps/server/src/bin.ts"), "auth", "session", "list", "--base-dir", config["home"], "--json"],
        cwd=app, capture_output=True, check=True)
    sessions = json.loads(result.stdout)
    matches = [session for session in sessions if session["sessionId"] == args.session_id and session["subject"] == args.subject]
    if len(matches) != 1:
        raise ValueError("browser_session_missing_or_ambiguous")
    session = matches[0]
    if session["method"] != "browser-session-cookie" or "orchestration:operate" not in session["scopes"]:
        raise ValueError("not_an_active_browser_approver")
    if datetime.fromisoformat(session["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        raise ValueError("browser_session_expired")
    policy = Path(config["policyFile"])
    env_file = Path(config["environmentFile"])
    # Only active local auth metadata authenticates the selection. No client label heuristic.
    with open(str(policy)+".lock", "a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        previous = policy.read_bytes()
        targets = json.loads(previous)
        selected = [target for target in targets if target["verifiedTargetId"] == config["verifiedTargetId"]]
        if len(selected) == 0 and config.get("targetTemplateFile"):
            template = json.loads(Path(config["targetTemplateFile"]).read_text())
            if template["verifiedTargetId"] != config["verifiedTargetId"]:
                raise ValueError("target_template_mismatch")
            targets.append(template)
            selected = [template]
        if len(selected) != 1:
            raise ValueError("target_policy_missing_or_ambiguous")
        target = selected[0]
        target["approverSessionId"], target["approverSubject"] = args.session_id, args.subject
        encoded = json.dumps(targets, ensure_ascii=False, separators=(",", ":"))
        if not args.activate:
            print(json.dumps({"validated": True, "sessionId": args.session_id, "subject": args.subject,
                "verifiedTargetId": config["verifiedTargetId"], "activation": "not_requested"}))
            return
        configured = subprocess.run(["systemctl", "--user", "show", config["unit"], "--property=EnvironmentFiles", "--value"], capture_output=True, check=True, text=True).stdout
        if str(env_file) not in configured:
            raise ValueError("unit_must_already_reference_owned_environment_file")
        old_env = env_file.read_bytes() if env_file.exists() else None
        backup = policy.with_name(policy.name+".before-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        atomic(backup, previous)
        atomic(policy, (encoded+"\n").encode())
        # systemd EnvironmentFile quoting; no token or pairing credential is written here.
        atomic(env_file, ("T3CODE_APPROVAL_REVIEW_TARGETS="+json.dumps(encoded, ensure_ascii=False)+"\n").encode())
        try:
            subprocess.run(["systemctl", "--user", "restart", config["unit"]], check=True, capture_output=True)
            subprocess.run(["systemctl", "--user", "is-active", "--quiet", config["unit"]], check=True)
        except Exception:
            atomic(policy, previous)
            if old_env is None:
                env_file.unlink(missing_ok=True)
            else:
                atomic(env_file, old_env)
            subprocess.run(["systemctl", "--user", "restart", config["unit"]], capture_output=True)
            raise
        print(json.dumps({"bound": True, "sessionId": args.session_id, "subject": args.subject,
            "verifiedTargetId": config["verifiedTargetId"], "oldPackages": "invalid_under_changed_session_policy",
            "approvalIssued": False, "backup": str(backup)}))


if __name__ == "__main__":
    main()
