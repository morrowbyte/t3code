#!/usr/bin/env python3
"""Promote only the retained Linux/NixOS/Android bytes of release .114."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import zipfile

SOURCE = "81d9c15a27fc9f5255e68dfa912ad3e334897be6"
CONTROL_BASE = "b7a0cc1202c0c1d4653481218440a41df3d1a592"
ORIGIN_RUN = "43162158319"
VERSION = "0.1.8-nightly.20261112.114"
TAG = "v" + VERSION
REPO = "morrowbyte/t3code"
REPO_ID = 1175532637
WORKFLOW = ".github/workflows/morrowbyte-release.yml"
WORKFLOW_REF = REPO + "/" + WORKFLOW + "@refs/heads/main"
ORIGIN_WORKFLOW_SHA256 = "6b9e6b5374756ed213781166b01c16b1a480986f0a677b657fa35efc1c2e8cfc"
SOURCE_PROOF_RUN = "43159613780"
SOURCE_PROOF_ID = "13917702448"
SOURCE_PROOF_DIGEST = "sha256:78b6d44968568496bd09ec43a54fe3ef55d30e8934f472b39ce679b01014b0ec"
SOURCE_PROOF_REF = REPO + "/.github/workflows/morrowbyte-local-source-check.yml@refs/heads/main"
LOCK_SHA256 = "e14dbc74ead6ccccfa47c701960c0a65b3a3e029d10dcf17008c72478fbceb2c"
ROUTE_SHA256 = "e46700d9f3fbdc2779ea142e2db214e48751403e7b29f0b2b8c16e6b24374fe1"
CHECK_SHA256 = "3f1cf53f49ef3282534a016b358dd8a494eda557457d5e9b2a9a03d4e98113cb"
APK_SHA256 = "b4d86d837987cc47f59987ed5be4a1fab762b717475e1f39757d4daa38777def"
APK_RECEIPT_SHA256 = "eac1ee586e4483729281cf859817a5b84f22e104f3d63521a69fe70a3e135abb"
CERT_SHA256 = "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2"
RECEIPT_NAME = "RELEASE114-PROMOTION.json"
ALLOWED_CONTROL_PATHS = {
    WORKFLOW, "scripts/morrowbyte/release114-promotion.py",
    "scripts/morrowbyte/release114-promotion.test.py",
    "scripts/morrowbyte/verify-nixos-closure.sh", "scripts/morrowbyte/verify-nixos-closure.test.sh",
}
ARTIFACTS = {'13920225019': {'name': 'morrowbyte-android-startup-81d9c15a27fc9f5255e68dfa912ad3e334897be6-1',
                 'digest': 'sha256:4766fb369653189d0209e43d3a954870d1c486c13eb85c1d2ffe2e3a60913e9d',
                 'size_in_bytes': 152706,
                 'expires_at': '2026-11-15T05:59:20Z'},
 '13919567011': {'name': 'morrowbyte-release-android',
                 'digest': 'sha256:ee28df68c976ffe83ebe35d2eed1b98fa69df269fcc9222218c01be166e95f5f',
                 'size_in_bytes': 117214238,
                 'expires_at': '2026-11-19T05:59:21Z'},
 '13919308118': {'name': 'morrowbyte-built-android',
                 'digest': 'sha256:cd2659e0be284a8e6044fc8d8fa64d8d885127bcf6df8d872d3fdcd31163895e',
                 'size_in_bytes': 242029771,
                 'expires_at': '2026-11-19T05:55:28Z'},
 '13919101098': {'name': 'morrowbyte-release-cli-linux',
                 'digest': 'sha256:98f1b930ac3f221696100ee1b2a7d0f0abc7455e1521965463e761d57c91566d',
                 'size_in_bytes': 162737801,
                 'expires_at': '2026-11-13T05:39:16Z'},
 '13918864176': {'name': 'morrowbyte-android-build-evidence-81d9c15a27fc9f5255e68dfa912ad3e334897be6-1',
                 'digest': 'sha256:ee40bcd3d79731e81ea941d6c077a6432f81df9608e59656bcb9ccfb98ba3a41',
                 'size_in_bytes': 19243,
                 'expires_at': '2026-11-19T05:55:34Z'},
 '13918731167': {'name': 'morrowbyte-source-qualification-81d9c15a27fc9f5255e68dfa912ad3e334897be6-1',
                 'digest': 'sha256:fb9e5ad55d5a35edda37073aaaaba40ccb15264334baf5f5779e0d0a36eddf18',
                 'size_in_bytes': 1681,
                 'expires_at': '2026-11-19T05:33:53Z'},
 '13918582262': {'name': 'morrowbyte-js-bundle',
                 'digest': 'sha256:96acbfa4baad8946cdd042d00d8000b05dca28db5f0473936a286092aee8047c',
                 'size_in_bytes': 91778766,
                 'expires_at': '2026-11-13T05:35:34Z'},
 '13918527691': {'name': 'morrowbyte-release-nixos',
                 'digest': 'sha256:21e2bbf5d9fe500834eba9269dc18ae3817da5bdfaa41e7c41d83a6161af0421',
                 'size_in_bytes': 418923046,
                 'expires_at': '2026-11-13T05:41:23Z'},
 '13918368074': {'name': 'morrowbyte-linux-startup-81d9c15a27fc9f5255e68dfa912ad3e334897be6-1',
                 'digest': 'sha256:aa4a56590153559c403d235a6c04e2c66e8286b7858d48bba61fe9275d7cece8',
                 'size_in_bytes': 241249,
                 'expires_at': '2026-11-13T05:38:40Z'},
 '13918237797': {'name': 'morrowbyte-observatory-build-81d9c15a27fc9f5255e68dfa912ad3e334897be6-1',
                 'digest': 'sha256:d8cb15fe08f50d90762286be7af8bad3d5b8ce54738b112f7983f17d3a069214',
                 'size_in_bytes': 5319,
                 'expires_at': '2026-11-19T05:35:32Z'},
 '13918202244': {'name': 'morrowbyte-observatory-preflight-81d9c15a27fc9f5255e68dfa912ad3e334897be6-1',
                 'digest': 'sha256:9b80af9ca8789c3c56def6a9b69cb0fbca0fa46b8badcd99b485d1b231f1725f',
                 'size_in_bytes': 5696,
                 'expires_at': '2026-11-19T05:34:12Z'},
 '13917924590': {'name': 'morrowbyte-release-linux',
                 'digest': 'sha256:1f5fdcb4f40be86fde288473e8d9efc83a4eaf33fc27cdd703e20081dfa4a114',
                 'size_in_bytes': 449460938,
                 'expires_at': '2026-11-13T05:39:08Z'}}
PLATFORM_IDS = ("13917924590", "13919101098", "13918527691", "13919567011")
PROOF_IDS = {
    "observatory-publish-preflight": "13918202244", "observatory-publish-build": "13918237797",
    "release114-source-qualification": "13918731167", "release114-linux-startup": "13918368074",
    "release114-android-startup": "13920225019", "release114-android-evidence": "13918864176",
}
JOBS = {
    "preflight": (130995654156, "success"), "build_bundle": (130995969648, "success"),
    "build_linux": (130996561444, "success"), "build_nixos": (130997769472, "success"),
    "Build Morrowbyte Android APK": (130995969595, "success"),
    "Verify signed Android startup": (131003941519, "success"),
    "build_windows": (130997769399, "failure"), "publish_linux_first": (131004717613, "failure"),
    "publish_android": (131004718860, "skipped"), "publish_windows": (131004718924, "skipped"),
    "publish": (131004719246, "skipped"), "append_windows": (131005130859, "skipped"),
}
VERIFIED_STEPS = {
    "preflight": ["Verify full source qualification before packaging", "Verify reviewed Observatory preflight route"],
    "build_bundle": ["Bind independently built Observatory route", "Upload shared assets"],
    "build_linux": ["Launch the exact Linux AppImage with its bundled server", "Package and smoke-test Linux CLI archive",
                    "Upload Linux release assets", "Upload Linux CLI archive"],
    "build_nixos": ["Build immutable NixOS closure"],
    "Build Morrowbyte Android APK": ["Verify APK signature, embedded bundle, identity and 16KB native alignment", "Upload signed Android build payload"],
    "Verify signed Android startup": ["Start the minified release on Android 16 before publication",
                                     "Bind successful emulator startup to the ARM64 shipping receipt", "Upload verified Android release payload"],
    "publish_linux_first": ["Require matching Observatory route proofs before publication", "Verify Android bytes from this build before publication"],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def api(suffix, optional=False):
    result = subprocess.run(["gh", "api", f"repos/{REPO}/" + suffix], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        try:
            error = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            error = {}
        require(optional and str(error.get("status")) == "404", "GitHub read failed: " + suffix)
        return None
    return json.loads(result.stdout)


def validate_selection(selection):
    require(selection.get("promote_release114_run_id") == ORIGIN_RUN and selection.get("source_sha") == SOURCE
            and selection.get("publish") is True, "Wrong .114 promotion selection")
    for key in ["linux_first", "desktop_only", "windows_only", "windows_candidate_only", "android_only", "restore_android74"]:
        require(not selection.get(key), "Incompatible promotion option: " + key)
    for key in ["recover_desktop_run_id", "recover_windows_run_id", "continue_release68_run_id", "continue_release75_run_id", "android_source_sha"]:
        require(not selection.get(key), "Incompatible promotion option: " + key)
    for key, expected in [("source_proof_run_id", SOURCE_PROOF_RUN), ("source_proof_artifact_id", SOURCE_PROOF_ID),
                          ("source_proof_digest", SOURCE_PROOF_DIGEST)]:
        require(selection.get(key, "") in ("", expected), "Changed original source proof input")


def validate_origin(run, jobs, inventory, now):
    require((run["id"], run["run_number"], run["run_attempt"], run["workflow_id"]) ==
            (int(ORIGIN_RUN), 49, 1, 393910318), "Wrong origin run/attempt/workflow")
    require(all(run[key]["full_name"] == REPO and run[key]["id"] == REPO_ID for key in ["repository", "head_repository"]), "Foreign origin")
    require(run["head_sha"] == SOURCE and run["head_branch"] == "main" and run["event"] == "workflow_dispatch"
            and run["path"] == WORKFLOW and run["status"] == "completed" and run["conclusion"] == "failure", "Wrong origin source/event/state")
    require(jobs["total_count"] == len(jobs["jobs"]) == len(JOBS), "Incomplete origin jobs")
    require({j["name"]: (j["id"], j["conclusion"]) for j in jobs["jobs"]} == JOBS, "Changed origin jobs")
    for job in jobs["jobs"]:
        require(job["run_id"] == int(ORIGIN_RUN) and job["run_attempt"] == 1 and job["head_sha"] == SOURCE
                and job["status"] == "completed", "Wrong job source/attempt/state")
        for name in VERIFIED_STEPS.get(job["name"], []):
            matches = [step for step in job["steps"] if step["name"] == name]
            require(len(matches) == 1 and matches[0]["conclusion"] == "success", "Missing successful origin step: " + name)
        failures = [step["name"] for step in job["steps"] if step["conclusion"] == "failure"]
        expected = {"build_windows": ["Setup Rust"], "publish_linux_first": ["Verify isolated release payload"]}.get(job["name"], [])
        require(failures == expected, "Unexpected original failure")
        if job["name"] == "publish_linux_first":
            create = [step for step in job["steps"] if step["name"] == "Create fork-only prerelease"]
            require(len(create) == 1 and create[0]["conclusion"] == "skipped", "Original publisher reached creation")
    require(inventory["total_count"] == len(inventory["artifacts"]) == len(ARTIFACTS), "Incomplete artifact inventory")
    require({str(a["id"]) for a in inventory["artifacts"]} == set(ARTIFACTS), "Changed artifact IDs")
    for artifact in inventory["artifacts"]:
        require(all(artifact[key] == value for key, value in ARTIFACTS[str(artifact["id"])].items()), "Changed artifact pin")
        require(artifact["expired"] is False and datetime.datetime.fromisoformat(artifact["expires_at"].replace("Z", "+00:00")) > now, "Expired origin artifact")
        owner = artifact["workflow_run"]
        require(owner["id"] == int(ORIGIN_RUN) and owner["head_sha"] == SOURCE and owner["head_branch"] == "main"
                and owner["repository_id"] == owner["head_repository_id"] == REPO_ID, "Foreign artifact owner")


def validate_control_paths(changes):
    require(changes and all(status in {"A", "M"} and path in ALLOWED_CONTROL_PATHS for status, path in changes), "Control delta contains product changes")
    require({WORKFLOW, "scripts/morrowbyte/release114-promotion.py", "scripts/morrowbyte/verify-nixos-closure.sh"}
            <= {path for _, path in changes}, "Incomplete promotion control delta")


def validate_control():
    env = os.environ
    control = env["CONTROL_SHA"]
    require(env["GITHUB_REPOSITORY"] == REPO and env["GITHUB_REF"] == "refs/heads/main"
            and env["GITHUB_EVENT_NAME"] == "workflow_dispatch" and env["GITHUB_WORKFLOW_REF"] == WORKFLOW_REF,
            "Wrong promotion repository/event/ref")
    require(re.fullmatch(r"[0-9a-f]{40}", control) and env["GITHUB_SHA"] == env["GITHUB_WORKFLOW_SHA"] == control
            and control not in {SOURCE, CONTROL_BASE}, "Wrong immutable control source")
    require(git("rev-parse", "HEAD") == SOURCE and not git("status", "--porcelain", "--untracked-files=all"), "Product checkout must be exact and clean")
    require(digest(WORKFLOW) == ORIGIN_WORKFLOW_SHA256 and digest("pnpm-lock.yaml") == LOCK_SHA256
            and digest("scripts/morrowbyte/check.sh") == CHECK_SHA256, "Changed original product tooling")
    subprocess.run(["git", "merge-base", "--is-ancestor", SOURCE, CONTROL_BASE], check=True)
    subprocess.run(["git", "merge-base", "--is-ancestor", CONTROL_BASE, control], check=True)
    changes = [tuple(line.split("\t")) for line in git("diff", "--no-renames", "--name-status", CONTROL_BASE, control).splitlines()]
    validate_control_paths(changes)
    return changes


def validate_release(release, tag_object, assets=None, draft_receipt=None):
    if tag_object is not None:
        require(tag_object["type"] == "commit" and tag_object["sha"] == SOURCE, "Existing tag differs from product source")
    if release is None:
        return
    require(release["tag_name"] == TAG and release["target_commitish"] == SOURCE and release["prerelease"] is True, "Wrong existing release identity")
    require(release["draft"] is True or release["published_at"], "Ambiguous published state")
    if assets is not None and release["draft"]:
        expected = {p.name: "sha256:" + digest(p) for p in assets.iterdir() if p.is_file()}
        names = [item["name"] for item in release["assets"]]
        require(len(names) == len(set(names)), "Duplicate draft assets")
        for item in release["assets"]:
            if item["name"] == "RELEASE-RECEIPT.txt":
                require(draft_receipt is not None and "sha256:" + hashlib.sha256(draft_receipt).hexdigest() == item["digest"], "Changed draft receipt digest")
                text = draft_receipt.decode()
                for line in ["fork_release=" + TAG, "source_sha=" + SOURCE,
                             "promotion_receipt_sha256=" + digest(assets / RECEIPT_NAME)]:
                    require(text.splitlines().count(line) == 1, "Wrong draft receipt provenance")
                parts = text.split("artifact_sha256:\n")
                require(len(parts) == 2 and parts[1] == (assets / "SHA256SUMS").read_text(), "Wrong draft receipt checksums")
                continue
            require(item["name"] in expected and item["digest"] == expected[item["name"]], "Draft contains different bytes or unknown assets")


def release_boundary(assets=None):
    release = api("releases/tags/" + TAG, optional=True)
    ref = api("git/ref/tags/" + TAG, optional=True)
    obj = ref["object"] if ref else None
    if obj and obj["type"] == "tag":
        obj = api("git/tags/" + obj["sha"])["object"]
    receipt = None
    if assets is not None and release and release["draft"]:
        matches = [item for item in release["assets"] if item["name"] == "RELEASE-RECEIPT.txt"]
        if matches:
            asset_id = matches[0]["id"]
            require(isinstance(asset_id, int) and asset_id > 0 and matches[0]["size"] <= 65536, "Invalid draft receipt asset")
            receipt = subprocess.check_output(["gh", "api", f"repos/{REPO}/releases/assets/{asset_id}", "-H", "Accept: application/octet-stream"])
            require(len(receipt) <= 65536, "Oversized draft receipt")
    validate_release(release, obj, assets, receipt)


def inspect():
    validate_selection(json.loads(os.environ["PROMOTION_INPUTS"]))
    changes = validate_control()
    validate_origin(api(f"actions/runs/{ORIGIN_RUN}"), api(f"actions/runs/{ORIGIN_RUN}/attempts/1/jobs?per_page=100"),
                    api(f"actions/runs/{ORIGIN_RUN}/artifacts?per_page=100"), datetime.datetime.now(datetime.timezone.utc))
    release_boundary()
    values = {"source_sha": SOURCE, "version": VERSION, "tag": TAG, "android_version_code": "114",
              "observatory_route_sha256": ROUTE_SHA256, "desktop_run_id": ORIGIN_RUN, "desktop_run_attempt": "1",
              "desktop_context_sha": SOURCE, "desktop_workflow_sha": SOURCE, "desktop_workflow_ref": WORKFLOW_REF,
              "source_proof_run_id": SOURCE_PROOF_RUN, "source_proof_attempt": "1", "source_proof_workflow_ref": SOURCE_PROOF_REF,
              "android_source_sha": SOURCE, "android_lock_sha256": LOCK_SHA256,
              "recovered_apk_sha256": APK_SHA256, "recovered_apk_receipt_sha256": APK_RECEIPT_SHA256,
              "continuation_android_run_id": ORIGIN_RUN, "continuation_android_run_attempt": "1",
              "continuation_android_context_sha": SOURCE, "continuation_android_workflow_sha": SOURCE,
              "continuation_android_workflow_ref": WORKFLOW_REF,
              "recovery_workflow_sha256": hashlib.sha256(subprocess.check_output(["git", "show", os.environ["CONTROL_SHA"] + ":" + WORKFLOW])).hexdigest()}
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.writelines(f"{key}={value}\n" for key, value in values.items())
    return changes


def extract_verified(archive_path, artifact, target, nested=False):
    require(archive_path.stat().st_size == artifact["size_in_bytes"] and "sha256:" + digest(archive_path) == artifact["digest"], "Original ZIP digest/length differs")
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        limit = 2_000_000_000 if str(artifact["id"]) in PLATFORM_IDS else 32_000_000
        require(0 < len(members) <= 256 and sum(m.file_size for m in members) <= limit, "Empty or oversized ZIP")
        names, files, regular_paths = set(), [], set()
        for member in members:
            path = PurePosixPath(member.filename)
            require(member.filename == path.as_posix() + ("/" if member.is_dir() else "") and not path.is_absolute()
                    and path.parts and all(part not in {".", ".."} for part in path.parts)
                    and not any(char in member.filename for char in "\\:") and all(ord(char) >= 32 for char in member.filename)
                    and (nested or len(path.parts) == 1), "Unsafe ZIP path")
            require(stat.S_IFMT(member.external_attr >> 16) in ((0, stat.S_IFDIR) if member.is_dir() else (0, stat.S_IFREG)), "ZIP special file")
            key = str(path).casefold()
            require(key not in names and key != RECEIPT_NAME.casefold(), "ZIP filename collision")
            names.add(key)
            if not member.is_dir():
                regular_paths.add(key)
            destination = target / path
            require(not destination.exists() and not destination.is_symlink(), "ZIP would overwrite retained bytes")
            files.append((member, destination))
        for member, _ in files:
            require(not any(str(parent).casefold() in regular_paths for parent in PurePosixPath(member.filename).parents), "ZIP file/directory collision")
        require(not any(p.is_symlink() for p in [target, *target.parents]), "ZIP target contains symlink")
        target.mkdir(mode=0o700, exist_ok=True)
        for member, destination in files:
            if member.is_dir():
                destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            require(not any(p.is_symlink() for p in destination.parents), "ZIP target contains symlink")
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            require(not any(p.is_symlink() for p in [target, *destination.parents]), "ZIP target contains symlink")
            with archive.open(member) as incoming, destination.open("xb") as outgoing:
                destination.chmod(0o600)
                copied = 0
                while block := incoming.read(1024 * 1024):
                    copied += len(block)
                    require(copied <= member.file_size, "ZIP member exceeds declared length")
                    outgoing.write(block)
                require(copied == member.file_size, "Incomplete ZIP member")


def download(artifact_id, root):
    archive = root / ("release114-" + artifact_id + ".zip")
    pin = ARTIFACTS[artifact_id]
    help_text = subprocess.check_output(["gh", "api", "--help"], text=True)
    flags = ["--allow-escape-sequences"] if "--allow-escape-sequences" in help_text else []
    with archive.open("xb") as output:
        archive.chmod(0o600)
        with subprocess.Popen(["gh", "api", *flags, f"repos/{REPO}/actions/artifacts/{artifact_id}/zip"], stdout=subprocess.PIPE) as process:
            try:
                size = 0
                while block := process.stdout.read(1024 * 1024):
                    size += len(block)
                    require(size <= pin["size_in_bytes"], "ZIP download exceeds pinned size")
                    output.write(block)
                require(process.wait() == 0, "Original artifact download failed")
            except BaseException:
                process.terminate()
                process.wait()
                raise
    return archive


def validate_proofs(root, assets):
    preflight, build = root / "observatory-publish-preflight", root / "observatory-publish-build"
    pre = json.loads((preflight / "receipt.json").read_bytes())
    built = json.loads((build / "receipt.json").read_bytes())
    for proof, run, workflow in [(pre, SOURCE_PROOF_RUN, SOURCE_PROOF_REF), (built, ORIGIN_RUN, WORKFLOW_REF)]:
        require(proof["source"] == proof["trustedContextSha"] == proof["trustedWorkflowSha"] == SOURCE
                and proof["run"] == run and proof["attempt"] == "1" and proof["trustedWorkflowRef"] == workflow
                and proof["lockSha256"] == LOCK_SHA256, "Wrong original route receipt owner")
    require(pre["effectiveSourceSha"] == SOURCE and pre["status"] == "generated-unreviewed"
            and pre["checkScriptSha256"] == CHECK_SHA256 and pre["config"] == {"autoCodeSplitting": True}, "Wrong preflight receipt")
    require(pre["afterSha256"] == built["generatedRouteSha256"] == ROUTE_SHA256
            and digest(preflight / "routeTree.gen.ts") == digest(build / "routeTree.gen.ts") == ROUTE_SHA256
            and built["preflightReceiptSha256"] == digest(preflight / "receipt.json"), "Broken original route chain")
    name = f"Morrowbyte-{VERSION}-android-arm64.apk"
    apk = assets / name
    receipt_path = assets / (name + ".json")
    require(digest(apk) == APK_SHA256 and digest(receipt_path) == APK_RECEIPT_SHA256, "Changed Android payload/receipt")
    receipt = json.loads(receipt_path.read_bytes())
    expected = {"schemaVersion": 1, "source": SOURCE, "desktopSource": SOURCE, "lockSha256": LOCK_SHA256,
                "run": ORIGIN_RUN, "attempt": "1", "trustedContextSha": SOURCE, "trustedWorkflowSha": SOURCE,
                "trustedWorkflowRef": WORKFLOW_REF, "apk": name, "apkSha256": APK_SHA256, "version": VERSION,
                "versionCode": 114, "package": "com.morrowbyte.t3code", "name": "Crew", "abis": ["arm64-v8a"],
                "certificateSha256": CERT_SHA256, "signatureVerified": True, "zip16KB": True, "elf16KB": True,
                "deviceAcceptance": "not-run"}
    require(all(receipt.get(key) == value for key, value in expected.items()), "Wrong original APK provenance")
    require((assets / (name + ".sha256")).read_text() == f"{APK_SHA256}  {name}\n", "Wrong APK checksum")
    startup = json.loads((root / "release114-android-startup/startup.json").read_bytes())
    require(receipt["ciEmulatorStartup"] == {**startup, "startupScriptSha256": digest("scripts/morrowbyte/android-startup-smoke.sh")}, "Broken APK startup proof chain")
    require(startup["status"] == "passed" and startup["source"] == SOURCE and startup["run"] == ORIGIN_RUN
            and startup["attempt"] == "1" and startup["productionApkSha256"] == APK_SHA256
            and startup["embeddedBundleSha256"] == receipt["embeddedBundleSha256"]
            and startup["uiBeyondSplash"] is True and startup["startupErrors"] is False
            and startup["startupAbi"] == "x86_64" and startup["shippingAbi"] == "arm64-v8a"
            and startup["physicalDeviceAcceptance"] is False, "Wrong original emulator acceptance")
    require(digest(root / "release114-android-evidence/morrowbyte-android-dependencies.txt") == receipt["dependencyReportSha256"], "Changed Android dependency evidence")
    linux = root / "release114-linux-startup"
    desktop = json.loads((linux / "startup.json").read_bytes())
    require(desktop == {"status": "passed", "platform": "linux", "version": VERSION, "seededThreadVisible": True}, "Wrong original Linux startup")
    image = f"T3-Code-{VERSION}-x86_64.AppImage"
    require((linux / "appimage.sha256").read_text().split()[0] == digest(assets / image), "Linux startup uses different AppImage")
    allowed = {image, image + ".blockmap", "nightly-linux.yml", "morrowbyte-linux-x64.tar.gz", "install-linux.sh", "builder-debug.yml",
               f"t3-{VERSION}-linux-x64.tar.gz", f"T3-Code-{VERSION}-x86_64-linux-nix-closure.nar.zst",
               f"T3-Code-{VERSION}-x86_64-linux-nix-closure.json", name, name + ".json", name + ".sha256"}
    require({p.name for p in assets.iterdir()} <= allowed and all(p.is_file() and not p.is_symlink() for p in assets.iterdir()), "Unexpected platform payload")


def file_records(directory):
    paths = sorted(directory.rglob("*"))
    require(not directory.is_symlink() and all(not path.is_symlink() and (path.is_file() or path.is_dir()) for path in paths), "Retained proof contains special file")
    return [{"name": path.relative_to(directory).as_posix(), "sha256": digest(path)} for path in paths if path.is_file()]


def make_receipt(files, proofs, changes):
    # Publication attempts stay in RELEASE-RECEIPT.txt so same-control retries reuse bytes.
    control = os.environ["CONTROL_SHA"]
    return {"schemaVersion": 1, "kind": "morrowbyte-release114-promotion", "source": SOURCE, "version": VERSION,
            "originRun": ORIGIN_RUN, "originAttempt": "1", "originWorkflowSha": SOURCE, "originWorkflowRef": WORKFLOW_REF,
            "sourceProofRun": SOURCE_PROOF_RUN, "sourceProofArtifact": SOURCE_PROOF_ID, "sourceProofDigest": SOURCE_PROOF_DIGEST,
            "controlBase": CONTROL_BASE, "controlSource": control, "controlWorkflowRef": WORKFLOW_REF,
            "controlWorkflowSha256": hashlib.sha256(subprocess.check_output(["git", "show", control + ":" + WORKFLOW])).hexdigest(),
            "controlChanges": changes, "originArtifacts": ARTIFACTS, "files": files, "proofs": proofs,
            "platforms": ["linux-x64", "nixos-x64", "android-arm64"], "windowsStatus": "failed-origin-Setup-Rust"}


def recover():
    changes = inspect()
    root, assets = Path(os.environ["RUNNER_TEMP"]), Path("release-assets")
    require(not assets.exists() and all(not (root / role).exists() for role in PROOF_IDS), "Promotion output already exists")
    for artifact_id in [*PLATFORM_IDS, *PROOF_IDS.values()]:
        role = next((role for role, value in PROOF_IDS.items() if value == artifact_id), None)
        archive = download(artifact_id, root)
        extract_verified(archive, {"id": artifact_id, **ARTIFACTS[artifact_id]}, root / role if role else assets, nested=bool(role))
        archive.unlink()
    validate_proofs(root, assets)
    records = file_records(assets)
    proofs = {role: file_records(root / role) for role in PROOF_IDS}
    path = assets / RECEIPT_NAME
    with path.open("x") as output:
        path.chmod(0o600)
        json.dump(make_receipt(records, proofs, changes), output, indent=2)
        output.write("\n")
    evidence_receipt = root / "release114-promotion-receipt.json"
    with evidence_receipt.open("xb") as output:
        evidence_receipt.chmod(0o600)
        output.write(path.read_bytes())
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("receipt_sha256=" + digest(path) + "\n")


def verify(assets):
    path = assets / RECEIPT_NAME
    require(not path.is_symlink() and digest(path) == os.environ["PROMOTION114_RECEIPT_SHA256"], "Changed promotion receipt")
    receipt = json.loads(path.read_bytes())
    require(receipt == make_receipt(receipt["files"], receipt["proofs"], receipt["controlChanges"]), "Wrong promotion receipt ownership")
    validate_control_paths(receipt["controlChanges"])
    require(receipt["files"] and len({f["name"] for f in receipt["files"]}) == len(receipt["files"]), "Missing or duplicate retained files")
    for item in receipt["files"]:
        require(PurePosixPath(item["name"]).name == item["name"] and item["name"] not in {".", "..", RECEIPT_NAME}, "Unsafe retained path")
        payload = assets / item["name"]
        require(not payload.is_symlink() and digest(payload) == item["sha256"], "Retained payload bytes changed")
    require({p.name for p in assets.iterdir()} <= {f["name"] for f in receipt["files"]} | {RECEIPT_NAME, "SHA256SUMS", "RELEASE-RECEIPT.txt"}, "Unexpected publication files")
    root = Path(os.environ["RUNNER_TEMP"])
    require(receipt["proofs"] == {role: file_records(root / role) for role in PROOF_IDS}, "Original proof bytes changed")


if __name__ == "__main__":
    command = sys.argv[1:]
    require(command in (["inspect"], ["recover"]) or command in (["verify", "release-assets"], ["boundary", "release-assets"]), "Expected inspect, recover, verify or boundary release-assets")
    if command == ["inspect"]:
        inspect()
    elif command == ["recover"]:
        recover()
    elif command[0] == "verify":
        verify(Path(command[1]))
    else:
        release_boundary(Path(command[1]))
