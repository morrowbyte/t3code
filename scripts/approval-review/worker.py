"""Single bounded approval executor. Requires separately provisioned execute token."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "create-file-once-v1"
TEMPLATE = Path(__file__).with_name("create_file_once.py")


class Api:
    def __init__(self, config):
        self.url = config["authorityUrl"].rstrip("/")
        parsed = urllib.parse.urlsplit(self.url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
            raise ValueError("invalid_authority_url")
        if parsed.scheme != "https":
            address = ipaddress.ip_address(parsed.hostname)
            if parsed.scheme != "http" or not config.get("allowPrivateHttp") or not (address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")):
                raise ValueError("tls_required")
        self.token_file = Path(config["tokenFile"])
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def post(self, operation, payload):
        token = self.token_file.read_text(encoding="utf-8").strip()
        request = urllib.request.Request(self.url + "/api/approval-review/" + operation,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
        try:
            with self.opener.open(request, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # No response bodies or auth headers in logs.
            raise RuntimeError("authority_http_" + str(error.code)) from None


def validate(authority, item, config, source):
    action = authority["action"]
    expected = config["target"]
    if authority["state"] != "claimed" or authority["claimId"] != item["claimId"]:
        raise ValueError("invalid_claim")
    if authority["packageHash"] != item["packageHash"] or authority["verifiedTargetId"] != item["verifiedTargetId"]:
        raise ValueError("package_mismatch")
    if authority["expiresAt"] <= int(time.time() * 1000):
        raise ValueError("expired")
    if authority["workerSubject"] != config["workerSubject"] or authority["requesterSubject"] != config["requesterSubject"]:
        raise ValueError("subject_mismatch")
    if action["verifiedTargetId"] != expected["verifiedTargetId"] or action["path"] != expected["allowedPath"]:
        raise ValueError("target_mismatch")
    if action["kind"] != "create_file_once" or action["expectedAbsent"] is not True or action["mode"] not in (384, 420):
        raise ValueError("invalid_action")
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    if action["implementationVersion"] != VERSION or action["implementationHash"] != digest or expected["implementationHash"] != digest or authority["implementationSource"] != source:
        raise ValueError("implementation_mismatch")
    if len(action["content"].encode("utf-8", errors="strict")) > 65536:
        raise ValueError("content_too_large")
    return action


def ssh_run(config, source, action, operation):
    ssh = config["ssh"]
    # Every SSH argument and target comes from local operator configuration.
    args = [ssh["executable"], "-F", ssh["configFile"], "-T", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10",
        "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
        "-i", ssh["identityFile"], "-o", "UserKnownHostsFile=" + ssh["knownHostsFile"],
        ssh["host"], "python3 -c " + shlex.quote(source)]
    payload = {key: action[key] for key in ("path", "content", "mode", "expectedAbsent")}
    payload["operation"] = operation
    result = subprocess.run(args, input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError("ssh_exit_" + str(result.returncode))
    report = json.loads(result.stdout)
    digest = hashlib.sha256(action["content"].encode("utf-8")).hexdigest()
    if report != {"outcome": "reported_succeeded", "contentHash": digest}:
        raise ValueError("readback_mismatch")
    return report


class Worker:
    def __init__(self, config, api=None, executor=ssh_run):
        self.config, self.api, self.executor = config, api or Api(config), executor
        self.source = TEMPLATE.read_text(encoding="utf-8")
        self.db = sqlite3.connect(config["ledgerFile"], timeout=5)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS claims (thread TEXT, request TEXT, item TEXT NOT NULL, receipt TEXT, reported INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread, request))")
        self.db.commit()

    def report(self, item, receipt):
        self.db.execute("UPDATE claims SET receipt=? WHERE thread=? AND request=?", (json.dumps(receipt), item["threadId"], item["requestId"]))
        self.db.commit()
        result = self.api.post("receipt", {**item, "receipt": receipt})
        if result["authority"]["receipt"] != receipt:
            raise ValueError("receipt_mismatch")
        self.db.execute("UPDATE claims SET reported=1 WHERE thread=? AND request=?", (item["threadId"], item["requestId"]))
        self.db.commit()

    def recover(self):
        # Never rerun a claim after a crash, including an ambiguous claim response.
        for raw_item, raw_receipt in self.db.execute("SELECT item, receipt FROM claims WHERE reported=0").fetchall():
            item = json.loads(raw_item)
            authority = self.api.post("read", {key: item[key] for key in ("threadId", "requestId")})["authority"]
            if authority.get("claimId") != item["claimId"]:
                self.db.execute("UPDATE claims SET reported=-1 WHERE thread=? AND request=?", (item["threadId"], item["requestId"]))
                self.db.commit()
                continue
            receipt = json.loads(raw_receipt) if raw_receipt else {"outcome": "unknown", "errorCode": "worker_interrupted"}
            self.report(item, receipt)

    def handle(self, queued):
        if self.config.get("executionEnabled") is not True:
            return "execution_disabled"
        if queued["verifiedTargetId"] != self.config["target"]["verifiedTargetId"]:
            raise ValueError("target_mismatch")
        item = {key: queued[key] for key in ("threadId", "requestId", "packageHash", "verifiedTargetId")}
        item["claimId"] = "worker:" + str(uuid.uuid4())
        try:
            self.db.execute("INSERT INTO claims(thread,request,item) VALUES(?,?,?)", (item["threadId"], item["requestId"], json.dumps(item)))
            self.db.commit()
        except sqlite3.IntegrityError:
            return "already_seen"
        # Commit the attempt before network I/O. An uncertain outcome is never retried.
        claimed = self.api.post("claim", item)
        try:
            action = validate(claimed["authority"], item, self.config, self.source)
        except (ValueError, KeyError):
            self.report(item, {"outcome": "reported_failed", "errorCode": "worker_policy_rejected"})
            return "rejected"
        try:
            self.executor(self.config, self.source, action, "create")
            receipt = self.executor(self.config, self.source, action, "read")
            receipt["readback"] = {"path": action["path"], "contentHash": receipt["contentHash"],
                "mode": action["mode"], "targetIdentity": action["verifiedTargetId"]}
        except Exception:
            receipt = {"outcome": "unknown", "errorCode": "execution_uncertain"}
        self.report(item, receipt)
        return receipt["outcome"]

    def once(self):
        self.recover()
        items = self.api.post("ready", {})["requests"]
        if len(items) > 10:
            raise ValueError("queue_limit")
        return [self.handle(item) for item in items]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    # One process owns recovery; another instance must not report unknown mid-execution.
    lock = open(config["ledgerFile"] + ".lock", "a+b")
    lock.seek(0)
    if os.name == "nt":
        import msvcrt
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    worker = Worker(config)
    try:
        while not Path(config["stopFile"]).exists():
            started = time.monotonic()
            try:
                outcomes = worker.once()
                print(json.dumps({"event": "poll", "outcomes": outcomes, "elapsedMs": round((time.monotonic()-started)*1000)}), flush=True)
            except Exception as error:
                print(json.dumps({"event": "error", "code": type(error).__name__}), flush=True)
                if args.once:
                    return 1
            if args.once:
                break
            time.sleep(2)
    finally:
        worker.db.close()
        lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
