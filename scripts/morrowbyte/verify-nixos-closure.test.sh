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
cat "${@: -1}"
STUB
cat >"$directory/bin/nix" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
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
chmod +x "$directory/bin/zstd" "$directory/bin/nix" "$directory/bin/find"
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
printf 'corruption\n' >> "$directory/$asset"
if verify; then echo 'Accepted corrupt closure' >&2; exit 1; fi
