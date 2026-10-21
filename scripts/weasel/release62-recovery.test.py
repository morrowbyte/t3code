#!/usr/bin/env python3
"""Bounded offline fixtures; never dispatch, download, compile or publish."""
import contextlib
import datetime
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("release62_recovery", Path(__file__).with_name("release62-recovery.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
ROOT = Path(__file__).resolve().parents[2]


def origin_fixture():
    run = {"id": int(r.ORIGIN_RUN), "run_number": 62, "run_attempt": 1, "repository": {"full_name": r.REPO, "id": 1175532637}, "head_repository": {"full_name": r.REPO}, "head_sha": r.SOURCE, "head_branch": "main", "event": "workflow_dispatch", "path": r.ORIGIN_WORKFLOW, "status": "completed", "conclusion": "failure"}
    jobs = {"total_count": len(r.JOBS), "jobs": [{"name": name, "conclusion": conclusion, "status": "completed", "head_sha": r.SOURCE, "steps": [{"name": "Build Windows x64 installer and updater metadata", "conclusion": "failure"}] if name == "build_windows" else []} for name, conclusion in r.JOBS.items()]}
    for job in jobs["jobs"]:
        if job["name"] in r.VERIFIED_STEPS:
            job["steps"] = [{"name": name, "conclusion": "success"} for name in r.VERIFIED_STEPS[job["name"]]]
    artifacts = [{"id": int(key), **value, "expired": False, "workflow_run": {"id": int(r.ORIGIN_RUN), "head_sha": r.SOURCE, "repository_id": 1175532637, "head_repository_id": 1175532637}} for key, value in r.ARTIFACTS.items()]
    return run, jobs, {"total_count": len(artifacts), "artifacts": artifacts}


def proof_fixture(root):
    ref = r.REPO + "/" + r.ORIGIN_WORKFLOW + "@refs/heads/main"
    common = {"source": r.SOURCE, "trustedContextSha": r.SOURCE, "trustedWorkflowSha": r.SOURCE, "run": r.ORIGIN_RUN, "attempt": "1", "trustedWorkflowRef": ref, "lockSha256": r.LOCK_SHA256}
    pre = {**common, "status": "generated-unreviewed", "effectiveSourceSha": r.SOURCE, "generatorVersion": "1.167.12", "config": {"autoCodeSplitting": True}, "checkScriptSha256": r.digest(ROOT / "scripts/weasel/check.sh"), "beforeSha256": r.digest(ROOT / "apps/web/src/routeTree.gen.ts"), "afterSha256": r.ROUTE_SHA256}
    for directory in ["observatory-route-generation", "observatory-release-build", "recovered-platforms"]:
        (root / directory).mkdir()
    (root / "observatory-route-generation/receipt.json").write_text(json.dumps(pre))
    (root / "observatory-route-generation/routeTree.diff").write_text("fixture diff")
    for directory in ["observatory-route-generation", "observatory-release-build"]:
        (root / directory / "routeTree.gen.ts").write_bytes((ROOT / "apps/web/src/routeTree.gen.ts").read_bytes())
    built = {**common, "generatedRouteSha256": r.ROUTE_SHA256, "preflightReceiptSha256": r.digest(root / "observatory-route-generation/receipt.json")}
    (root / "observatory-release-build/receipt.json").write_text(json.dumps(built))
    name = f"Morrowbyte-{r.VERSION}-android-arm64.apk"
    apk = root / "recovered-platforms" / name
    apk.write_bytes(b"receipt-contract fixture; no native APK/signature acceptance")
    sha = r.digest(apk)
    receipt = {"schemaVersion": 1, **common, "desktopSource": r.SOURCE, "version": r.VERSION, "versionCode": 62, "apk": name, "apkSha256": sha, "package": "com.morrowbyte.t3code", "name": "Morrowbyte", "certificateSha256": "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2", "abis": ["arm64-v8a"], "signatureVerified": True, "zip16KB": True, "elf16KB": True, "deviceAcceptance": "not-run"}
    (root / "recovered-platforms" / (name + ".json")).write_text(json.dumps(receipt))
    (root / "recovered-platforms" / (name + ".sha256")).write_text(f"{sha}  {name}\n")
    return receipt, apk


class RecoveryFixtures(unittest.TestCase):
    def test_exact_failed_origin_and_all_eight_artifacts_qualify(self):
        self.assertEqual(len(r.validate_origin(*origin_fixture(), datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))), 8)

    def test_wrong_origin_attempt_source_version_and_job_outcomes_fail(self):
        for key, value in [("id", 39182028263), ("run_attempt", 2), ("run_number", 63), ("head_sha", "f" * 40), ("path", r.WORKFLOW), ("conclusion", "success")]:
            run, jobs, artifacts = origin_fixture()
            run[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                r.validate_origin(run, jobs, artifacts, datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))
        run, jobs, artifacts = origin_fixture()
        jobs["jobs"][0]["conclusion"] = "failure"
        with self.assertRaises(RuntimeError):
            r.validate_origin(run, jobs, artifacts, datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))

    def test_artifact_digest_size_owner_expiry_and_complete_inventory_fail_closed(self):
        for key, value in [("id", 1), ("digest", "sha256:" + "0" * 64), ("size_in_bytes", 1), ("expired", True), ("expires_at", "2026-10-20T00:00:00Z")]:
            run, jobs, artifacts = origin_fixture()
            artifacts["artifacts"][0][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                r.validate_origin(run, jobs, artifacts, datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))
        run, jobs, artifacts = origin_fixture()
        artifacts["artifacts"][0]["workflow_run"]["head_repository_id"] = 1
        with self.assertRaises(RuntimeError):
            r.validate_origin(run, jobs, artifacts, datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))
        run, jobs, artifacts = origin_fixture()
        artifacts["artifacts"].pop()
        with self.assertRaises(RuntimeError):
            r.validate_origin(run, jobs, artifacts, datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))

    def test_skipped_original_apk_signature_step_cannot_qualify(self):
        run, jobs, artifacts = origin_fixture()
        android = next(job for job in jobs["jobs"] if job["name"] == "Build Morrowbyte Android APK")
        android["steps"][-1]["conclusion"] = "skipped"
        with self.assertRaisesRegex(RuntimeError, "verification step did not pass"):
            r.validate_origin(run, jobs, artifacts, datetime.datetime(2026, 10, 21, tzinfo=datetime.timezone.utc))

    def test_pinned_artifacts_expire_before_recovery_can_build_windows(self):
        with self.assertRaisesRegex(RuntimeError, "expired"):
            r.validate_origin(*origin_fixture(), datetime.datetime(2026, 10, 29, tzinfo=datetime.timezone.utc))

    def test_route_and_apk_receipt_contract_chain_qualifies_offline(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            receipt, apk = proof_fixture(root)
            self.assertEqual(r.validate_proofs(root)[0], r.digest(apk))

    def test_wrong_apk_source_cert_abi_version_and_false_signature_proofs_fail(self):
        for key, value in [("source", "f" * 40), ("versionCode", 63), ("certificateSha256", "0" * 64), ("abis", ["x86_64"]), ("signatureVerified", False), ("zip16KB", False), ("attempt", "2")]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                receipt, apk = proof_fixture(root)
                receipt[key] = value
                apk.with_name(apk.name + ".json").write_text(json.dumps(receipt))
                with self.assertRaisesRegex(RuntimeError, "APK provenance"):
                    r.validate_proofs(root)

    def test_changed_apk_or_route_proof_bytes_fail_before_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            receipt, apk = proof_fixture(root)
            apk.write_bytes(b"changed")
            with self.assertRaises(RuntimeError):
                r.validate_proofs(root)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            proof_fixture(root)
            (root / "observatory-release-build/routeTree.gen.ts").write_text("changed")
            with self.assertRaisesRegex(RuntimeError, "route bytes"):
                r.validate_proofs(root)

    def test_tooling_allowlist_never_allows_app_lock_or_auth_changes(self):
        r.validate_tooling_changes(r.ALLOWED_TOOLING, r.PACKAGING_SHA256, r.PACKAGING_TEST_SHA256)
        for extra in ["apps/server/src/voice/CodexLiveSessionService.ts", "pnpm-lock.yaml", "apps/server/src/auth/RpcAuthorization.ts"]:
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                r.validate_tooling_changes(r.ALLOWED_TOOLING | {extra}, r.PACKAGING_SHA256, r.PACKAGING_TEST_SHA256)
        with self.assertRaises(RuntimeError):
            r.validate_tooling_changes(r.ALLOWED_TOOLING, "0" * 64, r.PACKAGING_TEST_SHA256)

    def test_exact_zip_bytes_are_reused_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "fixture.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("fixture.apk", b"fixture, not an Android package")
            artifact = {"name": "weasel-release-android", "size_in_bytes": archive.stat().st_size, "digest": "sha256:" + r.digest(archive)}
            r.extract_verified(archive, artifact, root / "out")
            self.assertEqual((root / "out/fixture.apk").read_bytes(), b"fixture, not an Android package")
            with self.assertRaises(FileExistsError):
                r.extract_verified(archive, artifact, root / "out")
            artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(RuntimeError, "digest/length"):
                r.extract_verified(archive, artifact, root / "other")

    def test_zip_traversal_symlink_and_unexpected_bundle_paths_are_rejected(self):
        for name, symlink, bundle in [("../escape", False, False), ("C:/escape", False, False), ("folder/file", False, False), ("link", True, False), ("server/source/unreviewed.js", False, True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / "fixture.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    info = zipfile.ZipInfo(name)
                    if symlink:
                        info.create_system = 3
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    output.writestr(info, "fixture")
                artifact = {"name": "fixture", "size_in_bytes": archive.stat().st_size, "digest": "sha256:" + r.digest(archive)}
                with self.assertRaises(RuntimeError):
                    r.extract_verified(archive, artifact, root / "out", bundle=bundle)

    def test_wrong_recovery_request_stops_before_any_network_or_git(self):
        for key, value in [("SOURCE_SHA", "f" * 40), ("ORIGIN_RUN_ID", "39182028263"), ("GITHUB_REPOSITORY", "foreign/repo")]:
            env = {"SOURCE_SHA": r.SOURCE, "ORIGIN_RUN_ID": r.ORIGIN_RUN, "GITHUB_REPOSITORY": r.REPO, key: value}
            with self.subTest(key=key), patch.dict(os.environ, env, clear=True), patch.object(r, "api") as network, patch.object(r, "git") as git:
                with self.assertRaises(RuntimeError):
                    r.recover()
                network.assert_not_called()
                git.assert_not_called()

    def test_retained_files_and_control_identity_are_checked_before_publish(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.chdir(temp):
            assets = Path("release-assets")
            assets.mkdir()
            (assets / "retained.AppImage").write_bytes(b"fixture-original")
            receipt = {"source": r.SOURCE, "version": r.VERSION, "originRun": r.ORIGIN_RUN, "originAttempt": "1", "controlSource": "c" * 40, "publicationRun": "700", "publicationAttempt": "1", "windowsPackagingScriptSha256": r.PACKAGING_SHA256, "files": [{"name": "retained.AppImage", "sha256": r.digest(assets / "retained.AppImage")}]}
            path = assets / "WINDOWS-RECOVERY.json"
            path.write_text(json.dumps(receipt))
            env = {"RECOVERY_RECEIPT_SHA256": r.digest(path), "GITHUB_SHA": "c" * 40, "GITHUB_RUN_ID": "700", "GITHUB_RUN_ATTEMPT": "1"}
            with patch.dict(os.environ, env, clear=True):
                r.verify_retained()
                (assets / "retained.AppImage").write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "bytes changed"):
                    r.verify_retained()
            with patch.dict(os.environ, {**env, "GITHUB_SHA": "d" * 40}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "ownership"):
                    r.verify_retained()

    def test_workflow_has_only_recover_windows_publish_and_no_product_jobs_without_go(self):
        command = "const {createRequire}=require('node:module'); const {resolve}=require('node:path');const y=createRequire(resolve('packages/shared/package.json'))('yaml'); console.log(JSON.stringify(y.parse(require('node:fs').readFileSync('.github/workflows/weasel-release62-recovery.yml','utf8'))));"
        workflow = json.loads(subprocess.check_output(["node", "-e", command], cwd=ROOT))
        self.assertEqual(set(workflow["jobs"]), {"recover", "build_windows", "publish"})
        self.assertEqual(workflow["concurrency"], {"group": "weasel-desktop-nightly", "cancel-in-progress": False})
        self.assertFalse(workflow["on"]["workflow_dispatch"]["inputs"]["publish"]["default"])
        for name, job in workflow["jobs"].items():
            self.assertIn("inputs.publish", job["if"])
            self.assertEqual(job["timeout-minutes"], {"recover": 15, "build_windows": 50, "publish": 15}[name])
        evaluate = "const fs=require('node:fs');const a=JSON.parse(fs.readFileSync(0,'utf8'));let e=a.expression.trim().replace(/^\\$\\{\\{/,'').replace(/\\}\\}$/,'');console.log(JSON.stringify(Boolean(Function('inputs','needs','github','cancelled','return ('+e+')')(a.inputs,a.needs,{repository:'morrowbyte/t3code'},()=>false))));"
        def condition(job, publish, recover="success", windows="success"):
            payload = {"expression": workflow["jobs"][job]["if"], "inputs": {"publish": publish}, "needs": {"recover": {"result": recover}, "build_windows": {"result": windows}}}
            return json.loads(subprocess.check_output(["node", "-e", evaluate], input=json.dumps(payload), text=True))
        for job in workflow["jobs"]:
            self.assertFalse(condition(job, False))
            self.assertTrue(condition(job, True))
        self.assertFalse(condition("build_windows", True, recover="failure"))
        self.assertFalse(condition("publish", True, windows="failure"))
        self.assertFalse(condition("publish", True, recover="failure"))
        windows = workflow["jobs"]["build_windows"]
        self.assertEqual(windows["needs"], ["recover"])
        overlay = next(step for step in windows["steps"] if step["name"] == "Apply only the hash-pinned .62 validator fix")
        self.assertIn(r.PACKAGING_SHA256, overlay["run"])
        self.assertIn('test "$(git diff --name-only)" = scripts/build-desktop-artifact.ts', overlay["run"])
        self.assertEqual(workflow["jobs"]["publish"]["needs"], ["recover", "build_windows"])
        publish = workflow["jobs"]["publish"]
        self.assertIn("needs.build_windows.result == 'success'", publish["if"])
        self.assertTrue(any("Verify APK" in s.get("name", "") or s.get("name") == "Verify Android bytes from this build before publication" for s in publish["steps"]))
        self.assertTrue(any(s.get("name") == "Verify every retained .62 payload byte and recovery ownership" for s in publish["steps"]))


if __name__ == "__main__":
    unittest.main()
