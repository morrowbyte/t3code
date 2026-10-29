#!/usr/bin/env python3
"""One-shot .75 continuation; reuse desktop bytes and build only missing Android."""
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

SOURCE = "83ae356a59143e1f6867ea29cc40040add10917c"
ORIGIN_RUN = "40821076738"
VERSION = "0.1.5-nightly.20261029.75"
REPO = "morrowbyte/t3code"
REPO_ID = 1175532637
WORKFLOW = ".github/workflows/morrowbyte-release.yml"
WORKFLOW_REF = REPO + "/" + WORKFLOW + "@refs/heads/main"
WORKFLOW_SHA256 = "1a2ddfed0e2ffa2a926eb31a7b4fe9779e07093dd55e23a370038231ea797e21"
LOCK_SHA256 = "e80572435e54e7b01eee9b5185e2c6570cc3f932096fbeb39a47b2790d72d9f8"
ROUTE_SHA256 = "85c3ccb2aeea23ad1b8a989a418f5e19e7c80a78643f8a41eb15f394aa57d531"
CHECK_SHA256 = "f9a5b3f615b04377cb39dbd1601b378215ae253abe211d4c1b9e2bc41e2aeda9"
RECEIPT_NAME = "RELEASE75-RECOVERY.json"
ALLOWED_CONTROL_PATHS = {WORKFLOW, "scripts/morrowbyte/release75-continuation.py",
                         "scripts/morrowbyte/release75-continuation.test.py", "scripts/morrowbyte/check.sh"}
ARTIFACTS = {
    "12875195395": {"name": "morrowbyte-js-bundle", "digest": "sha256:1b125a6eb1bf7d45770766b34004b13577ff7a3c984e722c3bafb7973374ec48", "size_in_bytes": 90238376, "expires_at": "2026-10-30T05:07:32Z"},
    "12875116988": {"name": "morrowbyte-release-cli-windows", "digest": "sha256:c16c7aef3049f31075e473f0fb1fb397ff77775c0aa20f428ab6010112ff0b9d", "size_in_bytes": 139655856, "expires_at": "2026-10-30T05:15:41Z"},
    "12874927234": {"name": "morrowbyte-release-nixos", "digest": "sha256:3c476c5a05ec328a645171069e856921787c91849ee9c1b0c68ff3cf7dd22727", "size_in_bytes": 381040752, "expires_at": "2026-10-30T05:11:26Z"},
    "12874658646": {"name": "morrowbyte-release-linux", "digest": "sha256:223e2b2de11dec49e86c77ec03385d2fa5c76a3097b715d6e3f43d9f58d4d2bb", "size_in_bytes": 383311388, "expires_at": "2026-10-30T05:10:09Z"},
    "12874614840": {"name": "morrowbyte-release-windows", "digest": "sha256:548ed673b21b95c80315a1a4fe95778800ce951fbd59ec991db0d7c53acc0f54", "size_in_bytes": 347873736, "expires_at": "2026-10-30T05:15:31Z"},
    "12874432658": {"name": "morrowbyte-observatory-preflight-" + SOURCE + "-1", "digest": "sha256:3391f4d10b48340e0b2c32500d20795f106f93a37c3c1d7a16ccd86b127be3a8", "size_in_bytes": 5379, "expires_at": "2026-11-05T05:06:14Z"},
    "12874209849": {"name": "morrowbyte-observatory-build-" + SOURCE + "-1", "digest": "sha256:3577c83e340962b167500ea3f8086b849e7efa7d43c9df3504a5caf25d6d32aa", "size_in_bytes": 5018, "expires_at": "2026-11-05T05:07:30Z"},
    "12873834927": {"name": "morrowbyte-release-cli-linux", "digest": "sha256:ef61e4a555819a0956a283b2fbc25d2fcbfdb78f07fb40b5bd07bce73f86e25f", "size_in_bytes": 160967285, "expires_at": "2026-10-30T05:10:16Z"},
}
PLATFORM_IDS = tuple(key for key, pin in ARTIFACTS.items() if pin["name"].startswith("morrowbyte-release-"))
PROOF_IDS = {"preflight": "12874432658", "build": "12874209849"}
ANDROID_JOB = "Build Morrowbyte Android APK"
FAILED_STEP = "Bind source and verify standalone fork configuration"
JOBS = {"preflight": (123273441483, "success"), ANDROID_JOB: (123274621892, "failure"),
        "build_bundle": (123274621982, "success"), "publish_android": (123275016464, "skipped"),
        "build_linux": (123275043123, "success"), "build_nixos": (123275857877, "success"),
        "build_windows": (123275858003, "success"), "publish": (123277514513, "skipped"),
        "publish_windows": (123277515021, "skipped")}
