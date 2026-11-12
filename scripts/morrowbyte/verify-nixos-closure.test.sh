#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
directory="$(mktemp -d)"
trap 'rm -rf -- "$directory"' EXIT
version=0.0.47-nightly.20261014.16
asset="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest="$directory/${asset%.nar.zst}.json"
mkdir "$directory/bin"
export TEST_REAL_FIND="$(command -v find)"
export TEST_STORE_ROOT=/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-t3code-morrowbyte
export TEST_STORE_DEPENDENCY=/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-dependency
export TEST_FIND_ROOT="$directory/root-tree" TEST_FIND_DEPENDENCY="$directory/dependency-file"
mkdir -p "$TEST_FIND_ROOT/nested"
printf 'payload\n' >"$TEST_FIND_ROOT/nested/"$'file\nwith space'
ln -s nested "$TEST_FIND_ROOT/link"
printf 'dependency\n' >"$TEST_FIND_DEPENDENCY"
cat >"$directory/bin/find" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${TEST_COLD_STORE:-} == 1 && ! -e "$TEST_IMPORT_STATE" ]]; then
  printf 'find: %s: No such file or directory\n' "$1" >&2
  exit 1
fi
if [[ "$1" == "$TEST_STORE_ROOT" && -n ${TEST_FIND_MODE:-} ]]; then
  case "$TEST_FIND_MODE" in
    unsupported) printf 'd 4096\np 0\nf 8\n' ;;
    empty) : ;;
    payload-overflow) printf 'f 9007199254740991\nf 1\n' ;;
    nar-overflow) printf 'f 513\n' ;;
    failure) exit 94 ;;
    *) exit 95 ;;
  esac
  exit 0
fi
case "$1" in
  "$TEST_STORE_ROOT") member="$TEST_FIND_ROOT" ;;
  "$TEST_STORE_DEPENDENCY") member="$TEST_FIND_DEPENDENCY" ;;
  *) exit 93 ;;
esac
shift
exec "$TEST_REAL_FIND" "$member" "$@"
STUB
cat >"$directory/bin/zstd" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n ${TEST_ZSTD_TRACE:-} ]]; then printf 'decompress\n' >>"$TEST_ZSTD_TRACE"; fi
cat "${@: -1}"
[[ ${TEST_ZSTD_MODE:-} != failure ]] || exit 89
STUB
cat >"$directory/bin/nix" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *' path-info --recursive --json '* ]]; then
  printf 'path-info\n' >>"$TEST_NIX_TRACE"
  [[ -e "$TEST_IMPORT_STATE" ]] || exit 96
  case "${TEST_INFO_MODE:-valid}" in
    overflow) head -c 4194305 /dev/zero ;;
    *) cat "$TEST_PATH_INFO" ;;
  esac
  [[ ${TEST_INFO_MODE:-} != failure ]] || exit 97
  exit 0
fi
if [[ "$*" == *' store ls --json '* ]]; then
  [[ "${@: -1}" == "$TEST_STORE_ROOT/bin/t3code-morrowbyte" ]] || exit 98
  printf 'launcher\n' >>"$TEST_NIX_TRACE"
  case "${TEST_LAUNCHER_MODE:-valid}" in
    missing) exit 99 ;;
    nonexecutable) printf '{"type":"regular","executable":false}\n' ;;
    symlink) printf '{"type":"symlink","executable":true}\n' ;;
    multiple) printf '{"type":"regular","executable":true}\n%.0s' {1..2} ;;
    overflow) head -c 4194305 /dev/zero ;;
    *) printf '{"type":"regular","executable":true}\n' ;;
  esac
  [[ ${TEST_LAUNCHER_MODE:-} != failure ]] || exit 100
  exit 0
fi
[[ "$*" == *' hash to-sri --type sha256 '* ]] || exit 90
while [[ "$1" != sha256 ]]; do shift; done
shift
for hash do
  if [[ "$hash" =~ ^sha256:0{52}$ ]]; then
    printf 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n'
  else
    [[ "$hash" == sha256-* ]] || exit 91
    printf '%s\n' "$hash"
  fi
