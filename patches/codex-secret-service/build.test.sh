#!/usr/bin/env bash
# Intent: Reject unrelated native source edits before any build or dependency download.
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: bash $0 /existing-codex-checkout /private-temp-parent" >&2
    exit 2
fi

patch_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_root=$(realpath "$1")
temporary_root=$(mktemp -d "$2/source-guard.XXXXXX")
trap 'rm -rf -- "$temporary_root"' EXIT
fixture=$temporary_root/source
git clone --quiet --shared --no-checkout "$source_root" "$fixture"
git -C "$fixture" checkout --quiet --detach 83086188ae0614bd882818ff1aa23f3194962012
bash "$patch_root/apply.sh" "$fixture"
touch "$temporary_root/musl.env"

verify() {
    bash "$patch_root/build.sh" "$fixture" "$temporary_root/target" "$temporary_root/musl.env" verify
}
reject() {
    if verify; then
        echo "Unexpectedly accepted $1" >&2
        exit 1
    fi
    echo "Rejected $1"
}

verify
verify
tracked=$fixture/codex-rs/cli/src/main.rs
cp "$tracked" "$temporary_root/original.rs"
printf '\n// Unapproved source edit\n' >> "$tracked"
reject 'tracked CLI edit'
cp "$temporary_root/original.rs" "$tracked"

untracked=$fixture/codex-rs/cli/src/unapproved.rs
printf '// Unapproved source file\n' > "$untracked"
reject 'untracked CLI source'
rm -- "$untracked"

mv "$tracked" "$temporary_root/deleted.rs"
reject 'deleted CLI source'
mv "$temporary_root/deleted.rs" "$tracked"

lock=$fixture/codex-rs/Cargo.lock
cp "$lock" "$temporary_root/original.lock"
printf '\n# Unapproved lockfile edit\n' >> "$lock"
reject 'unapproved lockfile edit'
cp "$temporary_root/original.lock" "$lock"
verify
echo 'Source guard regression passed; no Cargo or package build was started.'
