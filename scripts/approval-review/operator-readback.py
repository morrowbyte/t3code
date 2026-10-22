"""Operator-only check of one approved artifact, with a different pinned SSH key."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from worker import TEMPLATE, VERSION, ssh_run


def check(config, action):
    target = config["target"]
    if action["kind"] != "create_file_once" or action["verifiedTargetId"] != target["verifiedTargetId"] or action["path"] != target["allowedPath"]:
        raise ValueError("target_mismatch")
    source = TEMPLATE.read_text(encoding="utf-8")
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    if action["implementationHash"] != digest or action["implementationVersion"] != VERSION or target["implementationHash"] != digest:
        raise ValueError("implementation_mismatch")
    ssh = config["ssh"]
    fingerprint = subprocess.run([config["sshKeygen"], "-l", "-f", ssh["identityFile"], "-E", "sha256"],
        check=True, capture_output=True, timeout=10, text=True).stdout.split()[1]
    if fingerprint != config["operatorKeyFingerprint"] or fingerprint == config["workerKeyFingerprint"]:
        raise ValueError("independent_identity_required")
    # StrictHostKeyChecking binds this separate operator invocation to the retained host key.
    result = ssh_run(config, source, action, "read")
    return {"kind": "operator_readback", "verifiedTargetId": target["verifiedTargetId"],
        "path": action["path"], "mode": action["mode"], "contentHash": result["contentHash"],
        "operatorKeyFingerprint": fingerprint}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--approved-action", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    action = json.loads(Path(args.approved_action).read_text(encoding="utf-8-sig"))
    result = check(config, action)
    with open(args.output, "x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