VERIFIED_STEPS = {
    "preflight": ["Check source before release", "Verify reviewed Observatory preflight route"],
    "build_bundle": ["Bind independently built Observatory route", "Upload shared assets"],
    "build_linux": ["Package and smoke-test Linux CLI archive", "Upload Linux release assets", "Upload Linux CLI archive"],
    "build_nixos": ["Build immutable NixOS closure on Blacksmith"],
    "build_windows": ["Build Windows x64 installer and updater metadata", "Package and smoke-test Windows CLI archive",
                      "Upload Windows release assets", "Upload Windows CLI archive"],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def api(suffix):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPO}/" + suffix]))


def validate_origin(run, jobs, metadata, now):
    require(run["id"] == int(ORIGIN_RUN) and run["run_number"] == 10 and run["run_attempt"] == 1, "Wrong origin run/attempt")
    require(all(run[key]["full_name"] == REPO and run[key]["id"] == REPO_ID for key in ["repository", "head_repository"]), "Foreign origin")
    require(run["head_sha"] == SOURCE and run["head_branch"] == "main" and run["event"] == "workflow_dispatch" and run["path"] == WORKFLOW, "Wrong origin source/workflow")
    require(run["status"] == "completed" and run["conclusion"] == "failure", "Origin is not terminal")
    require(jobs["total_count"] == len(jobs["jobs"]) == len(JOBS), "Incomplete origin jobs")
    require({job["name"]: (job["id"], job["conclusion"]) for job in jobs["jobs"]} == JOBS, "Unexpected origin jobs")
    for job in jobs["jobs"]:
        require(job["status"] == "completed" and job["head_sha"] == SOURCE and job["run_id"] == int(ORIGIN_RUN) and job["run_attempt"] == 1, "Wrong job source/attempt/state")
        for step_name in VERIFIED_STEPS.get(job["name"], []):
            matches = [step for step in job["steps"] if step["name"] == step_name]
            require(len(matches) == 1 and matches[0]["conclusion"] == "success", "Missing successful origin verification: " + step_name)
        if job["name"] == ANDROID_JOB:
            require([step["name"] for step in job["steps"] if step["conclusion"] == "failure"] == [FAILED_STEP], "Unexpected Android failure")
    artifacts = metadata["artifacts"]
    require(metadata["total_count"] == len(artifacts) == len(ARTIFACTS), "Incomplete artifact inventory")
    require({str(a["id"]) for a in artifacts} == set(ARTIFACTS), "Changed artifact IDs")
    for artifact in artifacts:
        require(all(artifact[key] == value for key, value in ARTIFACTS[str(artifact["id"])].items()), "Changed artifact pin")
        require(not artifact["expired"] and datetime.datetime.fromisoformat(artifact["expires_at"].replace("Z", "+00:00")) > now, "Expired origin artifact")
        owner = artifact["workflow_run"]
        require(owner["id"] == int(ORIGIN_RUN) and owner["head_sha"] == SOURCE and owner["repository_id"] == owner["head_repository_id"] == REPO_ID, "Wrong artifact owner")


def validate_control_paths(changed):
    require(set(changed) == ALLOWED_CONTROL_PATHS, "Application/lock/packaging changed outside the four reviewed control paths")