done
STUB
cat >"$directory/bin/nix-store" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  --import)
    [[ $# == 1 ]] || exit 101
    printf 'import\n' >>"$TEST_NIX_TRACE"
    cat >"$TEST_IMPORTED_BYTES"
    cmp -s "$TEST_ARCHIVE" "$TEST_IMPORTED_BYTES" || exit 102
    [[ ${TEST_IMPORT_MODE:-} != failure ]] || exit 103
    : >"$TEST_IMPORT_STATE"
    case "${TEST_IMPORT_MODE:-valid}" in
      missing) printf '%s\n' "$TEST_STORE_ROOT" ;;
      wrong) printf '%s\n' "$TEST_STORE_ROOT" /nix/store/cccccccccccccccccccccccccccccccc-wrong ;;
      extra) printf '%s\n' "$TEST_STORE_ROOT" "$TEST_STORE_DEPENDENCY" /nix/store/cccccccccccccccccccccccccccccccc-extra ;;
      duplicate) printf '%s\n' "$TEST_STORE_ROOT" "$TEST_STORE_DEPENDENCY" "$TEST_STORE_ROOT" ;;
      overflow) head -c 4194305 /dev/zero ;;
      *) printf '%s\n' "$TEST_STORE_DEPENDENCY" "$TEST_STORE_ROOT" ;;
    esac
    [[ ${TEST_IMPORT_MODE:-} != late-failure ]] || exit 104
    ;;
  --verify-path)
    [[ $# == 2 && ( $2 == "$TEST_STORE_ROOT" || $2 == "$TEST_STORE_DEPENDENCY" ) ]] || exit 105
    printf 'verify %s\n' "$2" >>"$TEST_NIX_TRACE"
    [[ ${TEST_VERIFY_FAIL:-} != "$2" ]] || exit 106
    ;;
  *) exit 107 ;;
esac
STUB
chmod +x "$directory/bin/zstd" "$directory/bin/nix" "$directory/bin/find" "$directory/bin/nix-store"
export PATH="$directory/bin:$PATH"
head -c 1024 /dev/zero > "$directory/$asset"
digest="$(sha256sum "$directory/$asset" | cut -d ' ' -f 1)"
bytes="$(stat -c '%s' "$directory/$asset")"
jq -n --arg version "$version" --arg asset "$asset" --arg digest "$digest" \
  --argjson bytes "$bytes" --arg root "$TEST_STORE_ROOT" --arg dependency "$TEST_STORE_DEPENDENCY" \
  '{schemaVersion:1,version:$version,sourceSha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",system:"x86_64-linux",
    compression:"zstd",asset:$asset,sha256:$digest,archiveBytes:$bytes,exportBytes:$bytes,
    storePath:$root,
    closure:[{path:$root,narHash:"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",narSize:512},
      {path:$dependency,narHash:"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",narSize:128}],
    allocationEntries:[{path:$root,fileCount:1,directoryCount:2,symlinkCount:1,payloadBytes:14},
      {path:$dependency,fileCount:1,directoryCount:0,symlinkCount:0,payloadBytes:11}]}' > "$manifest"
