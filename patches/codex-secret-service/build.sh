#!/usr/bin/env bash
# Intent: Build the pinned patched Linux x64 runtime with its own immutable version.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 || $(uname -sm) != 'Linux x86_64' ]]; then
    echo "Usage on Linux x64: $0 /codex-source /private-target-dir /musl-build.env [build|test|verify]" >&2
    exit 2
fi

source_root=$(realpath "$1")
target_root=$(realpath -m "$2")
environment_file=$(realpath "$3")
patch_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_commit=83086188ae0614bd882818ff1aa23f3194962012
runtime_version=0.163.0-morrowbyte.2

test "$(git -C "$source_root" rev-parse HEAD)" = "$source_commit"
mkdir -p "$target_root"
patch_index=$(mktemp "$target_root/patch-index.XXXXXX")
rm -- "$patch_index"
trap 'rm -f -- "$patch_index" "$patch_index.lock"' EXIT
export GIT_INDEX_FILE="$patch_index"
git -C "$source_root" read-tree "$source_commit"
for patch_file in 0001-linux-noninteractive-keyring-reads.patch 0002-noninteractive-refresh-save.patch; do
    git -C "$source_root" apply --cached "$patch_root/$patch_file"
done
expected_tree=$(git -C "$source_root" write-tree)
git -C "$source_root" add -A -- .
git -C "$source_root" diff --cached --exit-code "$expected_tree" -- . \
    ':(exclude)codex-rs/Cargo.toml' ':(exclude)codex-rs/Cargo.lock'
unset GIT_INDEX_FILE

python3 - "$source_root" "$runtime_version" "$expected_tree" <<'PY'
import pathlib
import subprocess
import sys
import tomllib

source = pathlib.Path(sys.argv[1])
version = sys.argv[2]
expected_tree = sys.argv[3]
def expected(path):
    return subprocess.check_output(['git', '-C', str(source), 'show', f'{expected_tree}:{path}'], text=True)
def normalize_manifest(text):
    current_version = tomllib.loads(text)['workspace']['package']['version']
    assert current_version in ('0.163.0', '0.163.0-morrowbyte.1', version)
    return text.replace(f'version = "{current_version}"', f'version = "{version}"', 1)
def normalize_lock(text):
    sections = text.split('[[package]]')
    for index, section in enumerate(sections[1:], 1):
        if '\nsource = ' not in section:
            for previous in ('0.0.0', '0.163.0-morrowbyte.1'):
                section = section.replace(f'version = "{previous}"', f'version = "{version}"', 1)
            sections[index] = section
    return '[[package]]'.join(sections)

manifest = source / 'codex-rs/Cargo.toml'
lock = source / 'codex-rs/Cargo.lock'
for path in (manifest, lock):
    assert not path.is_symlink() and not path.stat().st_mode & 0o111, f'Unexpected file mode: {path.name}'
normalized_manifest = normalize_manifest(manifest.read_text())
normalized_lock = normalize_lock(lock.read_text())
assert normalized_manifest == normalize_manifest(expected('codex-rs/Cargo.toml')), 'Unexpected workspace manifest change'
assert normalized_lock == normalize_lock(expected('codex-rs/Cargo.lock')), 'Unexpected lockfile change'
manifest.write_text(normalized_manifest)
lock.write_text(normalized_lock)
PY

if [[ ${4:-build} == verify ]]; then
    echo "Verified the complete patched source tree and runtime version."
    exit 0
fi

while IFS='=' read -r variable_name variable_value; do
    [[ -n "$variable_name" && "$variable_name" != \#* ]] || continue
    [[ "$variable_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]
    export "$variable_name=$variable_value"
done < "$environment_file"

bash "$patch_root/setup-v8.sh" "$source_root" "$target_root/rusty-v8"
while IFS='=' read -r variable_name variable_value; do
    export "$variable_name=$variable_value"
done < "$target_root/rusty-v8/environment"

command -v ld.lld >/dev/null
command -v x86_64-linux-gnu-gcc >/dev/null
mkdir -p "$target_root/linker"
cat > "$target_root/linker/gcc-with-lld" <<'LINKER'
#!/usr/bin/env bash
exec x86_64-linux-gnu-gcc -fuse-ld=lld "$@"
LINKER
chmod +x "$target_root/linker/gcc-with-lld"
export REALGCC="$target_root/linker/gcc-with-lld"

export CARGO_TARGET_DIR="$target_root"
export CARGO_BUILD_JOBS=1
export CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_PROFILE_RELEASE_LTO=off
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export STABLE_GIT_COMMIT="$source_commit"
export RUSTFLAGS="--remap-path-prefix=$source_root=/codex-source"
export AWS_LC_SYS_NO_JITTER_ENTROPY=1
export CODEX_BWRAP_SHA256=77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c

cd "$source_root/codex-rs"
case ${4:-build} in
    build)
        cargo build --release --locked --target x86_64-unknown-linux-musl \
            -p codex-cli --bin codex \
            -p codex-code-mode-host --bin codex-code-mode-host
        ;;
    test)
        cargo test --release --locked --target x86_64-unknown-linux-musl \
            -p codex-keyring-store --lib linux::tests
        cargo test --release --locked --target x86_64-unknown-linux-musl \
            -p codex-rmcp-client --lib oauth::tests::credential_store_tests::save_publishes_only_persisted_credentials
        ;;
    *) echo "Expected build or test" >&2; exit 2 ;;
esac