def validate_unique(runs, releases, tag_refs, current_run):
    require(not tag_refs and not any(item["tag_name"] == "v" + VERSION for item in releases), "Version already exists")
    require(runs["total_count"] == len(runs["workflow_runs"]), "Incomplete continuation inventory")
    later = [run for run in runs["workflow_runs"] if run["id"] > int(ORIGIN_RUN)]
    require(len(later) == 1 and str(later[0]["id"]) == current_run, "A second continuation exists")


def retained_name(original_name, artifact):
    if original_name == "builder-debug.yml":
        artifact_id = str(artifact["id"])
        require(artifact_id in {"12874658646", "12874614840"}
                and artifact.get("name") == ARTIFACTS[artifact_id]["name"], "Unexpected builder-debug producer")
        return artifact["name"] + "-builder-debug.yml"
    return original_name


def extract_verified(archive_path, artifact, target):
    require(archive_path.stat().st_size == artifact["size_in_bytes"] and "sha256:" + digest(archive_path) == artifact["digest"], "Original ZIP digest/length differs")
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        require(members and sum(member.file_size for member in members) <= 3_000_000_000, "Empty or oversized ZIP")
        existing = {path.name.casefold() for path in target.iterdir()} if target.exists() else set()
        names = set()
        destinations = []
        for member in members:
            path = PurePosixPath(member.filename)
            mode = member.external_attr >> 16
            require(len(path.parts) == 1 and member.filename == path.name and path.name not in {".", ".."}
                    and "\\" not in member.filename and ":" not in member.filename and "\x00" not in member.filename, "Unsafe ZIP path")
            require(not member.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG), "ZIP special file")
            destination_name = retained_name(member.filename, artifact)
            name = destination_name.casefold()
            require(name != RECEIPT_NAME.casefold() and name not in existing and name not in names, "ZIP filename collision")
            names.add(name)
            destinations.append((member, destination_name))
        target.mkdir(mode=0o700, exist_ok=True)
        records = []
        for member, destination_name in destinations:
            destination = target / destination_name
            with archive.open(member) as incoming, destination.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            record = {"name": destination.name, "artifactId": str(artifact["id"]), "sha256": digest(destination)}
            if destination.name != member.filename:
                record["originalName"] = member.filename
            records.append(record)
        return records


def validate_proofs(preflight, build):
    require({p.name for p in preflight.iterdir()} == {"receipt.json", "routeTree.gen.ts", "routeTree.diff"}, "Unexpected preflight proof files")
    require({p.name for p in build.iterdir()} == {"receipt.json", "routeTree.gen.ts"}, "Unexpected build proof files")
    pre = json.loads((preflight / "receipt.json").read_bytes())
    built = json.loads((build / "receipt.json").read_bytes())
    for proof in [pre, built]:
        require(proof["source"] == proof["trustedContextSha"] == proof["trustedWorkflowSha"] == SOURCE, "Wrong route source/context")
        require(proof["run"] == ORIGIN_RUN and proof["attempt"] == "1" and proof["trustedWorkflowRef"] == WORKFLOW_REF and proof["lockSha256"] == LOCK_SHA256, "Wrong route owner/lock")
    require(pre["status"] == "generated-unreviewed" and pre["effectiveSourceSha"] == SOURCE, "Wrong preflight state")
    require(pre["generatorVersion"] == "1.167.12" and pre["config"] == {"autoCodeSplitting": True}, "Wrong route generator")
    require(pre["checkScriptSha256"] == CHECK_SHA256, "Wrong original source check script")
    require(pre["beforeSha256"] == pre["afterSha256"] == built["generatedRouteSha256"] == ROUTE_SHA256, "Wrong route hashes")
    require(digest(preflight / "routeTree.gen.ts") == digest(build / "routeTree.gen.ts") == ROUTE_SHA256, "Wrong route bytes")
    require(built["preflightReceiptSha256"] == digest(preflight / "receipt.json"), "Broken route proof chain")


def proof_files(preflight, build):
    return [{"proof": role, "name": path.name, "artifactId": PROOF_IDS[role], "sha256": digest(path)}
            for role, directory in [("preflight", preflight), ("build", build)] for path in sorted(directory.iterdir())]


