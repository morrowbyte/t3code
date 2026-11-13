#!/usr/bin/env bash
# Intent: Apply the native Linux credential patches to the exact Codex 0.163.0 source.
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 /absolute/path/to/codex-source" >&2
    exit 2
fi

source_root=$1
patch_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
patch_files=(0001-linux-noninteractive-keyring-reads.patch 0002-noninteractive-refresh-save.patch)
expected_commit=83086188ae0614bd882818ff1aa23f3194962012

if [[ $(git -C "$source_root" rev-parse HEAD) != "$expected_commit" ]]; then
    echo "Refusing to apply: expected Codex rust-v0.163.0 ($expected_commit)." >&2
    exit 1
fi

if ! git -C "$source_root" diff --quiet HEAD -- \
    codex-rs/Cargo.lock \
    codex-rs/keyring-store \
    codex-rs/rmcp-client/src/oauth.rs \
    codex-rs/rmcp-client/src/oauth; then
    echo "Refusing to overwrite edits in the native patch's existing target files." >&2
    exit 1
fi

patch_index=$(mktemp)
rm -- "$patch_index"
trap 'rm -f -- "$patch_index" "$patch_index.lock"' EXIT
export GIT_INDEX_FILE="$patch_index"
git -C "$source_root" read-tree "$expected_commit"
for patch_file in "${patch_files[@]}"; do
    git -C "$source_root" apply --cached "$patch_root/$patch_file"
done
unset GIT_INDEX_FILE
for patch_file in "${patch_files[@]}"; do
    git -C "$source_root" apply "$patch_root/$patch_file"
done
echo "Applied native Linux credential patches; no build or tests were run."
