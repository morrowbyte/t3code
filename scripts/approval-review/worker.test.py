import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest

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