def make_receipt(files, route_files, workflow_hash):
    return {"schemaVersion": 1, "kind": "morrowbyte-release75-continuation", "source": SOURCE, "version": VERSION,
            "originRun": ORIGIN_RUN, "originAttempt": "1", "originWorkflowSha": SOURCE,
            "originWorkflowRef": WORKFLOW_REF, "originWorkflowSha256": WORKFLOW_SHA256,
            "lockSha256": LOCK_SHA256, "routeSha256": ROUTE_SHA256, "sourceCheckScriptSha256": CHECK_SHA256,
            "controlSource": os.environ["GITHUB_SHA"], "controlWorkflowSha256": workflow_hash,
            "publicationRun": os.environ["GITHUB_RUN_ID"], "publicationAttempt": "1",
            "changedPaths": sorted(ALLOWED_CONTROL_PATHS), "originArtifacts": ARTIFACTS,
            "files": files, "routeProofFiles": route_files}


def recover():
    env = os.environ
    require(env["GITHUB_REPOSITORY"] == REPO and env["SOURCE_SHA"] == SOURCE and env["CONTINUATION75_RUN_ID"] == ORIGIN_RUN, "Wrong recovery request")
    require(env["GITHUB_REF"] == "refs/heads/main" and env["GITHUB_WORKFLOW_REF"] == WORKFLOW_REF, "Wrong continuation workflow/ref")
    control = env["GITHUB_SHA"]
    require(control == env["CONTROL_SHA"] == env["GITHUB_WORKFLOW_SHA"] and control != SOURCE
            and env["GITHUB_RUN_ATTEMPT"] == "1", "Wrong control or repeated attempt")
    require(git("rev-parse", "HEAD") == SOURCE and not git("status", "--porcelain", "--untracked-files=all"), "Application source must be exact and clean")
    require(digest(WORKFLOW) == WORKFLOW_SHA256 and digest("pnpm-lock.yaml") == LOCK_SHA256
            and digest("scripts/morrowbyte/check.sh") == CHECK_SHA256, "Wrong original workflow/lock/check script")
    subprocess.run(["git", "fetch", "--no-tags", "origin", "main"], check=True)
    require(git("rev-parse", "FETCH_HEAD") == control, "Control source is no longer current main")
    subprocess.run(["git", "merge-base", "--is-ancestor", SOURCE, control], check=True)
    validate_control_paths(git("diff", "--name-only", SOURCE, control).splitlines())
    validate_origin(api(f"actions/runs/{ORIGIN_RUN}"), api(f"actions/runs/{ORIGIN_RUN}/attempts/1/jobs?per_page=100"),
                    api(f"actions/runs/{ORIGIN_RUN}/artifacts?per_page=100"), datetime.datetime.now(datetime.timezone.utc))
    releases = api("releases?per_page=100")
    require(len(releases) < 100, "Incomplete release inventory")
    validate_unique(api("actions/workflows/morrowbyte-release.yml/runs?event=workflow_dispatch&per_page=100"), releases,
                    git("ls-remote", "origin", "refs/tags/v" + VERSION, "refs/tags/v" + VERSION + "^{}"), env["GITHUB_RUN_ID"])
    root = Path(env["RUNNER_TEMP"])
    assets = root / "release75-verified-platforms"
    preflight, build = root / "observatory-route-generation", root / "observatory-release-build"
    require(not any(path.exists() for path in [assets, preflight, build]), "Recovery output already exists")
    files = []
    api_help = subprocess.check_output(["gh", "api", "--help"], text=True)
    binary_flags = ["--allow-escape-sequences"] if "--allow-escape-sequences" in api_help else []
    for artifact_id in [*PLATFORM_IDS, *PROOF_IDS.values()]:
        target = assets if artifact_id in PLATFORM_IDS else (preflight if artifact_id == PROOF_IDS["preflight"] else build)
        archive = root / ("release75-" + artifact_id + ".zip")
        with archive.open("xb") as output:
            archive.chmod(0o600)
            subprocess.run(["gh", "api", *binary_flags, f"repos/{REPO}/actions/artifacts/{artifact_id}/zip"], stdout=output, check=True)
        records = extract_verified(archive, {"id": artifact_id, **ARTIFACTS[artifact_id]}, target)
        if artifact_id in PLATFORM_IDS:
            files.extend(records)
        archive.unlink()
    validate_proofs(preflight, build)
    workflow_bytes = subprocess.check_output(["git", "show", control + ":" + WORKFLOW])
    workflow_hash = hashlib.sha256(workflow_bytes).hexdigest()
    receipt = assets / RECEIPT_NAME
    with receipt.open("x") as output:
        json.dump(make_receipt(files, proof_files(preflight, build), workflow_hash), output, indent=2)
        output.write("\n")
    values = {"source_sha": SOURCE, "version": VERSION, "android_version_code": "75", "tag": "v" + VERSION,
              "observatory_route_sha256": ROUTE_SHA256, "desktop_run_id": ORIGIN_RUN, "desktop_run_attempt": "1",
              "desktop_context_sha": SOURCE, "desktop_workflow_sha": SOURCE, "desktop_workflow_ref": WORKFLOW_REF,
              "recovery_artifact_attempt": env["GITHUB_RUN_ATTEMPT"], "recovery_workflow_sha256": workflow_hash,
              "android_source_sha": SOURCE, "android_lock_sha256": LOCK_SHA256, "recovery75_receipt_sha256": digest(receipt)}
    with open(env["GITHUB_OUTPUT"], "a") as output:
        output.writelines(f"{key}={value}\n" for key, value in values.items())
    print(json.dumps({"status": "verified", "originRun": ORIGIN_RUN, "version": VERSION, "retainedFiles": len(files)}))


