"""Requester holds only an approval-review:request token; never an SSH key."""
import argparse
import json
import os
from pathlib import Path
from worker import Api


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--read", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    package = json.loads(Path(args.package).read_text(encoding="utf-8-sig"))
    result = Api(config).post("read" if args.read else "submit", package)
    # Exclusive output prevents quietly replacing the original submission receipt.
    with open(args.output, "x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({"threadId": result["threadId"], "requestId": result["requestId"],
        "packageHash": result["authority"]["packageHash"], "state": result["authority"]["state"]}))


if __name__ == "__main__":
    main()
