#!/usr/bin/env python3
"""Small offline fixtures; no release execution or platform downloads."""
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release75_continuation", Path(__file__).with_name("release75-continuation.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
ROOT = Path(__file__).resolve().parents[2]
NOW = datetime.datetime(2026, 10, 29, 6, tzinfo=datetime.timezone.utc)


def origin_fixture():
    run = {"id": int(r.ORIGIN_RUN), "run_number": 10, "run_attempt": 1,
           "repository": {"full_name": r.REPO, "id": r.REPO_ID},
           "head_repository": {"full_name": r.REPO, "id": r.REPO_ID},
           "head_sha": r.SOURCE, "head_branch": "main", "event": "workflow_dispatch",
           "path": r.WORKFLOW, "status": "completed", "conclusion": "failure"}
    jobs = {"total_count": len(r.JOBS), "jobs": []}
    for name, (job_id, conclusion) in r.JOBS.items():
        steps = [{"name": step, "conclusion": "success"} for step in r.VERIFIED_STEPS.get(name, [])]
        if name == r.ANDROID_JOB:
            steps.append({"name": r.FAILED_STEP, "conclusion": "failure"})
        jobs["jobs"].append({"id": job_id, "name": name, "status": "completed", "conclusion": conclusion,
                             "run_id": int(r.ORIGIN_RUN), "run_attempt": 1, "head_sha": r.SOURCE, "steps": steps})
    artifacts = {"total_count": len(r.ARTIFACTS), "artifacts": [
        {"id": int(key), **pin, "expired": False,
         "workflow_run": {"id": int(r.ORIGIN_RUN), "head_sha": r.SOURCE,
                          "repository_id": r.REPO_ID, "head_repository_id": r.REPO_ID}}
        for key, pin in r.ARTIFACTS.items()]}
    return run, jobs, artifacts


def proof_fixture(preflight, build):
    route = b"small route fixture\n"
    route_sha = hashlib.sha256(route).hexdigest()
    common = {"source": r.SOURCE, "run": r.ORIGIN_RUN, "attempt": "1", "lockSha256": r.LOCK_SHA256,
              "trustedContextSha": r.SOURCE, "trustedWorkflowSha": r.SOURCE, "trustedWorkflowRef": r.WORKFLOW_REF}
    pre = {**common, "status": "generated-unreviewed", "effectiveSourceSha": r.SOURCE,
           "beforeSha256": route_sha, "afterSha256": route_sha, "checkScriptSha256": r.CHECK_SHA256,
           "generatorVersion": "1.167.12", "config": {"autoCodeSplitting": True}}
    preflight.mkdir()
    build.mkdir()
    (preflight / "receipt.json").write_text(json.dumps(pre))
    (preflight / "routeTree.gen.ts").write_bytes(route)
    (preflight / "routeTree.diff").write_bytes(b"")
    (build / "receipt.json").write_text(json.dumps({**common, "generatedRouteSha256": route_sha,
                                                   "preflightReceiptSha256": r.digest(preflight / "receipt.json")}))
    (build / "routeTree.gen.ts").write_bytes(route)
    return route_sha


def archive_fixture(root, names):
    archive = root / "fixture.zip"
    with zipfile.ZipFile(archive, "w") as output:
        for item in names:
            output.writestr(item, b"original fixture bytes")
    return archive, {"id": "12874658646", "size_in_bytes": archive.stat().st_size, "digest": "sha256:" + r.digest(archive)}