def verify(assets):
    env = os.environ
    receipt_path = assets / RECEIPT_NAME
    require(digest(receipt_path) == env["RECOVERY75_RECEIPT_SHA256"], "Changed recovery receipt")
    receipt = json.loads(receipt_path.read_bytes())
    expected = make_receipt(receipt["files"], receipt["routeProofFiles"], receipt["controlWorkflowSha256"])
    require(receipt == expected, "Wrong recovery source/attempt/ownership")
    require(env["GITHUB_REPOSITORY"] == REPO and env["GITHUB_REF"] == "refs/heads/main"
            and env["GITHUB_SHA"] == env["CONTROL_SHA"] == env["GITHUB_WORKFLOW_SHA"] and env["GITHUB_WORKFLOW_REF"] == WORKFLOW_REF
            and env["GITHUB_RUN_ATTEMPT"] == "1", "Wrong publication ownership")
    files = receipt["files"]
    require(files and {item["artifactId"] for item in files} == set(PLATFORM_IDS), "Missing original platform files")
    names = [item["name"].casefold() for item in files]
    require(len(names) == len(set(names)), "Retained filename collision")
    for item in files:
        require(Path(item["name"]).name == item["name"] and item["name"] not in {".", "..", RECEIPT_NAME}, "Unsafe retained path")
        if "originalName" in item:
            require(item["originalName"] == "builder-debug.yml" and item["name"] == retained_name(
                item["originalName"], {"id": item["artifactId"], **ARTIFACTS[item["artifactId"]]}), "Unexpected retained rename")
        path = assets / item["name"]
        require(not path.is_symlink() and digest(path) == item["sha256"], "Retained platform bytes changed")
    root = Path(env["RUNNER_TEMP"])
    preflight, build = root / "observatory-publish-preflight", root / "observatory-publish-build"
    require(receipt["routeProofFiles"] == proof_files(preflight, build), "Retained route bytes changed")
    validate_proofs(preflight, build)


if __name__ == "__main__":
    require(sys.argv[1:] == ["recover"] or len(sys.argv) == 3 and sys.argv[1] == "verify", "Expected recover or verify <release-assets>")
    recover() if sys.argv[1] == "recover" else verify(Path(sys.argv[2]))
