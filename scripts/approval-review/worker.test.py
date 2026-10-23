import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import create_file_once
import worker


class FakeApi:
    def __init__(self, authority):
        self.authority = authority
        self.calls = []
        self.lose_claim = False
        self.lose_receipt = False

    def post(self, operation, payload):
        self.calls.append(operation)
        if operation == "ready":
            return {"requests": []}
        if operation == "claim":
            if self.authority["state"] != "approved":
                raise RuntimeError("not_approved")
            self.authority.update(state="claimed", claimId=payload["claimId"])
            if self.lose_claim:
                raise TimeoutError()
        if operation == "receipt":
            if self.authority.get("receipt") not in (None, payload["receipt"]):
                raise RuntimeError("conflict")
            self.authority.update(state="completed", receipt=payload["receipt"])
            if self.lose_receipt:
                self.lose_receipt = False
                raise TimeoutError()
        return {"authority": copy.deepcopy(self.authority)}


class WorkerTests(unittest.TestCase):
    def test_binding_checks_exact_active_browser_metadata_without_mutation(self):
        script = Path(__file__).with_name("bind-approver.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root/"app"
            (app/"apps/server/src").mkdir(parents=True)
            policy = root/"policy.json"
            original = '[{"verifiedTargetId":"test-target"}]'
            policy.write_text(original)
            config = root/"operator.json"
            config.write_text(json.dumps({"node": sys.executable, "appRoot": str(app), "home": str(root/"home"),
                "policyFile": str(policy), "environmentFile": str(root/"env"), "verifiedTargetId": "test-target"}))
            session = {"sessionId": "fixture-browser", "subject": "fixture-subject", "method": "browser-session-cookie",
                "scopes": ["orchestration:operate"], "expiresAt": "2099-01-01T00:00:00Z"}
            cases = [(session, 0), ({**session, "method": "bearer-access-token"}, 1),
                ({**session, "subject": "other"}, 1), ({**session, "scopes": []}, 1),
                ({**session, "expiresAt": "2000-01-01T00:00:00Z"}, 1)]
            for metadata, expected in cases:
                (app/"apps/server/src/bin.ts").write_text("print("+repr(json.dumps([metadata]))+")")
                result = subprocess.run([sys.executable, "-B", str(script), "--config", str(config),
                    "--session-id", "fixture-browser", "--subject", "fixture-subject"], capture_output=True)
                self.assertEqual(result.returncode, expected, result.stderr.decode())
                self.assertEqual(policy.read_text(), original)

    def test_node_requester_rejects_private_looking_dns_before_http(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, url in enumerate(("http://127.attacker.example", "http://172.32.0.1", "http://8.8.8.8")):
                config = root/"config.json"
                config.write_text(json.dumps({"authorityUrl": url, "allowPrivateHttp": True, "tokenFile": "absent"}))
                output = root/str(index)
                result = subprocess.run(["node", str(Path(__file__).with_name("request.mjs")), str(config), "absent", str(output)], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                trace = [json.loads(line) for line in Path(str(output)+".trace.jsonl").read_text().splitlines()]
                self.assertEqual(trace[-1]["message"], "tls_required")
                self.assertFalse(any(row["event"] == "http_submit_start" for row in trace))

    def test_development_http_requires_literal_private_address_and_opt_in(self):
        for host in ("127.0.0.1", "100.64.0.10", "172.16.0.10", "10.0.0.10", "192.168.1.5"):
            worker.Api({"authorityUrl": "http://"+host, "allowPrivateHttp": True, "tokenFile": "unused"})
            with self.assertRaises(ValueError):
                worker.Api({"authorityUrl": "http://"+host, "tokenFile": "unused"})
        for host in ("127.attacker.example", "172.32.0.1", "192.169.0.1", "100.128.0.1", "8.8.8.8"):
            with self.assertRaises(ValueError):
                worker.Api({"authorityUrl": "http://"+host, "allowPrivateHttp": True, "tokenFile": "unused"})

    def test_operator_readback_rejects_worker_key_and_wrong_artifact(self):
        spec = importlib.util.spec_from_file_location("operator_readback", Path(__file__).with_name("operator-readback.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            config, authority, _ = self.setup_case(directory)
            config.update(ssh={"identityFile": "unused"}, sshKeygen="unused", operatorKeyFingerprint="SHA256:same", workerKeyFingerprint="SHA256:same")
            result = type("Fingerprint", (), {"stdout": "256 SHA256:same key (ED25519)"})()
            with patch.object(module.subprocess, "run", return_value=result), patch.object(module, "ssh_run") as remote:
                with self.assertRaisesRegex(ValueError, "independent_identity_required"):
                    module.check(config, authority["action"])
                authority["action"]["path"] = "/other"
                with self.assertRaisesRegex(ValueError, "target_mismatch"):
                    module.check(config, authority["action"])
                remote.assert_not_called()

    def setup_case(self, directory):
        source = worker.TEMPLATE.read_text()
        digest = hashlib.sha256(source.encode()).hexdigest()
        config = {"executionEnabled": True, "ledgerFile": str(Path(directory)/"ledger.sqlite"), "workerSubject": "worker", "requesterSubject": "requester",
            "target": {"verifiedTargetId": "test-target", "allowedPath": "/owned/new.txt", "implementationHash": digest}}
        authority = {"packageHash": "a"*64, "verifiedTargetId": "test-target", "state": "approved", "expiresAt": int(time.time()*1000)+60000,
            "workerSubject": "worker", "requesterSubject": "requester", "implementationSource": source,
            "action": {"kind": "create_file_once", "verifiedTargetId": "test-target", "path": "/owned/new.txt", "mode": 384,
                "expectedAbsent": True, "content": "immutable\n", "implementationVersion": worker.VERSION, "implementationHash": digest}}
        item = {"threadId": "thread", "requestId": "request", "packageHash": "a"*64, "verifiedTargetId": "test-target"}
        return config, authority, item

    def test_success_readback_and_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            config, authority, item = self.setup_case(directory)
            api = FakeApi(authority)
            calls = []
            def execute(config, source, action, operation):
                calls.append(operation)
                return {"outcome": "reported_succeeded", "contentHash": hashlib.sha256(action["content"].encode()).hexdigest()}
            instance = worker.Worker(config, api, execute)
            self.assertEqual(instance.handle(item), "reported_succeeded")
            self.assertEqual(instance.handle(item), "already_seen")
            self.assertEqual(calls, ["create", "read"])
            instance.db.close()

    def test_execution_disabled_never_claims(self):
        with tempfile.TemporaryDirectory() as directory:
            config, authority, item = self.setup_case(directory)
            config["executionEnabled"] = False
            api = FakeApi(authority)
            instance = worker.Worker(config, api, lambda *args: self.fail("disabled execution"))
            self.assertEqual(instance.handle(item), "execution_disabled")
            self.assertEqual(api.calls, [])
            instance.db.close()

    def test_tamper_never_executes(self):
        for field, value in [("path", "/other"), ("implementationHash", "b"*64), ("content", "\ud800"), ("expectedAbsent", False)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                config, authority, item = self.setup_case(directory)
                authority["action"][field] = value
                api = FakeApi(authority)
                def forbidden(*args):
                    self.fail("executor called for tampered input")
                instance = worker.Worker(config, api, forbidden)
                self.assertEqual(instance.handle(item), "rejected")
                instance.db.close()

    def test_unapproved_does_not_execute(self):
        with tempfile.TemporaryDirectory() as directory:
            config, authority, item = self.setup_case(directory)
            authority["state"] = "pending"
            instance = worker.Worker(config, FakeApi(authority), lambda *args: self.fail("unapproved execution"))
            with self.assertRaises(RuntimeError):
                instance.handle(item)
            instance.recover()
            instance.db.close()

    def test_lost_claim_after_restart_reports_unknown_without_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            config, authority, item = self.setup_case(directory)
            api = FakeApi(authority)
            api.lose_claim = True
            instance = worker.Worker(config, api, lambda *args: self.fail("uncertain execution"))
            with self.assertRaises(TimeoutError):
                instance.handle(item)
            instance.db.close()
            restarted = worker.Worker(config, api, lambda *args: self.fail("restarted execution"))
            restarted.recover()
            self.assertEqual(authority["receipt"]["outcome"], "unknown")
            self.assertEqual(api.calls.count("claim"), 1)
            restarted.db.close()

    def test_execution_disconnect_never_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            config, authority, item = self.setup_case(directory)
            api = FakeApi(authority)
            instance = worker.Worker(config, api, lambda *args: (_ for _ in ()).throw(TimeoutError()))
            self.assertEqual(instance.handle(item), "unknown")
            self.assertEqual(instance.handle(item), "already_seen")
            instance.db.close()

    def test_lost_receipt_reconciles_identically(self):
        with tempfile.TemporaryDirectory() as directory:
            config, authority, item = self.setup_case(directory)
            api = FakeApi(authority)
            api.lose_receipt = True
            calls = []
            def execute(config, source, action, operation):
                calls.append(operation)
                return {"outcome": "reported_succeeded", "contentHash": hashlib.sha256(action["content"].encode()).hexdigest()}
            instance = worker.Worker(config, api, execute)
            with self.assertRaises(TimeoutError):
                instance.handle(item)
            instance.db.close()
            instance = worker.Worker(config, api, execute)
            instance.recover()
            self.assertEqual(calls, ["create", "read"])
            self.assertEqual(api.calls.count("receipt"), 2)
            instance.db.close()


@unittest.skipIf(os.name == "nt", "POSIX target behavior")
class TargetTests(unittest.TestCase):
    def test_exclusive_creation_readback_symlink_and_mode(self):
        # Use the owned protected worktree; /tmp is intentionally rejected.
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory)/"new.txt"
            request = {"path": str(path), "content": "hello\n", "mode": 384, "expectedAbsent": True, "operation": "create"}
            create_file_once.execute(request)
            self.assertEqual(path.read_text(), "hello\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                create_file_once.execute({**request, "content": "overwrite"})
            create_file_once.execute({**request, "operation": "read"})
            with self.assertRaises(ValueError):
                create_file_once.execute({**request, "operation": "read", "content": "tamper"})
            link = Path(directory)/"link.txt"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                create_file_once.execute({**request, "path": str(link), "operation": "read"})
            self.assertEqual(path.read_text(), "hello\n")

    def test_unprotected_parent_rejected_before_create(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"forbidden.txt"
            with self.assertRaises(ValueError):
                create_file_once.execute({"path": str(path), "content": "x", "mode": 384, "expectedAbsent": True, "operation": "create"})
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