class ContinuationFixtures(unittest.TestCase):
    def test_origin_requires_exact_terminal_source_attempt_and_windows(self):
        r.validate_origin(*origin_fixture(), NOW)
        for case in ["source", "attempt", "running", "windows", "job_attempt", "job_id", "failed_step", "missing_check"]:
            with self.subTest(case=case):
                run, jobs, artifacts = origin_fixture()
                if case == "source":
                    run["head_sha"] = "0" * 40
                elif case == "attempt":
                    run["run_attempt"] = 2
                elif case == "running":
                    run["status"] = "in_progress"
                elif case == "windows":
                    next(j for j in jobs["jobs"] if j["name"] == "build_windows")["conclusion"] = "failure"
                elif case == "job_attempt":
                    jobs["jobs"][0]["run_attempt"] = 2
                elif case == "job_id":
                    jobs["jobs"][0]["id"] += 1
                elif case == "failed_step":
                    next(j for j in jobs["jobs"] if j["name"] == r.ANDROID_JOB)["steps"][0]["name"] = "Generate Android release project"
                else:
                    jobs["jobs"][0]["steps"].clear()
                with self.assertRaises(RuntimeError):
                    r.validate_origin(run, jobs, artifacts, NOW)

    def test_artifact_inventory_pins_owner_and_expiry_fail_closed(self):
        for case in ["digest", "name", "size", "expiry", "expired", "elapsed", "owner", "source", "missing", "duplicate"]:
            with self.subTest(case=case):
                run, jobs, artifacts = origin_fixture()
                item = artifacts["artifacts"][0]
                now = NOW
                if case == "digest":
                    item["digest"] = "sha256:" + "0" * 64
                elif case == "name":
                    item["name"] = "morrowbyte-release-android"
                elif case == "size":
                    item["size_in_bytes"] += 1
                elif case == "expiry":
                    item["expires_at"] = "2099-01-01T00:00:00Z"
                elif case == "expired":
                    item["expired"] = True
                elif case == "elapsed":
                    now = NOW + datetime.timedelta(days=2)
                elif case == "owner":
                    item["workflow_run"]["repository_id"] += 1
                elif case == "source":
                    item["workflow_run"]["head_sha"] = "0" * 40
                elif case == "missing":
                    artifacts["artifacts"].pop()
                else:
                    artifacts["artifacts"].append(copy.deepcopy(item))
                    artifacts["total_count"] += 1
                with self.assertRaises(RuntimeError):
                    r.validate_origin(run, jobs, artifacts, now)

    def test_control_allowlist_has_only_the_four_reviewed_paths(self):
        r.validate_control_paths(r.ALLOWED_CONTROL_PATHS)
        for extra in ["apps/mobile/app.config.ts", "pnpm-lock.yaml", "scripts/build-desktop-artifact.ts",
                      "scripts/morrowbyte/release68-continuation.py", "scripts/morrowbyte/release62-recovery.py"]:
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                r.validate_control_paths(r.ALLOWED_CONTROL_PATHS | {extra})

    def test_zip_preserves_bytes_and_rejects_changed_digest_and_collision(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive, pin = archive_fixture(root, ["fixture.AppImage"])
            records = r.extract_verified(archive, pin, root / "out")
            self.assertEqual((root / "out/fixture.AppImage").read_bytes(), b"original fixture bytes")
            self.assertEqual(records, [{"name": "fixture.AppImage", "artifactId": pin["id"], "sha256": r.digest(root / "out/fixture.AppImage")}])
            with self.assertRaisesRegex(RuntimeError, "collision"):
                r.extract_verified(archive, pin, root / "out")
            pin["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(RuntimeError, "digest/length"):
                r.extract_verified(archive, pin, root / "other")
            self.assertFalse((root / "other").exists())
            for artifact_id, label in [("12874658646", "linux"), ("12874614840", "windows")]:
                debug_archive = root / (label + ".zip")
                content = (label + " diagnostic bytes").encode()
                with zipfile.ZipFile(debug_archive, "w") as output:
                    output.writestr("builder-debug.yml", content)
                debug_pin = {"id": artifact_id, "name": r.ARTIFACTS[artifact_id]["name"],
                             "digest": "sha256:" + r.digest(debug_archive), "size_in_bytes": debug_archive.stat().st_size}
                records = r.extract_verified(debug_archive, debug_pin, root / "debug")
                expected_name = debug_pin["name"] + "-builder-debug.yml"
                self.assertEqual((root / "debug" / expected_name).read_bytes(), content)
                self.assertEqual(records, [{"name": expected_name, "originalName": "builder-debug.yml",
                                            "artifactId": artifact_id, "sha256": hashlib.sha256(content).hexdigest()}])
                with self.assertRaisesRegex(RuntimeError, "collision"):
                    r.extract_verified(debug_archive, debug_pin, root / "debug")
                for foreign in [{"id": "0", "name": debug_pin["name"]},
                                {"id": artifact_id, "name": "foreign-producer"},
                                {"id": "12873834927", "name": "morrowbyte-release-cli-linux"}]:
                    with self.subTest(producer=foreign), self.assertRaises(RuntimeError):
                        r.extract_verified(debug_archive, {**debug_pin, **foreign}, root / "foreign")
                    self.assertFalse((root / "foreign").exists())

    def test_zip_rejects_path_escape_special_files_and_case_collision_before_writes(self):
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in [["../escape"], ["C:/escape"], ["nested/file"], ["a\\b"], [link],
                        ["FILE", "file"], [r.RECEIPT_NAME]]:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive, pin = archive_fixture(root, entries)
                with self.assertRaises(RuntimeError):
                    r.extract_verified(archive, pin, root / "out")
                self.assertFalse((root / "out").exists())

    def test_route_proofs_bind_original_context_and_old_check_script(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            preflight, build = root / "preflight", root / "build"
            route_sha = proof_fixture(preflight, build)
            with patch.object(r, "ROUTE_SHA256", route_sha):
                r.validate_proofs(preflight, build)
                path = preflight / "receipt.json"
                original = path.read_bytes()
                for key, value in [("source", "0" * 40), ("attempt", "2"), ("trustedContextSha", "c" * 40),
                                   ("checkScriptSha256", "c" * 64), ("afterSha256", "0" * 64)]:
                    data = json.loads(original)
                    data[key] = value
                    path.write_text(json.dumps(data))
                    with self.subTest(key=key), self.assertRaises(RuntimeError):
                        r.validate_proofs(preflight, build)
                path.write_bytes(original)
                (build / "routeTree.gen.ts").write_bytes(b"changed route")
                with self.assertRaises(RuntimeError):
                    r.validate_proofs(preflight, build)

    def test_verify_rechecks_receipt_ownership_platform_bytes_and_route_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            assets = root / "release-assets"
            assets.mkdir()
            preflight, build = root / "observatory-publish-preflight", root / "observatory-publish-build"
            route_sha = proof_fixture(preflight, build)
            env = {"GITHUB_REPOSITORY": r.REPO, "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "c" * 40, "CONTROL_SHA": "c" * 40,
                   "GITHUB_WORKFLOW_SHA": "c" * 40, "GITHUB_WORKFLOW_REF": r.WORKFLOW_REF,
                   "GITHUB_RUN_ID": "40822000000", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": temp}
            files = []
            for index, artifact_id in enumerate(r.PLATFORM_IDS):
                path = assets / f"fixture-{index}.bin"
                path.write_bytes(f"platform {index}".encode())
                files.append({"name": path.name, "artifactId": artifact_id, "sha256": r.digest(path)})
            for artifact_id in ["12874658646", "12874614840"]:
                path = assets / (r.ARTIFACTS[artifact_id]["name"] + "-builder-debug.yml")
                path.write_bytes((artifact_id + " diagnostic").encode())
                files.append({"name": path.name, "originalName": "builder-debug.yml",
                              "artifactId": artifact_id, "sha256": r.digest(path)})
            with patch.dict(os.environ, env, clear=True), patch.object(r, "ROUTE_SHA256", route_sha):
                receipt = r.make_receipt(files, r.proof_files(preflight, build), "d" * 64)
                path = assets / r.RECEIPT_NAME
                original = json.dumps(receipt).encode()
                path.write_bytes(original)
                os.environ["RECOVERY75_RECEIPT_SHA256"] = r.digest(path)
                r.verify(assets)
                for key, value in [("source", "0" * 40), ("originAttempt", "2"), ("controlSource", "e" * 40)]:
                    changed = copy.deepcopy(receipt)
                    changed[key] = value
                    path.write_text(json.dumps(changed))
                    os.environ["RECOVERY75_RECEIPT_SHA256"] = r.digest(path)
                    with self.subTest(key=key), self.assertRaises(RuntimeError):
                        r.verify(assets)
                for case in ["duplicate", "path", "artifact", "control", "originalName"]:
                    changed = copy.deepcopy(receipt)
                    if case == "duplicate":
                        changed["files"].append(copy.deepcopy(changed["files"][0]))
                    elif case == "path":
                        changed["files"][0]["name"] = "../escape"
                    elif case == "artifact":
                        changed["files"][0]["artifactId"] = "0"
                    elif case == "originalName":
                        changed["files"][-1]["originalName"] = "foreign.yml"
                    path.write_text(json.dumps(changed))
                    os.environ["RECOVERY75_RECEIPT_SHA256"] = r.digest(path)
                    with self.subTest(case=case), patch.dict(os.environ, {"CONTROL_SHA": "e" * 40} if case == "control" else {}), self.assertRaises(RuntimeError):
                        r.verify(assets)
                path.write_bytes(original)
                os.environ["RECOVERY75_RECEIPT_SHA256"] = r.digest(path)
                target = assets / files[0]["name"]
                target.write_bytes(b"changed platform")
                with self.assertRaisesRegex(RuntimeError, "bytes changed"):
                    r.verify(assets)
                target.write_bytes(b"platform 0")
                (build / "routeTree.gen.ts").write_bytes(b"changed route")
                with self.assertRaisesRegex(RuntimeError, "bytes changed"):
                    r.verify(assets)

    def test_existing_version_or_second_continuation_is_rejected(self):
        runs = {"total_count": 2, "workflow_runs": [{"id": int(r.ORIGIN_RUN)}, {"id": 40822000000}]}
        r.validate_unique(runs, [], "", "40822000000")
        for case in ["release", "tag", "second", "incomplete"]:
            changed = copy.deepcopy(runs)
            releases, tag = [], ""
            if case == "release":
                releases = [{"tag_name": "v" + r.VERSION}]
            elif case == "tag":
                tag = r.SOURCE + " refs/tags/v" + r.VERSION
            elif case == "second":
                changed["workflow_runs"].append({"id": 40821999999})
                changed["total_count"] += 1
            else:
                changed["total_count"] += 1
            with self.subTest(case=case), self.assertRaises(RuntimeError):
                r.validate_unique(changed, releases, tag, "40822000000")

    def test_wrong_request_stops_before_git_or_network(self):
        for key, value in [("SOURCE_SHA", "0" * 40), ("CONTINUATION75_RUN_ID", "40291055865"), ("GITHUB_REPOSITORY", "foreign/repo")]:
            env = {"SOURCE_SHA": r.SOURCE, "CONTINUATION75_RUN_ID": r.ORIGIN_RUN, "GITHUB_REPOSITORY": r.REPO, key: value}
            with self.subTest(key=key), patch.dict(os.environ, env, clear=True), patch.object(r, "api") as network, patch.object(r, "git") as git:
                with self.assertRaises(RuntimeError):
                    r.recover()
                network.assert_not_called()
                git.assert_not_called()

    def test_workflow_inline_standalone_gate_allows_only_expected_observe_metadata(self):
        workflow = (ROOT / r.WORKFLOW).read_text()
        code = textwrap.dedent(workflow.split("<<'PYCONFIG'\n", 1)[1].split("\n          PYCONFIG", 1)[0])
        valid = {"name": "Crew", "scheme": "morrowbyte", "android": {"package": "com.morrowbyte.t3code", "versionCode": 75},
                 "version": r.VERSION, "updates": {"enabled": False},
                 "extra": {"eas": {"observe": {"endpointUrl": "https://observe.invalid"},
                                   "build": {"experimental": {"ios": {"appExtensions": []}}}}}}
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"RUNNER_TEMP": temp,
                "T3CODE_MOBILE_VERSION": r.VERSION, "MORROWBYTE_ANDROID_VERSION_CODE": "75"}):
            for case in ["valid", "owner", "projectId", "observe-key", "endpoint"]:
                config = copy.deepcopy(valid)
                if case == "owner":
                    config["owner"] = "foreign"
                elif case == "projectId":
                    config["extra"]["eas"]["projectId"] = "foreign"
                elif case == "observe-key":
                    config["extra"]["eas"]["observe"]["projectId"] = "foreign"
                elif case == "endpoint":
                    config["extra"]["eas"]["observe"]["endpointUrl"] = "https://foreign.invalid"
                (Path(temp) / "morrowbyte-config.json").write_text(json.dumps(config))
                with self.subTest(case=case):
                    if case == "valid":
                        exec(compile(code, r.WORKFLOW + ":PYCONFIG", "exec"), {})
                    else:
                        with self.assertRaises(AssertionError):
                            exec(compile(code, r.WORKFLOW + ":PYCONFIG", "exec"), {})


if __name__ == "__main__":
    unittest.main()
