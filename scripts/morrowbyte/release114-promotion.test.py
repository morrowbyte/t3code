#!/usr/bin/env python3
"""Offline promotion fixtures; no product builds or release operations."""
import contextlib
import copy
import datetime
import hashlib
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
spec = importlib.util.spec_from_file_location("release114_promotion", Path(__file__).with_name("release114-promotion.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
ROOT = Path(__file__).resolve().parents[2]
NOW = datetime.datetime(2026, 11, 12, 7, tzinfo=datetime.timezone.utc)


def origin_fixture():
    run = {"id": int(r.ORIGIN_RUN), "run_number": 49, "run_attempt": 1, "workflow_id": 393910318,
           "repository": {"full_name": r.REPO, "id": r.REPO_ID}, "head_repository": {"full_name": r.REPO, "id": r.REPO_ID},
           "head_sha": r.SOURCE, "head_branch": "main", "event": "workflow_dispatch", "path": r.WORKFLOW,
           "status": "completed", "conclusion": "failure"}
    jobs = {"total_count": len(r.JOBS), "jobs": []}
    for name, (job_id, conclusion) in r.JOBS.items():
        steps = [{"name": step, "conclusion": "success"} for step in r.VERIFIED_STEPS.get(name, [])]
        if name == "build_windows":
            steps.append({"name": "Setup Rust", "conclusion": "failure"})
        if name == "publish_linux_first":
            steps.extend([{"name": "Verify isolated release payload", "conclusion": "failure"},
                          {"name": "Create fork-only prerelease", "conclusion": "skipped"}])
        jobs["jobs"].append({"name": name, "id": job_id, "conclusion": conclusion, "status": "completed",
                             "head_sha": r.SOURCE, "run_id": int(r.ORIGIN_RUN), "run_attempt": 1, "steps": steps})
    artifacts = {"total_count": len(r.ARTIFACTS), "artifacts": [
        {"id": int(key), **pin, "expired": False, "workflow_run": {"id": int(r.ORIGIN_RUN), "head_sha": r.SOURCE,
         "repository_id": r.REPO_ID, "head_repository_id": r.REPO_ID, "head_branch": "main"}}
        for key, pin in r.ARTIFACTS.items()]}
    return run, jobs, artifacts


def selection_fixture():
    return {"promote_release114_run_id": r.ORIGIN_RUN, "source_sha": r.SOURCE, "publish": True}


def boundary_fixture():
    url = f"https://api.github.com/repos/{r.REPO}/releases/123"
    release = {"id": 123, "url": url, "tag_name": r.TAG, "target_commitish": r.SOURCE,
               "prerelease": True, "draft": True, "assets": []}
    view = {"apiUrl": url, "tagName": r.TAG, "targetCommitish": r.SOURCE, "isDraft": True}
    responses = {
        ("release", "view", r.TAG, "--repo", r.REPO, "--json", "apiUrl,isDraft,targetCommitish,tagName"): (0, view, b""),
        ("api", f"repos/{r.REPO}/releases/123"): (0, release, b""),
        ("api", f"repos/{r.REPO}/releases/tags/{r.TAG}"): (1, {"status": "404"}, b""),
        ("api", f"repos/{r.REPO}/git/ref/tags/{r.TAG}"): (1, {"status": "404"}, b""),
        ("api", f"repos/{r.REPO}/"): (0, {"id": r.REPO_ID, "full_name": r.REPO, "permissions": {"push": True}}, b""),
        ("api", f"repos/{r.REPO}/releases?per_page=100&page=1"): (0, [], b""),
    }
    def run(command, **kwargs):
        assert command[0] == "gh"
        status, body, error = responses[tuple(command[1:])]
        return subprocess.CompletedProcess(command, status, body if isinstance(body, bytes) else json.dumps(body).encode(), error)
    return release, view, responses, run


def archive_fixture(root, members, artifact_id=r.PLATFORM_IDS[0]):
    archive = root / "fixture.zip"
    with zipfile.ZipFile(archive, "w") as output:
        for member, data in members:
            output.writestr(member, data)
    return archive, {"id": artifact_id, "size_in_bytes": archive.stat().st_size, "digest": "sha256:" + r.digest(archive)}


def receipt_fixture(root):
    assets = root / "release-assets"
    assets.mkdir()
    (assets / "morrowbyte-linux-x64.tar.gz").write_bytes(b"retained Linux bundle fixture")
    for role in r.PROOF_IDS:
        (root / role).mkdir()
        (root / role / "receipt.json").write_bytes(b"retained proof fixture")
    changes = [["M" if path != "scripts/morrowbyte/release114-promotion.py" else "A", path] for path in sorted(r.ALLOWED_CONTROL_PATHS)]
    receipt = r.make_receipt(r.file_records(assets), {role: r.file_records(root / role) for role in r.PROOF_IDS}, changes)
    path = assets / r.RECEIPT_NAME
    path.write_text(json.dumps(receipt))
    return assets, receipt, path


def proof_fixture(root, assets):
    for role in r.PROOF_IDS:
        (root / role).mkdir()
    route = b"retained route fixture"
    route_sha = hashlib.sha256(route).hexdigest()
    common = {"source": r.SOURCE, "trustedContextSha": r.SOURCE, "trustedWorkflowSha": r.SOURCE,
              "attempt": "1", "lockSha256": r.LOCK_SHA256}
    preflight, build = root / "observatory-publish-preflight", root / "observatory-publish-build"
    pre = {**common, "run": r.SOURCE_PROOF_RUN, "trustedWorkflowRef": r.SOURCE_PROOF_REF,
           "effectiveSourceSha": r.SOURCE, "status": "generated-unreviewed", "checkScriptSha256": r.CHECK_SHA256,
           "config": {"autoCodeSplitting": True}, "afterSha256": route_sha}
    (preflight / "receipt.json").write_text(json.dumps(pre))
    (preflight / "routeTree.gen.ts").write_bytes(route)
    (preflight / "routeTree.diff").write_bytes(b"")
    built = {**common, "run": r.ORIGIN_RUN, "trustedWorkflowRef": r.WORKFLOW_REF,
             "generatedRouteSha256": route_sha, "preflightReceiptSha256": r.digest(preflight / "receipt.json")}
    (build / "receipt.json").write_text(json.dumps(built))
    (build / "routeTree.gen.ts").write_bytes(route)
    image = f"T3-Code-{r.VERSION}-x86_64.AppImage"
    (assets / image).write_bytes(b"retained AppImage fixture; no executable acceptance")
    linux = root / "release114-linux-startup"
    (linux / "startup.json").write_text(json.dumps({"status": "passed", "platform": "linux", "version": r.VERSION, "seededThreadVisible": True}))
    (linux / "appimage.sha256").write_text(r.digest(assets / image) + "  /original/builder/" + image + "\n")
    dependency = root / "release114-android-evidence/morrowbyte-android-dependencies.txt"
    dependency.write_bytes(b"retained dependencies fixture")
    name = f"Morrowbyte-{r.VERSION}-android-arm64.apk"
    (assets / name).write_bytes(b"retained APK fixture; no Android acceptance")
    apk_sha = r.digest(assets / name)
    (assets / (name + ".sha256")).write_text(f"{apk_sha}  {name}\n")
    startup = {"status": "passed", "source": r.SOURCE, "run": r.ORIGIN_RUN, "attempt": "1", "productionApkSha256": apk_sha,
               "embeddedBundleSha256": "e" * 64, "uiBeyondSplash": True, "startupErrors": False,
               "startupAbi": "x86_64", "shippingAbi": "arm64-v8a", "physicalDeviceAcceptance": False}
    (root / "release114-android-startup/startup.json").write_text(json.dumps(startup))
    apk_receipt = {"schemaVersion": 1, **common, "source": r.SOURCE, "desktopSource": r.SOURCE,
                   "run": r.ORIGIN_RUN, "trustedWorkflowRef": r.WORKFLOW_REF, "apk": name, "apkSha256": apk_sha,
                   "version": r.VERSION, "versionCode": 114, "package": "com.morrowbyte.t3code", "name": "Crew",
                   "abis": ["arm64-v8a"], "certificateSha256": r.CERT_SHA256, "signatureVerified": True,
                   "zip16KB": True, "elf16KB": True, "deviceAcceptance": "not-run", "embeddedBundleSha256": "e" * 64,
                   "dependencyReportSha256": r.digest(dependency), "ciEmulatorStartup": {**startup,
                   "startupScriptSha256": r.digest(ROOT / "scripts/morrowbyte/android-startup-smoke.sh")}}
    receipt = assets / (name + ".json")
    receipt.write_text(json.dumps(apk_receipt))
    return route_sha, apk_sha, r.digest(receipt)


def load_workflow():
    command = "const{createRequire}=require('node:module');const{resolve}=require('node:path');const y=createRequire(resolve('packages/shared/package.json'))('yaml');console.log(JSON.stringify(y.parse(require('node:fs').readFileSync('.github/workflows/morrowbyte-release.yml','utf8'))));"
    return json.loads(subprocess.check_output(["node", "-e", command], cwd=ROOT))


def condition(expression, inputs, needs):
    evaluate = "const a=JSON.parse(require('node:fs').readFileSync(0,'utf8'));const e=a.expression.trim().replace(/^\\$\\{\\{/,'').replace(/\\}\\}$/,'');console.log(JSON.stringify(Boolean(Function('inputs','needs','github','vars','cancelled','return ('+e+')')(a.inputs,a.needs,{repository:'morrowbyte/t3code'},{},()=>false))));"
    return json.loads(subprocess.check_output(["node", "-e", evaluate], input=json.dumps({"expression": expression, "inputs": inputs, "needs": needs}), text=True))


class PromotionFixtures(unittest.TestCase):
    def test_exact_origin_attempt_twelve_artifacts_and_known_failures_qualify(self):
        r.validate_origin(*origin_fixture(), NOW)
        self.assertEqual(len(r.ARTIFACTS), 12)
        self.assertEqual(len(r.PLATFORM_IDS), 4)

    def test_wrong_origin_source_attempt_event_workflow_and_jobs_fail(self):
        for field, value in [("id", 43159613780), ("run_attempt", 2), ("run_number", 114), ("head_sha", r.CONTROL_BASE),
                             ("workflow_id", 1), ("path", "other.yml"), ("event", "push"), ("conclusion", "success")]:
            run, jobs, artifacts = origin_fixture()
            run[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                r.validate_origin(run, jobs, artifacts, NOW)
        for case in ["id", "attempt", "failure", "missing-step", "created", "incomplete"]:
            run, jobs, artifacts = origin_fixture()
            if case == "id":
                jobs["jobs"][0]["id"] += 1
            elif case == "attempt":
                jobs["jobs"][0]["run_attempt"] = 2
            elif case == "failure":
                next(j for j in jobs["jobs"] if j["name"] == "build_windows")["steps"][0]["name"] = "Unreviewed failure"
            elif case == "missing-step":
                jobs["jobs"][0]["steps"].clear()
            elif case == "created":
                next(j for j in jobs["jobs"] if j["name"] == "publish_linux_first")["steps"][-1]["conclusion"] = "success"
            else:
                jobs["jobs"].pop()
            with self.subTest(case=case), self.assertRaises(RuntimeError):
                r.validate_origin(run, jobs, artifacts, NOW)

    def test_artifact_digest_size_name_expiry_owner_and_inventory_fail_closed(self):
        for case in ["digest", "size_in_bytes", "name", "expires_at", "expired", "owner", "source", "missing", "duplicate", "elapsed"]:
            run, jobs, artifacts = origin_fixture()
            item = artifacts["artifacts"][0]
            now = NOW
            if case in ["digest", "name", "expires_at"]:
                item[case] = {"digest": "sha256:" + "0" * 64, "name": "foreign", "expires_at": "2026-11-11T00:00:00Z"}[case]
            elif case == "size_in_bytes":
                item[case] += 1
            elif case == "expired":
                item[case] = True
            elif case == "owner":
                item["workflow_run"]["head_repository_id"] = 1
            elif case == "source":
                item["workflow_run"]["head_sha"] = r.CONTROL_BASE
            elif case == "missing":
                artifacts["artifacts"].pop()
            elif case == "duplicate":
                artifacts["artifacts"][-1] = copy.deepcopy(item)
            else:
                now = datetime.datetime(2026, 11, 13, 6, tzinfo=datetime.timezone.utc)
            with self.subTest(case=case), self.assertRaises(RuntimeError):
                r.validate_origin(run, jobs, artifacts, now)

    def test_input_rejects_other_recoveries_product_sources_and_changed_source_proof(self):
        r.validate_selection(selection_fixture())
        for key, value in [("source_sha", r.CONTROL_BASE), ("promote_release114_run_id", "40821076738"), ("publish", False),
                           ("linux_first", True), ("desktop_only", True), ("android_only", True), ("windows_only", True),
                           ("restore_android74", True), ("windows_candidate_only", True), ("continue_release75_run_id", "40821076738"),
                           ("recover_desktop_run_id", "39093205395"), ("source_proof_run_id", "1"),
                           ("source_proof_artifact_id", "1"), ("source_proof_digest", "sha256:" + "0" * 64)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                r.validate_selection({**selection_fixture(), key: value})
        with patch.dict(os.environ, {"PROMOTION_INPUTS": json.dumps({**selection_fixture(), "source_sha": r.CONTROL_BASE})}, clear=True), patch.object(r, "git") as git, patch.object(r, "api") as api:
            with self.assertRaises(RuntimeError):
                r.inspect()
            git.assert_not_called()
            api.assert_not_called()

    def test_control_delta_is_based_on_b7_and_rejects_product_or_deleted_control_files(self):
        changes = [["M", path] for path in sorted(r.ALLOWED_CONTROL_PATHS)]
        r.validate_control_paths(changes)
        for path in ["apps/web/src/routeTree.gen.ts", "apps/server/src/auth/RpcAuthorization.ts", "pnpm-lock.yaml", "scripts/morrowbyte/check.sh"]:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                r.validate_control_paths(changes + [["M", path]])
        for invalid in [[['D', path] for _, path in changes], [["M", r.WORKFLOW]], []]:
            with self.assertRaises(RuntimeError):
                r.validate_control_paths(invalid)
        env = {"CONTROL_SHA": "c" * 40, "GITHUB_SHA": "c" * 40, "GITHUB_WORKFLOW_SHA": "c" * 40,
               "GITHUB_REPOSITORY": r.REPO, "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": r.WORKFLOW_REF}
        def git(*args):
            if args == ("rev-parse", "HEAD"):
                return r.SOURCE
            if args[0] == "status":
                return ""
            self.assertEqual(args[:4], ("diff", "--no-renames", "--name-status", r.CONTROL_BASE))
            return "\n".join(status + "\t" + path for status, path in changes)
        with patch.dict(os.environ, env, clear=True), patch.object(r, "git", side_effect=git), patch.object(r, "digest", side_effect=[r.ORIGIN_WORKFLOW_SHA256, r.LOCK_SHA256, r.CHECK_SHA256]), patch.object(r.subprocess, "run") as run:
            r.validate_control()
            self.assertEqual(run.call_args_list[0].args[0], ["git", "merge-base", "--is-ancestor", r.SOURCE, r.CONTROL_BASE])
            self.assertEqual(run.call_args_list[1].args[0], ["git", "merge-base", "--is-ancestor", r.CONTROL_BASE, "c" * 40])

    def test_exact_existing_linux_bundle_path_keeps_original_bytes_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive, artifact = archive_fixture(root, [("morrowbyte-linux-x64.tar.gz", b"original bundle bytes")])
            r.extract_verified(archive, artifact, root / "assets")
            self.assertEqual((root / "assets/morrowbyte-linux-x64.tar.gz").read_bytes(), b"original bundle bytes")
            with self.assertRaises(RuntimeError):
                r.extract_verified(archive, artifact, root / "assets")
            artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(RuntimeError, "digest/length"):
                r.extract_verified(archive, artifact, root / "other")

    def test_zip_traversal_links_duplicates_case_collisions_and_bomb_limits_fail(self):
        for names in [["../escape"], ["/escape"], ["C:/escape"], ["a\\b"], ["a/./b"], ["a\nb"],
                      ["same", "same"], ["Same", "same"], ["file", "file/child"], [r.RECEIPT_NAME]]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive, artifact = archive_fixture(root, [(name, b"fixture") for name in names])
                with self.assertRaises(RuntimeError):
                    r.extract_verified(archive, artifact, root / "out", nested=True)
        for mode in [stat.S_IFLNK, stat.S_IFIFO]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                member = zipfile.ZipInfo("special")
                member.create_system = 3
                member.external_attr = (mode | 0o600) << 16
                archive, artifact = archive_fixture(root, [(member, b"fixture")])
                with self.assertRaisesRegex(RuntimeError, "special"):
                    r.extract_verified(archive, artifact, root / "out")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive, artifact = archive_fixture(root, [(str(i), b"") for i in range(257)])
            with self.assertRaisesRegex(RuntimeError, "oversized"):
                r.extract_verified(archive, artifact, root / "out")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive, artifact = archive_fixture(root, [("fixture", b"fixture")])
            with zipfile.ZipFile(archive) as original:
                members = original.infolist()
            members[0].file_size = 2_000_000_001
            with patch.object(r.zipfile, "ZipFile") as zipped:
                zipped.return_value.__enter__.return_value.infolist.return_value = members
                with self.assertRaisesRegex(RuntimeError, "oversized"):
                    r.extract_verified(archive, artifact, root / "out")

    def test_original_route_android_and_linux_proof_chain_is_not_relabelled_as_control(self):
        for case in [None, "preflight-owner", "startup-owner", "linux-image", "apk-receipt", "dependency", "extra-platform"]:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp, contextlib.chdir(ROOT):
                root = Path(temp)
                assets = root / "assets"
                assets.mkdir()
                route_sha, apk_sha, receipt_sha = proof_fixture(root, assets)
                if case == "preflight-owner":
                    path = root / "observatory-publish-preflight/receipt.json"
                    data = json.loads(path.read_bytes())
                    data["trustedWorkflowSha"] = r.CONTROL_BASE
                    path.write_text(json.dumps(data))
                elif case == "startup-owner":
                    path = root / "release114-android-startup/startup.json"
                    data = json.loads(path.read_bytes())
                    data["run"] = "700"
                    path.write_text(json.dumps(data))
                elif case == "linux-image":
                    (root / "release114-linux-startup/appimage.sha256").write_text("0" * 64)
                elif case == "apk-receipt":
                    (assets / f"Morrowbyte-{r.VERSION}-android-arm64.apk.json").write_text("{}")
                elif case == "dependency":
                    (root / "release114-android-evidence/morrowbyte-android-dependencies.txt").write_text("changed")
                elif case == "extra-platform":
                    (assets / "mac-arm64.dmg").write_text("out of scope")
                with patch.object(r, "ROUTE_SHA256", route_sha), patch.object(r, "APK_SHA256", apk_sha), patch.object(r, "APK_RECEIPT_SHA256", receipt_sha):
                    if case is None:
                        r.validate_proofs(root, assets)
                    else:
                        with self.assertRaises(RuntimeError):
                            r.validate_proofs(root, assets)

    def test_retained_receipt_binds_control_payload_and_all_original_proof_files(self):
        for case in [None, "payload", "proof", "receipt", "control", "extra-file"]:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp, patch.object(r.subprocess, "check_output", return_value=b"workflow fixture"):
                root = Path(temp)
                env = {"CONTROL_SHA": "c" * 40, "RUNNER_TEMP": temp}
                with patch.dict(os.environ, env, clear=True):
                    assets, receipt, path = receipt_fixture(root)
                    os.environ["PROMOTION114_RECEIPT_SHA256"] = r.digest(path)
                    if case == "payload":
                        (assets / "morrowbyte-linux-x64.tar.gz").write_text("changed")
                    elif case == "proof":
                        (root / "observatory-publish-build/receipt.json").write_text("changed")
                    elif case == "receipt":
                        path.write_text("{}")
                    elif case == "control":
                        os.environ["CONTROL_SHA"] = "d" * 40
                    elif case == "extra-file":
                        (assets / "unreviewed.exe").write_text("changed")
                    if case is None:
                        r.verify(assets)
                    else:
                        with self.assertRaises(RuntimeError):
                            r.verify(assets)

    def test_release_tag_draft_and_published_boundaries_do_not_permit_different_assets(self):
        source = {"type": "commit", "sha": r.SOURCE}
        release = {"tag_name": r.TAG, "target_commitish": r.SOURCE, "prerelease": True, "draft": True, "assets": []}
        r.validate_release(None, None)
        r.validate_release(release, None)
        r.validate_release({**release, "draft": False, "published_at": "2026-11-12T09:00:00Z"}, source)
        for changed in [{**release, "target_commitish": r.CONTROL_BASE}, {**release, "tag_name": "other"}, {**release, "prerelease": False}]:
            with self.assertRaises(RuntimeError):
                r.validate_release(changed, source)
        r.validate_release(None, source)
        with self.assertRaises(RuntimeError):
            r.validate_release(release, {"type": "commit", "sha": r.CONTROL_BASE})
        with tempfile.TemporaryDirectory() as temp:
            assets = Path(temp)
            (assets / "original").write_bytes(b"same payload")
            metadata = {**release, "assets": [{"name": "original", "digest": "sha256:" + r.digest(assets / "original")} ]}
            r.validate_release(metadata, source, assets)
            for name, sha in [("original", "sha256:" + "0" * 64), ("unknown", metadata["assets"][0]["digest"])]:
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    r.validate_release({**release, "assets": [{"name": name, "digest": sha}]}, source, assets)

    def test_partial_draft_retry_accepts_only_same_payload_promotion_and_checksum_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            assets = Path(temp)
            (assets / r.RECEIPT_NAME).write_bytes(b"same immutable control receipt")
            (assets / "SHA256SUMS").write_text("fixture checksum block\n")
            receipt = (f"fork_release={r.TAG}\nsource_sha={r.SOURCE}\npromotion_receipt_sha256={r.digest(assets / r.RECEIPT_NAME)}\n"
                       "artifact_sha256:\nfixture checksum block\n").encode()
            metadata = {"tag_name": r.TAG, "target_commitish": r.SOURCE, "prerelease": True, "draft": True,
                        "assets": [{"name": "RELEASE-RECEIPT.txt", "digest": "sha256:" + hashlib.sha256(receipt).hexdigest()}]}
            r.validate_release(metadata, None, assets, receipt)
            for changed in [receipt.replace(r.SOURCE.encode(), r.CONTROL_BASE.encode()),
                            receipt.replace(b"fixture checksum block", b"different block"),
                            receipt.replace(r.digest(assets / r.RECEIPT_NAME).encode(), b"0" * 64)]:
                current = copy.deepcopy(metadata)
                current["assets"][0]["digest"] = "sha256:" + hashlib.sha256(changed).hexdigest()
                with self.assertRaises(RuntimeError):
                    r.validate_release(current, None, assets, changed)
            with self.assertRaises(RuntimeError):
                r.validate_release(metadata, None, assets, b"changed")

    def test_boundary_resolves_tag404_draft_before_payload_and_receipt_upload(self):
        for case in [None, "payload", "promotion", "receipt-source", "receipt-checksums", "receipt-promotion", "receipt-digest"]:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                assets = Path(temp)
                (assets / "original").write_bytes(b"same payload")
                (assets / "pending").write_bytes(b"not uploaded yet")
                (assets / r.RECEIPT_NAME).write_bytes(b"same immutable control receipt")
                (assets / "SHA256SUMS").write_text("fixture checksum block\n")
                receipt = (f"fork_release={r.TAG}\nsource_sha={r.SOURCE}\npromotion_receipt_sha256={r.digest(assets / r.RECEIPT_NAME)}\n"
                           "artifact_sha256:\nfixture checksum block\n").encode()
                release, _, _, run = boundary_fixture()
                release["assets"] = [{"name": name, "digest": "sha256:" + r.digest(assets / name)} for name in ["original", r.RECEIPT_NAME]]
                release["assets"].append({"name": "RELEASE-RECEIPT.txt", "id": 456, "size": len(receipt), "digest": "sha256:" + hashlib.sha256(receipt).hexdigest()})
                if case in ["payload", "promotion"]:
                    release["assets"][0 if case == "payload" else 1]["digest"] = "sha256:" + "0" * 64
                elif case == "receipt-source":
                    receipt = receipt.replace(r.SOURCE.encode(), r.CONTROL_BASE.encode())
                elif case == "receipt-checksums":
                    receipt = receipt.replace(b"fixture checksum block", b"different block")
                elif case == "receipt-promotion":
                    receipt = receipt.replace(r.digest(assets / r.RECEIPT_NAME).encode(), b"0" * 64)
                elif case == "receipt-digest":
                    receipt += b"changed"
                if case != "receipt-digest":
                    release["assets"][-1].update(size=len(receipt), digest="sha256:" + hashlib.sha256(receipt).hexdigest())
                with patch.object(r.subprocess, "run", side_effect=run), patch.object(r.subprocess, "check_output", return_value=receipt) as read:
                    if case is None:
                        r.release_boundary(assets)
                    else:
                        with self.assertRaises(RuntimeError):
                            r.release_boundary(assets)
                    read.assert_called_once_with(["gh", "api", f"repos/{r.REPO}/releases/assets/456", "-H", "Accept: application/octet-stream"])

    def test_boundary_absence_requires_authenticated_complete_release_inventory(self):
        for case in [None, "paged", "existing-draft", "foreign-repo", "foreign-id", "no-write-access", "missing-permissions",
                     "repository-auth", "inventory-auth", "inventory-404", "inventory-transport", "inventory-json", "inventory-shape", "incomplete"]:
            with self.subTest(case=case):
                _, _, responses, run = boundary_fixture()
                lookup = next(key for key in responses if key[0] == "release")
                responses[lookup] = (1, b"", b"release not found\n")
                repo_key = ("api", f"repos/{r.REPO}/")
                inventory_key = ("api", f"repos/{r.REPO}/releases?per_page=100&page=1")
                repository = responses[repo_key][1]
                if case == "foreign-repo":
                    repository["full_name"] = "other/t3code"
                elif case == "foreign-id":
                    repository["id"] += 1
                elif case == "no-write-access":
                    repository["permissions"]["push"] = False
                elif case == "missing-permissions":
                    repository.pop("permissions")
                elif case == "repository-auth":
                    responses[repo_key] = (1, {"status": "401"}, b"bad credentials")
                elif case in ["inventory-auth", "inventory-404", "inventory-transport"]:
                    body = {"status": "403"} if case == "inventory-auth" else {"status": "404"} if case == "inventory-404" else b"transport failed"
                    responses[inventory_key] = (1, body, b"read failed")
                elif case == "inventory-json":
                    responses[inventory_key] = (0, b"{", b"")
                elif case == "inventory-shape":
                    responses[inventory_key] = (0, {}, b"")
                elif case in ["paged", "existing-draft", "incomplete"]:
                    full_page = [{"tag_name": f"other-{index}"} for index in range(100)]
                    responses[inventory_key] = (0, full_page, b"")
                    for page in range(2, 11 if case == "incomplete" else 3):
                        items = full_page if case == "incomplete" else [{"tag_name": r.TAG, "draft": True}] if case == "existing-draft" else []
                        responses[("api", f"repos/{r.REPO}/releases?per_page=100&page={page}")] = (0, items, b"")
                with patch.object(r.subprocess, "run", side_effect=run), patch.object(r.subprocess, "check_output") as read:
                    if case in [None, "paged"]:
                        r.release_boundary()
                    else:
                        with self.assertRaises((RuntimeError, ValueError)):
                            r.release_boundary()
                    read.assert_not_called()

    def test_boundary_rejects_lookup_errors_and_inconsistent_canonical_identity(self):
        cases = ["lookup-auth", "lookup-transport", "lookup-json", "lookup-shape", "lookup-tag", "lookup-source", "lookup-draft",
                 "foreign-repo", "foreign-host", "invalid-id", "url-query", "api-auth", "api-404", "api-transport", "api-json",
                 "api-id", "api-url", "api-tag", "api-source", "published-during-lookup"]
        for case in cases:
            with self.subTest(case=case):
                release, view, responses, run = boundary_fixture()
                lookup = next(key for key in responses if key[0] == "release")
                metadata_key = ("api", f"repos/{r.REPO}/releases/123")
                if case in ["lookup-auth", "lookup-transport"]:
                    responses[lookup] = (1, b"", b"HTTP 401: bad credentials" if case == "lookup-auth" else b"transport failed")
                elif case in ["lookup-json", "lookup-shape"]:
                    responses[lookup] = (0, b"{" if case == "lookup-json" else [], b"")
                elif case == "lookup-tag":
                    view["tagName"] = "other"
                elif case == "lookup-source":
                    view["targetCommitish"] = r.CONTROL_BASE
                elif case == "lookup-draft":
                    view["isDraft"] = "true"
                elif case in ["foreign-repo", "foreign-host", "invalid-id", "url-query"]:
                    view["apiUrl"] = {"foreign-repo": "https://api.github.com/repos/other/t3code/releases/123",
                                      "foreign-host": f"https://example.com/repos/{r.REPO}/releases/123",
                                      "invalid-id": f"https://api.github.com/repos/{r.REPO}/releases/0",
                                      "url-query": view["apiUrl"] + "?other=1"}[case]
                elif case in ["api-auth", "api-404", "api-transport"]:
                    body = {"status": "403"} if case == "api-auth" else {"status": "404"} if case == "api-404" else b"transport failed"
                    responses[metadata_key] = (1, body, b"read failed")
                elif case == "api-json":
                    responses[metadata_key] = (0, b"{", b"")
                elif case == "api-id":
                    release["id"] += 1
                elif case == "api-url":
                    release["url"] = f"https://api.github.com/repos/{r.REPO}/releases/124"
                elif case == "api-tag":
                    release["tag_name"] = "other"
                elif case == "api-source":
                    release["target_commitish"] = r.CONTROL_BASE
                else:
                    release.update(draft=False, published_at="2026-11-12T09:00:00Z")
                with patch.object(r.subprocess, "run", side_effect=run), patch.object(r.subprocess, "check_output") as read:
                    with self.assertRaises((RuntimeError, ValueError)):
                        r.release_boundary()
                    read.assert_not_called()

    def test_only_explicit_http404_is_absence(self):
        with patch.object(r.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b'{"status":"404"}', b"")):
            self.assertIsNone(r.api("releases/tags/" + r.TAG, optional=True))
            with self.assertRaises(RuntimeError):
                r.api("actions/runs/" + r.ORIGIN_RUN)
        for body in [b'{"status":"403"}', b'{"status":"500"}', b"transport failed"]:
            with patch.object(r.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, body, b"")), self.assertRaises(RuntimeError):
                r.api("releases/tags/" + r.TAG, optional=True)

    def test_workflow_promotion_runs_only_inspection_and_existing_linux_publisher(self):
        workflow = load_workflow()
        defaults = {key: value.get("default", "") for key, value in workflow["on"]["workflow_dispatch"]["inputs"].items()}
        inputs = {**defaults, **selection_fixture()}
        needs = {name: {"result": "skipped", "outputs": {}} for name in workflow["jobs"]}
        needs["promotion114"]["result"] = "success"
        for name, job in workflow["jobs"].items():
            self.assertEqual(condition(job["if"], inputs, needs), name in {"promotion114", "publish_linux_first"}, name)
        needs["promotion114"]["result"] = "failure"
        self.assertFalse(condition(workflow["jobs"]["publish_linux_first"]["if"], inputs, needs))
        inputs["publish"] = False
        self.assertFalse(condition(workflow["jobs"]["publish_linux_first"]["if"], inputs, needs))
        normal = {**defaults, "linux_first": True, "publish": True}
        for name in ["preflight", "build_bundle", "build_linux", "build_nixos", "build_android_apk"]:
            needs[name]["result"] = "success"
        needs["promotion114"]["result"] = "skipped"
        self.assertTrue(condition(workflow["jobs"]["publish_linux_first"]["if"], normal, needs))
        self.assertEqual(workflow["concurrency"], {"group": "morrowbyte-desktop-nightly", "cancel-in-progress": False})
        inspect = workflow["jobs"]["promotion114"]
        self.assertNotIn("needs", inspect)
        self.assertEqual(inspect["steps"][0]["with"]["ref"], "${{ inputs.source_sha }}")
        self.assertIn("${{ github.workflow_sha }}", inspect["steps"][1]["env"]["CONTROL_SHA"])
        self.assertNotIn("source-proof.cjs", str(inspect))
        publisher = workflow["jobs"]["publish_linux_first"]
        steps = {step.get("name"): step for step in publisher["steps"]}
        for name in ["Download dedicated release assets", "Download Observatory preflight proof for publication", "Download Observatory build proof for publication"]:
            self.assertIn("inputs.promote_release114_run_id == ''", steps[name]["if"])
        self.assertIn("recover", steps["Recover the pinned .114 bytes and original proofs"]["run"])
        self.assertIn("verifySourceProof", steps["Reauthenticate the original full SourceProof without rerunning qualification"]["run"])
        self.assertNotIn("vp run", str(inspect))
        self.assertNotIn("source-proof.cjs complete", str(publisher))
        for name in ["publish", "publish_linux_first"]:
            steps = {step.get("name"): step for step in workflow["jobs"][name]["steps"]}
            loader = steps["Load closure verifier from immutable workflow source"]
            self.assertEqual(loader["env"]["CONTROL_SHA"], "${{ github.workflow_sha }}")
            payload = steps["Verify isolated release payload"]["run"]
            self.assertIn('bash "$RUNNER_TEMP/verify-nixos-closure.sh" --import', payload)
            self.assertIn('release-assets "${{ ', payload)
            self.assertIn("outputs.source_sha", payload)
            self.assertIn("release-assets/morrowbyte-linux-x64.tar.gz", payload)
            self.assertNotIn("build-nixos-closure.sh", payload)
            self.assertEqual(steps["Verify isolated release payload"]["env"]["TMPDIR"], "${{ runner.temp }}")
            self.assertIn("temporary_bytes = export + 1", steps["Check isolated publisher capacity for export spool and closure"]["run"])


if __name__ == "__main__":
    unittest.main()
