"""Pinned POSIX target program. JSON stdin; no shell, credentials or package code."""
import hashlib
import json
import os
import stat
import sys


def execute(request):
    path = request["path"]
    parts = path.split("/")
    if not path.startswith("/") or any(p in ("", ".", "..") for p in parts[1:]):
        raise ValueError("invalid_path")
    content = request["content"].encode("utf-8", errors="strict")
    mode = request["mode"]
    if mode not in (384, 420) or request["expectedAbsent"] is not True:
        raise ValueError("invalid_action")
    operation = request["operation"]
    if operation not in ("create", "read"):
        raise ValueError("invalid_operation")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            if info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
                raise ValueError("unprotected_parent")
        flags = os.O_NOFOLLOW | (os.O_WRONLY | os.O_CREAT | os.O_EXCL if operation == "create" else os.O_RDONLY)
        fd = os.open(parts[-1], flags, mode, dir_fd=parent)
        with os.fdopen(fd, "wb" if operation == "create" else "rb") as stream:
            if operation == "create":
                os.fchmod(stream.fileno(), mode)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            else:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode or info.st_uid != os.geteuid():
                    raise ValueError("unexpected_file")
                if stream.read(len(content) + 1) != content:
                    raise ValueError("content_mismatch")
        if operation == "create":
            os.fsync(parent)
        return {"outcome": "reported_succeeded", "contentHash": hashlib.sha256(content).hexdigest()}
    finally:
        os.close(parent)


if __name__ == "__main__":
    try:
        print(json.dumps(execute(json.load(sys.stdin))))
    except Exception as error:
        # An error after exclusive creation may have left a partial file.
        print(json.dumps({"outcome": "unknown", "errorCode": type(error).__name__}))
        sys.exit(1)
