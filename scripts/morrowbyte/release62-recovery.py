#!/usr/bin/env python3
"""One-cut recovery for the failed .62 Windows package; no generic recovery mode."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import zipfile

SOURCE = "01102e1d064e371033bbd9782bc8f2ac20c7b3ad"
ORIGIN_RUN = "39537119530"
VERSION = "0.1.2-nightly.20261021.62"
REPO = "morrowbyte/t3code"
WORKFLOW = ".github/workflows/morrowbyte-release62-recovery.yml"
ORIGIN_WORKFLOW = ".github/workflows/morrowbyte-release.yml"
ORIGIN_WORKFLOW_SHA256 = "36a9673b2d37b36b9131ba8a4dfc893777fac6b22c1993e48b0581f4326d4f5d"
LOCK_SHA256 = "e58efebfbcc2e7601e0459343b97fc033b67e665b416596119ac7647d7a4abb1"
ROUTE_SHA256 = "fa1b95cb16c59c5a6bf92647b1bb3f3ab872c4cb06ef7a0e5e723775fb5c3dcc"
PACKAGING_SHA256 = "537a26500a69adb09690a68af0e98cf8e822e0bbc428308fb229eb05d462829d"
PACKAGING_TEST_SHA256 = "46974cac0c2414b170f78be368ff8c8eee1bf0921fb14169b0b12db3836acc1a"
ALLOWED_TOOLING = {WORKFLOW, "scripts/morrowbyte/release62-recovery.py", "scripts/morrowbyte/release62-recovery.test.py", "scripts/morrowbyte/test.sh", "scripts/build-desktop-artifact.ts", "scripts/build-desktop-artifact.test.ts"}
ARTIFACTS = {'12318601381': {'name': 'morrowbyte-observatory-build-01102e1d064e371033bbd9782bc8f2ac20c7b3ad-1', 'digest': 'sha256:e546bfe35c42a17c1e84f74814b3f1cf0f42703b3e1e9b366557787430f0bf74', 'size_in_bytes': 4107, 'expires_at': '2026-10-28T03:14:27Z'}, '12318462143': {'name': 'morrowbyte-release-linux', 'digest': 'sha256:697e18acee18f30b0783eea1b728a118db31467873774389a7acba90fde42ea6', 'size_in_bytes': 360661420, 'expires_at': '2026-10-22T03:17:12Z'}, '12318277967': {'name': 'morrowbyte-release-nixos', 'digest': 'sha256:0f752852751859f718dad30f4f14e1fd337ceec469b81b4ddf4a378b32af27b0', 'size_in_bytes': 370920901, 'expires_at': '2026-10-22T03:18:38Z'}, '12318262084': {'name': 'morrowbyte-js-bundle', 'digest': 'sha256:fe8c4b43cd9c995e2e863be8f9490184c611f30c0014cc20bddf1943b5280849', 'size_in_bytes': 56356251, 'expires_at': '2026-10-22T03:14:28Z'}, '12318137293': {'name': 'morrowbyte-observatory-preflight-01102e1d064e371033bbd9782bc8f2ac20c7b3ad-1', 'digest': 'sha256:a1327d8e43803c89559f2b157057c7a0898cdd1444fcd0255a76ed29c04db5fb', 'size_in_bytes': 4452, 'expires_at': '2026-10-28T03:13:09Z'}, '12318098003': {'name': 'morrowbyte-release-cli-linux', 'digest': 'sha256:26dbfc4337e35854f106c77f99bd4920b927939f4c6c276048aae0304439e86f', 'size_in_bytes': 112049857, 'expires_at': '2026-10-22T03:17:19Z'}, '12317657922': {'name': 'morrowbyte-android-build-evidence-01102e1d064e371033bbd9782bc8f2ac20c7b3ad-1', 'digest': 'sha256:8e38c15c2354a2803bd8ac72c3195f70fc414198a841326298828a64cf2fb512', 'size_in_bytes': 19120, 'expires_at': '2026-10-28T03:20:39Z'}, '12317643042': {'name': 'morrowbyte-release-android', 'digest': 'sha256:c479ce6ab8f8c7050ae9e95c269ff2e52eb2c13f7bca7926d9206e7a06623fd0', 'size_in_bytes': 56293459, 'expires_at': '2026-10-28T03:20:36Z'}}
JOBS = {"preflight": "success", "build_bundle": "success", "build_linux": "success", "build_nixos": "success", "build_windows": "failure", "Build Morrowbyte Android APK": "success", "publish": "skipped", "publish_android": "skipped", "publish_windows": "skipped"}


VERIFIED_STEPS = {
    "preflight": ["Check source before release", "Verify reviewed Observatory preflight route"],
    "Build Morrowbyte Android APK": ["Build signed standalone arm64 APK once", "Verify APK signature, embedded bundle, identity and 16KB native alignment"],
    "build_bundle": ["Bind independently built Observatory route"],
    "build_linux": ["Package and smoke-test Linux CLI archive"],
    "build_nixos": ["Build immutable NixOS closure on Blacksmith"],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def api(suffix):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPO}/" + suffix]))


def validate_origin(run, jobs, metadata, now):
    require(run["id"] == int(ORIGIN_RUN) and run["run_number"] == 62 and run["run_attempt"] == 1, "Wrong origin run/version/attempt")
    require(run["repository"]["full_name"] == run["head_repository"]["full_name"] == REPO, "Foreign origin")
    require(run["head_sha"] == SOURCE and run["head_branch"] == "main" and run["event"] == "workflow_dispatch" and run["path"] == ORIGIN_WORKFLOW, "Wrong origin source/workflow")
    require(run["status"] == "completed" and run["conclusion"] == "failure", "Origin is not the terminal failed run")
    require(jobs["total_count"] == len(jobs["jobs"]) == len(JOBS), "Incomplete origin jobs")
    require({j["name"]: j["conclusion"] for j in jobs["jobs"]} == JOBS, "Unexpected origin job conclusions")
    require(all(j["head_sha"] == SOURCE and j["status"] == "completed" for j in jobs["jobs"]), "Wrong job source/state")
    for job_name, step_names in VERIFIED_STEPS.items():
        job = next(j for j in jobs["jobs"] if j["name"] == job_name)
        for step_name in step_names:
            matches = [step for step in job["steps"] if step["name"] == step_name]
            require(len(matches) == 1 and matches[0]["conclusion"] == "success", "Original verification step did not pass: " + step_name)
    windows = next(j for j in jobs["jobs"] if j["name"] == "build_windows")
    require([s["name"] for s in windows["steps"] if s["conclusion"] == "failure"] == ["Build Windows x64 installer and updater metadata"], "Unexpected failed Windows step")
    artifacts = metadata["artifacts"]
    require(metadata["total_count"] == len(artifacts) == len(ARTIFACTS), "Incomplete artifact inventory")
    require({str(a["id"]) for a in artifacts} == set(ARTIFACTS), "Changed origin artifact IDs")
    for artifact in artifacts:
        pin = ARTIFACTS[str(artifact["id"])]
        require(all(artifact[key] == value for key, value in pin.items()), "Changed artifact name/digest/size/expiry")
        require(not artifact["expired"] and datetime.datetime.fromisoformat(artifact["expires_at"].replace("Z", "+00:00")) > now, "Origin artifact expired")
        owner = artifact["workflow_run"]
        require(owner["id"] == int(ORIGIN_RUN) and owner["head_sha"] == SOURCE, "Wrong artifact workflow owner")
        require(owner["repository_id"] == owner["head_repository_id"] == run["repository"]["id"], "Foreign artifact repository")
    return artifacts


def validate_tooling_changes(changed, packaging_hash, test_hash):
    require(set(changed) == ALLOWED_TOOLING, "Application/lock/auth source changed outside reviewed recovery tooling")
    require(packaging_hash == PACKAGING_SHA256 and test_hash == PACKAGING_TEST_SHA256, "Wrong validator/test bytes")


def extract_verified(archive_path, artifact, target, bundle=False):
    require(Path(archive_path).stat().st_size == artifact["size_in_bytes"] and "sha256:" + digest(archive_path) == artifact["digest"], "Origin ZIP bytes do not match pinned digest/length")
    target.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        require(sum(m.file_size for m in archive.infolist()) <= 4 * 1024**3, "Oversized artifact expansion")
        for member in archive.infolist():
            relative = PurePosixPath(member.filename)
            require(bool(relative.parts) and not relative.is_absolute() and ".." not in relative.parts and "\\" not in member.filename and ":" not in member.filename, "Unsafe ZIP path")
            require(not stat.S_ISLNK(member.external_attr >> 16), "ZIP symlink")
            if bundle:
                require(relative.parts[:2] in {("server", "dist"), ("desktop", "dist-electron")}, "Unexpected bundle path")
            else:
                require(member.filename == relative.name and not member.is_dir(), "Non-flat payload")
            destination = target / relative
            if member.filename == "builder-debug.yml":
                require(artifact["name"] == "morrowbyte-release-linux", "Unexpected debug metadata")
                destination = target / "morrowbyte-release-linux-builder-debug.yml"
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as incoming, destination.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)


def validate_proofs(root):
    pre = json.loads((root / "observatory-route-generation/receipt.json").read_bytes())
    built = json.loads((root / "observatory-release-build/receipt.json").read_bytes())
    ref = REPO + "/" + ORIGIN_WORKFLOW + "@refs/heads/main"
    for proof in [pre, built]:
        require(proof["source"] == proof["trustedContextSha"] == proof["trustedWorkflowSha"] == SOURCE, "Wrong route proof source")
        require(proof["run"] == ORIGIN_RUN and proof["attempt"] == "1" and proof["trustedWorkflowRef"] == ref and proof["lockSha256"] == LOCK_SHA256, "Wrong route proof owner/lock")
    require(pre["status"] == "generated-unreviewed" and pre["effectiveSourceSha"] == SOURCE, "Wrong route generation state")
    require(pre["generatorVersion"] == "1.167.12" and pre["config"] == {"autoCodeSplitting": True}, "Wrong route generator")
    require(pre["checkScriptSha256"] == digest("scripts/morrowbyte/check.sh") and pre["beforeSha256"] == digest("apps/web/src/routeTree.gen.ts"), "Wrong route input/check source")
    require(pre["afterSha256"] == built["generatedRouteSha256"] == ROUTE_SHA256, "Wrong generated route")
    for directory in ["observatory-route-generation", "observatory-release-build"]:
        require(digest(root / directory / "routeTree.gen.ts") == ROUTE_SHA256, "Wrong generated route bytes")
    require(built["preflightReceiptSha256"] == digest(root / "observatory-route-generation/receipt.json") and (root / "observatory-route-generation/routeTree.diff").is_file(), "Broken route proof chain")
    assets = root / "recovered-platforms"
    name = f"Morrowbyte-{VERSION}-android-arm64.apk"
    receipt_path = assets / (name + ".json")
    receipt = json.loads(receipt_path.read_bytes())
    apk_hash = digest(assets / name)
    expected = {"schemaVersion": 1, "source": SOURCE, "desktopSource": SOURCE, "version": VERSION, "versionCode": 62, "run": ORIGIN_RUN, "attempt": "1", "trustedContextSha": SOURCE, "trustedWorkflowSha": SOURCE, "trustedWorkflowRef": ref, "lockSha256": LOCK_SHA256, "apk": name, "apkSha256": apk_hash, "package": "com.morrowbyte.t3code", "name": "Morrowbyte", "certificateSha256": "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2", "abis": ["arm64-v8a"], "signatureVerified": True, "zip16KB": True, "elf16KB": True, "deviceAcceptance": "not-run"}
    require(all(receipt.get(k) == v for k, v in expected.items()), "Wrong APK provenance/signature/identity proof")
    require((assets / (name + ".sha256")).read_text() == f"{apk_hash}  {name}\n", "Wrong APK checksum sidecar")
    return apk_hash, digest(receipt_path)


def recover():
    require(os.environ["GITHUB_REPOSITORY"] == REPO and os.environ["SOURCE_SHA"] == SOURCE and os.environ["ORIGIN_RUN_ID"] == ORIGIN_RUN, "Wrong recovery request")
    require(os.environ["GITHUB_REF"] == "refs/heads/main" and os.environ["GITHUB_WORKFLOW_REF"] == REPO + "/" + WORKFLOW + "@refs/heads/main", "Wrong recovery workflow/ref")
    control = os.environ["GITHUB_SHA"]
    require(control == os.environ["GITHUB_WORKFLOW_SHA"] and os.environ["GITHUB_RUN_ATTEMPT"] == "1", "Wrong tooling pin or repeated recovery attempt")
    require(git("rev-parse", "HEAD") == SOURCE and not git("status", "--porcelain", "--untracked-files=all"), "Application checkout must be exact and clean")
    subprocess.run(["git", "fetch", "--no-tags", "origin", "main"], check=True)
    require(git("rev-parse", "FETCH_HEAD") == control, "Recovery tooling is no longer current main")
    subprocess.run(["git", "merge-base", "--is-ancestor", SOURCE, control], check=True)
    changed = set(git("diff", "--name-only", SOURCE, control).splitlines())
    validate_tooling_changes(changed,
        hashlib.sha256(subprocess.check_output(["git", "show", control + ":scripts/build-desktop-artifact.ts"])).hexdigest(),
        hashlib.sha256(subprocess.check_output(["git", "show", control + ":scripts/build-desktop-artifact.test.ts"])).hexdigest())
    require(digest("pnpm-lock.yaml") == LOCK_SHA256 and digest(ORIGIN_WORKFLOW) == ORIGIN_WORKFLOW_SHA256, "Wrong original app lock/workflow")
    ci = api(f"actions/workflows/morrowbyte-ci.yml/runs?head_sha={control}&event=push&branch=main&per_page=100")
    candidates = ci["workflow_runs"]
    require(candidates and ci["total_count"] == len(candidates), "Missing/incomplete tooling main CI")
    latest = max(candidates, key=lambda r: r["id"])
    require(latest["status"] == "completed" and latest["conclusion"] == "success" and latest["head_sha"] == control and latest["head_branch"] == "main" and latest["event"] == "push" and latest["path"] == ".github/workflows/morrowbyte-ci.yml" and latest["head_repository"]["full_name"] == REPO, "Tooling main CI not qualified")
    ci_jobs = api(f"actions/runs/{latest['id']}/attempts/{latest['run_attempt']}/jobs?per_page=100")
    require(ci_jobs["total_count"] == len(ci_jobs["jobs"]), "Incomplete tooling CI jobs")
    for name in ["check", "windows_installer_guard"]:
        matches = [j for j in ci_jobs["jobs"] if j["name"] == name]
        require(len(matches) == 1 and matches[0]["status"] == "completed" and matches[0]["conclusion"] == "success", "Required tooling CI job not successful")
    runs = api("actions/workflows/morrowbyte-release62-recovery.yml/runs?event=workflow_dispatch&per_page=100")
    require(runs["total_count"] == len(runs["workflow_runs"]) == 1 and str(runs["workflow_runs"][0]["id"]) == os.environ["GITHUB_RUN_ID"], "Recovery is one-shot; no duplicate dispatch or retry")
    for page in range(1, 11):
        releases = api(f"releases?per_page=100&page={page}")
        require(not any(item["tag_name"] == "v" + VERSION for item in releases), "Release already exists; reconcile without a new Windows build")
        if len(releases) < 100:
            break
        require(page < 10, "Incomplete release observation")
    tag_refs = git("ls-remote", "origin", "refs/tags/v" + VERSION, "refs/tags/v" + VERSION + "^{}")
    if tag_refs:
        resolved = {line.split()[1]: line.split()[0] for line in tag_refs.splitlines()}
        require(resolved.get("refs/tags/v" + VERSION + "^{}", resolved.get("refs/tags/v" + VERSION)) == SOURCE, "Existing release tag has a different source")
    run = api(f"actions/runs/{ORIGIN_RUN}")
    jobs = api(f"actions/runs/{ORIGIN_RUN}/attempts/1/jobs?per_page=100")
    metadata = api(f"actions/runs/{ORIGIN_RUN}/artifacts?per_page=100")
    artifacts = validate_origin(run, jobs, metadata, datetime.datetime.now(datetime.timezone.utc))
    root = Path(os.environ["RUNNER_TEMP"])
    destinations = {"morrowbyte-release-linux": "recovered-platforms", "morrowbyte-release-nixos": "recovered-platforms", "morrowbyte-release-android": "recovered-platforms", "morrowbyte-release-cli-linux": "recovered-cli-linux", "morrowbyte-js-bundle": "recovered-js-bundle", f"morrowbyte-observatory-preflight-{SOURCE}-1": "observatory-route-generation", f"morrowbyte-observatory-build-{SOURCE}-1": "observatory-release-build"}
    for artifact in artifacts:
        name = artifact["name"]
        if name not in destinations:
            continue
        archive = root / (str(artifact["id"]) + ".zip")
        with archive.open("xb") as output:
            subprocess.run(["gh", "api", f"repos/{REPO}/actions/artifacts/{artifact['id']}/zip"], stdout=output, check=True)
        extract_verified(archive, artifact, root / destinations[name], bundle=name == "morrowbyte-js-bundle")
        archive.unlink()
    apk_hash, apk_receipt_hash = validate_proofs(root)
    workflow_hash = hashlib.sha256(subprocess.check_output(["git", "show", control + ":" + WORKFLOW])).hexdigest()
    files = [{"name": f.name, "sha256": digest(f)} for d in ["recovered-platforms", "recovered-cli-linux"] for f in sorted((root / d).iterdir())]
    receipt = {"schemaVersion": 1, "source": SOURCE, "version": VERSION, "originRun": ORIGIN_RUN, "originAttempt": "1", "originWorkflowSha": SOURCE, "originWorkflowRef": REPO + "/" + ORIGIN_WORKFLOW + "@refs/heads/main", "originWorkflowSha256": ORIGIN_WORKFLOW_SHA256, "controlSource": control, "controlWorkflowSha256": workflow_hash, "windowsPackagingScriptSha256": PACKAGING_SHA256, "publicationRun": os.environ["GITHUB_RUN_ID"], "publicationAttempt": "1", "changedPaths": sorted(changed), "originArtifacts": artifacts, "files": files}
    receipt_path = root / "recovered-platforms/WINDOWS-RECOVERY.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    outputs = {"source_sha": SOURCE, "version": VERSION, "android_version_code": "62", "tag": "v" + VERSION, "observatory_route_sha256": ROUTE_SHA256, "desktop_run_id": ORIGIN_RUN, "desktop_run_attempt": "1", "desktop_context_sha": SOURCE, "desktop_workflow_sha": SOURCE, "desktop_workflow_ref": REPO + "/" + ORIGIN_WORKFLOW + "@refs/heads/main", "recovery_artifact_attempt": "1", "recovery_workflow_sha256": workflow_hash, "windows_packaging_sha256": PACKAGING_SHA256, "windows_recovery_receipt_sha256": digest(receipt_path), "android_source_sha": SOURCE, "android_lock_sha256": LOCK_SHA256, "recovered_apk_sha256": apk_hash, "recovered_apk_receipt_sha256": apk_receipt_hash}
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key, value in outputs.items():
            output.write(f"{key}={value}\n")


def verify_retained():
    assets = Path("release-assets")
    receipt_path = assets / "WINDOWS-RECOVERY.json"
    require(digest(receipt_path) == os.environ["RECOVERY_RECEIPT_SHA256"], "Changed recovery receipt")
    receipt = json.loads(receipt_path.read_bytes())
    require(receipt["source"] == SOURCE and receipt["version"] == VERSION and receipt["originRun"] == ORIGIN_RUN and receipt["originAttempt"] == "1", "Wrong retained source/version/run")
    require(receipt["controlSource"] == os.environ["GITHUB_SHA"] and receipt["publicationRun"] == os.environ["GITHUB_RUN_ID"] and receipt["publicationAttempt"] == os.environ["GITHUB_RUN_ATTEMPT"] == "1", "Wrong recovery ownership")
    require(receipt["windowsPackagingScriptSha256"] == PACKAGING_SHA256, "Wrong Windows validator")
    for item in receipt["files"]:
        require(Path(item["name"]).name == item["name"] and digest(assets / item["name"]) == item["sha256"], "Retained platform bytes changed")


if __name__ == "__main__":
    require(len(sys.argv) == 2 and sys.argv[1] in {"recover", "verify"}, "Expected recover or verify")
    recover() if sys.argv[1] == "recover" else verify_retained()
