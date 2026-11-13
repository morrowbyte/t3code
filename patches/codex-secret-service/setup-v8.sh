#!/usr/bin/env bash
# Intent: Resolve and verify the V8 artifacts pinned by the upstream Codex release workflow.
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 /codex-source /private-v8-cache" >&2
    exit 2
fi

source_root=$(realpath "$1")
artifact_root=$(realpath -m "$2")
version=$(python3 "$source_root/.github/scripts/rusty_v8_bazel.py" resolved-v8-crate-version)
target=x86_64-unknown-linux-musl
profile=ptrcomp_sandbox_release
base_url="https://github.com/openai/codex/releases/download/rusty-v8-v${version}"
archive_name="librusty_v8_${profile}_${target}.a.gz"
binding_name="src_binding_${profile}_${target}.rs"
checksums_name="rusty_v8_${profile}_${target}.sha256"
trusted_checksums="$source_root/third_party/v8/rusty_v8_${version//./_}_release_manifests.sha256"
mkdir -p "$artifact_root"

for name in "$checksums_name" "$archive_name" "$binding_name"; do
    if [[ ! -f "$artifact_root/$name" ]]; then
        curl -fSL "$base_url/$name" -o "$artifact_root/$name"
    fi
done

python3 - "$artifact_root" "$trusted_checksums" "$checksums_name" "$archive_name" "$binding_name" <<'PY'
import hashlib
import pathlib
import sys

root, trusted = map(pathlib.Path, sys.argv[1:3])
manifest, archive, binding = sys.argv[3:]
def checksums(text):
    return {name: digest for digest, name in (line.split() for line in text.splitlines())}
def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()
assert digest(root / manifest) == checksums(trusted.read_text())[manifest]
expected = checksums((root / manifest).read_text())
assert set(expected) == {archive, binding}
for name, checksum in expected.items():
    assert digest(root / name) == checksum, f'Checksum mismatch: {name}'
(root / 'environment').write_text(f'RUSTY_V8_ARCHIVE={root / archive}\nRUSTY_V8_SRC_BINDING_PATH={root / binding}\n')
print(f'Verified upstream V8 archive and binding: {archive}')
PY