verify() { bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" "$version" "$directory"; }
verify
cp "$manifest" "$directory/valid.json"
for patch in '.version = "wrong"' '.asset = "../closure"' '.storePath = "/tmp/closure"' '.system = "aarch64-linux"' '.compression = "none"' \
  'del(.sourceSha)' '.sourceSha = "main"' 'del(.archiveBytes)' '.archiveBytes = 0' '.archiveBytes += 1' \
  'del(.exportBytes)' '.exportBytes = 0' '.exportBytes = 1.5' '.exportBytes += 1' '.exportBytes -= 1' \
  'del(.closure)' '.closure = []' '.closure += .closure' '.closure[0].narHash = "unknown"' \
  '.closure[0].narSize = 0' '.closure[0].narSize = 9999' '.closure[0].path = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-wrong-root"' \
  'del(.allocationEntries)' '.allocationEntries = []' '.allocationEntries |= reverse' \
  '.allocationEntries += .allocationEntries' '.allocationEntries |= .[:1]' \
  '.allocationEntries[0].path = "/nix/store/cccccccccccccccccccccccccccccccc-wrong"' \
  '.allocationEntries[0].extra = 0' 'del(.allocationEntries[0].fileCount)' \
  '.allocationEntries[0].fileCount = -1' '.allocationEntries[0].fileCount = 1.5' \
  '.allocationEntries[0].directoryCount = null' '.allocationEntries[0].symlinkCount = "1"' \
  '.allocationEntries[0].fileCount = 9007199254740992' \
  '.allocationEntries[0] += {fileCount:9007199254740991,directoryCount:1,symlinkCount:0}' \
  '.allocationEntries[0] += {fileCount:0,directoryCount:0,symlinkCount:0,payloadBytes:0}' \
  '.allocationEntries[0].payloadBytes = -1' '.allocationEntries[0].payloadBytes = 1.5' \
  '.allocationEntries[0].payloadBytes = 9007199254740992' '.allocationEntries[0].payloadBytes = 513' \
  '.allocationEntries[0].fileCount = 0' '.allocationEntries[0].directoryCount = 1' \
  '.allocationEntries[0].symlinkCount = 0' '.allocationEntries[0].payloadBytes = 13' \
  '.allocationEntries[1].payloadBytes = 10' '.allocationEntries[0].fileCount = 2'; do
  jq "$patch" "$directory/valid.json" > "$manifest"
  if verify; then echo "Accepted invalid closure metadata: $patch" >&2; exit 1; fi
done
store_path="$(jq -r .storePath "$directory/valid.json")"
jq '.closure' "$directory/valid.json" >"$directory/array.json"
jq '.closure | map({key:.path,value:{narHash:.narHash,narSize:.narSize,references:[]}}) | from_entries' "$directory/valid.json" >"$directory/object.json"
jq '.closure | map(.narHash = "sha256:0000000000000000000000000000000000000000000000000000")' "$directory/valid.json" >"$directory/base32.json"
bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" --allocation "$directory/array.json" >"$directory/allocation.json"
jq -e --slurpfile allocation "$directory/allocation.json" '.allocationEntries == $allocation[0]' "$directory/valid.json" >/dev/null
for mode in unsupported empty payload-overflow nar-overflow failure; do
  if TEST_FIND_MODE="$mode" bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" --allocation "$directory/array.json"; then
    echo "Accepted invalid filesystem allocation summary: $mode" >&2; exit 1
  fi
done
for shape in array object base32; do
  bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" --normalize "$store_path" "$directory/$shape.json" >"$directory/normalized.json"
  jq -e --slurpfile normalized "$directory/normalized.json" '.closure == $normalized[0]' "$directory/valid.json" >/dev/null
done
for patch in '.[0].narSize = 0' '.[0].narHash = null' '. += .' '. = []'; do
  jq "$patch" "$directory/array.json" >"$directory/bad-info.json"
  if bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" --normalize "$store_path" "$directory/bad-info.json"; then
    echo "Accepted invalid path-info JSON: $patch" >&2; exit 1
  fi
done
cp "$directory/valid.json" "$manifest"
source_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export TEST_COLD_STORE=1 TEST_IMPORT_STATE="$directory/import-state"
export TEST_NIX_TRACE="$directory/nix-trace" TEST_ZSTD_TRACE="$directory/zstd-trace"
export TEST_IMPORTED_BYTES="$directory/imported-bytes" TEST_ARCHIVE="$directory/$asset"
export TEST_PATH_INFO="$directory/path-info.json" TEST_IMPORT_TMP="$directory/import-tmp"
mkdir "$TEST_IMPORT_TMP"
verify_import() {
  NIX_REMOTE=local NIX_STORE_DIR= NIX_STATE_DIR= TMPDIR="$TEST_IMPORT_TMP" \
    bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" --import "$version" "$directory" "${1:-$source_sha}"
}
reset_import() {
  rm -f -- "$TEST_IMPORT_STATE" "$TEST_IMPORTED_BYTES"
  : >"$TEST_NIX_TRACE"
  : >"$TEST_ZSTD_TRACE"
}
assert_import_cleanup() {
  [[ -z "$("$TEST_REAL_FIND" "$TEST_IMPORT_TMP" -mindepth 1 -print -quit)" ]] || {
    echo 'Verifier retained temporary export or metadata' >&2; exit 1;
  }
}
import_must_fail() {
  if verify_import; then echo 'Accepted invalid imported closure' >&2; exit 1; fi
  assert_import_cleanup
}
assert_not_imported() {
  [[ ! -s "$TEST_NIX_TRACE" && ! -e "$TEST_IMPORT_STATE" && ! -e "$TEST_IMPORTED_BYTES" ]] || {
    echo 'Invalid input reached Nix before validation completed' >&2; exit 1;
  }
}
# Exercise the legacy invocation with a missing Store, rather than an unknown flag.
reset_import
if verify >"$directory/cold-legacy.log" 2>&1; then
  echo 'Legacy mode accepted a missing builder Store' >&2; exit 1
fi
[[ "$(cat "$directory/cold-legacy.log")" == *'No such file or directory'* ]]
[[ "$(cat "$directory/cold-legacy.log")" == *'allocation exceeds NAR size or has no nodes'* ]]
assert_not_imported
for shape in array object base32; do
  cp "$directory/$shape.json" "$TEST_PATH_INFO"
  reset_import
  verify_import
  cmp -s "$TEST_ARCHIVE" "$TEST_IMPORTED_BYTES"
  printf 'import\npath-info\nverify %s\nverify %s\nlauncher\n' \
    "$TEST_STORE_ROOT" "$TEST_STORE_DEPENDENCY" >"$directory/expected-trace"
  cmp -s "$TEST_NIX_TRACE" "$directory/expected-trace"
  [[ "$(cat "$TEST_ZSTD_TRACE")" == decompress ]]
  assert_import_cleanup
done
cp "$directory/array.json" "$TEST_PATH_INFO"
for patch in '.schemaVersion = 2' '.version = "wrong"' '.system = "aarch64-linux"' \
  '.asset = "../closure"' '.compression = "none"' '.sourceSha = "main"' \
  '.sourceSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' \
  '.sha256 = "bad"' '.sha256 = ("0" * 64)' '.archiveBytes += 1' \
  '.exportBytes += 1' '.exportBytes -= 1' '.exportBytes = 9007199254740992' \
  '.exportBytes = 1.5' 'del(.exportBytes)' '.closure = []' '.closure += .closure' \
  '.closure[0].narHash = "bad"' '.closure[0].narSize = 0' '.allocationEntries = []' \
  '.allocationEntries[0].extra = true'; do
  jq "$patch" "$directory/valid.json" >"$manifest"
  reset_import
  import_must_fail
  assert_not_imported
done
cp "$directory/valid.json" "$manifest"
reset_import
if verify_import invalid; then echo 'Accepted invalid expected source SHA' >&2; exit 1; fi
assert_not_imported
assert_import_cleanup
cat "$directory/valid.json" "$directory/valid.json" >"$manifest"
reset_import
import_must_fail
assert_not_imported
cp "$directory/valid.json" "$manifest"
for setting in NIX_REMOTE=ssh://untrusted NIX_STORE_DIR=/tmp/store NIX_STATE_DIR=/tmp/state; do
  reset_import
  if env NIX_REMOTE=local NIX_STORE_DIR= NIX_STATE_DIR= TMPDIR="$TEST_IMPORT_TMP" "$setting" \
    bash "$root/scripts/morrowbyte/verify-nixos-closure.sh" --import "$version" "$directory" "$source_sha"; then
    echo "Accepted redirected Nix Store: $setting" >&2; exit 1
  fi
  assert_not_imported
  assert_import_cleanup
done
reset_import
TEST_ZSTD_MODE=failure import_must_fail
assert_not_imported
for mode in failure late-failure missing wrong extra duplicate overflow; do
  reset_import
  TEST_IMPORT_MODE="$mode" import_must_fail
  [[ "$(cat "$TEST_NIX_TRACE")" == import ]]
done
for patch in '.[0].narHash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="' \
  '.[1].narHash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="' \
  '.[0].narSize += 1' '.[1].narSize += 1' '. = .[:1]' \
  '.[1].path = "/nix/store/cccccccccccccccccccccccccccccccc-wrong"' \
  '. += [{path:"/nix/store/cccccccccccccccccccccccccccccccc-extra",narHash:.[0].narHash,narSize:1}]'; do
  jq "$patch" "$directory/array.json" >"$TEST_PATH_INFO"
  reset_import
  import_must_fail
  [[ "$(cat "$TEST_NIX_TRACE")" == $'import\npath-info' ]]
done
cp "$directory/array.json" "$TEST_PATH_INFO"
cat "$directory/array.json" "$directory/array.json" >"$TEST_PATH_INFO"
reset_import
import_must_fail
[[ "$(cat "$TEST_NIX_TRACE")" == $'import\npath-info' ]]
cp "$directory/array.json" "$TEST_PATH_INFO"
for mode in failure overflow; do
  reset_import
  TEST_INFO_MODE="$mode" import_must_fail
  [[ "$(cat "$TEST_NIX_TRACE")" == $'import\npath-info' ]]
done
for member in "$TEST_STORE_ROOT" "$TEST_STORE_DEPENDENCY"; do
  reset_import
  TEST_VERIFY_FAIL="$member" import_must_fail
  [[ "$(cat "$TEST_NIX_TRACE")" != *launcher* ]]
done
for mode in missing nonexecutable symlink multiple failure overflow; do
  reset_import
  TEST_LAUNCHER_MODE="$mode" import_must_fail
  [[ "$(cat "$TEST_NIX_TRACE")" == *launcher ]]
done
for mode in unsupported empty payload-overflow nar-overflow failure; do
  reset_import
  TEST_FIND_MODE="$mode" import_must_fail
done
jq '.allocationEntries[1].payloadBytes -= 1' "$directory/valid.json" >"$manifest"
reset_import
import_must_fail
[[ "$(cat "$TEST_NIX_TRACE")" == *launcher ]]
cp "$directory/valid.json" "$manifest"
reset_import
printf 'corruption\n' >>"$directory/$asset"
import_must_fail
assert_not_imported
head -c 1024 /dev/zero >"$directory/$asset"
unset TEST_COLD_STORE TEST_ZSTD_TRACE
printf 'corruption\n' >> "$directory/$asset"
if verify; then echo 'Accepted corrupt closure' >&2; exit 1; fi
