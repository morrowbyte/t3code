#!/usr/bin/env bash
set -euo pipefail
allocation_entries() {
  local members="$1" scratch="$2" member_path member_nar_size
  jq -e '
    def positive: type == "number" and . > 0 and . <= 9007199254740991 and floor == .;
    type == "array" and length > 0 and length <= 10000 and
    all(.[]; (.path | type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$")) and
      (.narHash | type == "string" and test("^sha256-[A-Za-z0-9+/]{43}=$")) and (.narSize | positive)) and
    . == (map({path,narHash,narSize}) | sort_by(.path)) and (map(.path) | unique | length) == length
  ' "$members" >/dev/null
  jq -r '.[] | [.path,.narSize] | @tsv' "$members" >"$scratch/member-sizes"
  : >"$scratch/allocation-entries"
  while IFS=$'\t' read -r member_path member_nar_size; do
    # NAR nodes exclude special files; never parse a filename or follow a symlink.
    find "$member_path" -printf '%y %s\n' | jq -Rnec --arg path "$member_path" --argjson narSize "$member_nar_size" '
      def nonnegative: type == "number" and . >= 0 and . <= 9007199254740991 and floor == .;
      reduce inputs as $line ({path:$path,fileCount:0,directoryCount:0,symlinkCount:0,payloadBytes:0};
        ($line | if test("^[fdl] [0-9]+$") then capture("^(?<kind>[fdl]) (?<bytes>[0-9]+)$")
          else error("invalid allocation node") end) as $node |
        ($node.bytes | tonumber) as $bytes |
        if ($bytes | nonnegative) then
          if $node.kind == "d" then .directoryCount += 1 else
            if $node.kind == "f" then .fileCount += 1 else .symlinkCount += 1 end |
            if .payloadBytes <= 9007199254740991 - $bytes then .payloadBytes += $bytes
            else error("allocation payload overflow") end
          end |
          if (.fileCount + .directoryCount + .symlinkCount) <= 9007199254740991 then .
          else error("allocation node count overflow") end
        else error("invalid allocation size") end) |
      if (.fileCount + .directoryCount + .symlinkCount) > 0 and .payloadBytes <= $narSize then .
      else error("allocation exceeds NAR size or has no nodes") end
    ' >>"$scratch/allocation-entries"
  done <"$scratch/member-sizes"
  jq -sc '.' "$scratch/allocation-entries"
}
if [[ ${1:-} == --allocation ]]; then
  [[ $# == 2 ]] || { echo "Usage: $0 --allocation MEMBERS_JSON" >&2; exit 2; }
  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' EXIT
  allocation_entries "$2" "$work_dir"
  exit 0
fi
if [[ ${1:-} == --normalize ]]; then
  [[ $# == 3 ]] || exit 2
  store_path="$2"
  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' EXIT
  jq -ce --arg root "$store_path" '
    def positive: type == "number" and . > 0 and . <= 9007199254740991 and floor == .;
    (if type == "array" then . elif type == "object" then
      to_entries | map(.value + {path:.key}) else error("invalid path-info JSON") end) |
    map({path,narHash,narSize}) | sort_by(.path) |
    if length > 0 and length <= 10000 and
      all(.[]; (.path | type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$")) and
        (.narHash | type == "string" and test("^sha256[:-][A-Za-z0-9+/=]+$")) and (.narSize | positive)) and
      (map(.path) | unique | length) == length and any(.[]; .path == $root)
    then . else error("invalid closure membership") end
  ' "$3" >"$work_dir/members.json"
  jq -r '.[].narHash' "$work_dir/members.json" >"$work_dir/hashes"
  mapfile -t hashes <"$work_dir/hashes"
  nix --extra-experimental-features nix-command hash to-sri --type sha256 "${hashes[@]}" >"$work_dir/sri"
  jq -Rsc 'split("\n") | map(select(length > 0))' "$work_dir/sri" >"$work_dir/sri.json"
  jq -ce --slurpfile hashes "$work_dir/sri.json" '
    if length != ($hashes[0] | length) then error("hash conversion failed") else
      to_entries | map(.value + {narHash:$hashes[0][.key]}) end
  ' "$work_dir/members.json"
  exit 0
fi
import_closure=false
expected_source=''
if [[ ${1:-} == --import ]]; then
  import_closure=true
  shift
  [[ $# == 3 && ${3:-} =~ ^[0-9a-f]{40}$ ]] || {
    echo "Usage: $0 --import VERSION ASSETS_DIR EXPECTED_SOURCE_SHA" >&2
    exit 2
  }
  expected_source="$3"
  set -- "$1" "$2"
fi
[[ $# == 2 ]] || { echo "Usage: $0 VERSION ASSETS_DIR" >&2; exit 2; }
version="$1"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]] || exit 2
directory="$2"
asset="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest="$directory/${asset%.nar.zst}.json"
[[ -s "$directory/$asset" && -s "$manifest" ]]
(( $(stat -c '%s' "$manifest") <= 4194304 ))
jq -se --arg version "$version" --arg asset "$asset" --arg source "$expected_source" '
  def positive: type == "number" and . > 0 and . <= 9007199254740991 and floor == .;
  def nonnegative: type == "number" and . >= 0 and . <= 9007199254740991 and floor == .;
  def store: type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$");
  length == 1 and (.[0] |
  .schemaVersion == 1 and .version == $version and .system == "x86_64-linux" and
  .compression == "zstd" and .asset == $asset and
  (.storePath | store) and (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
  (.sourceSha | type == "string" and test("^[0-9a-f]{40}$")) and
  ($source == "" or .sourceSha == $source) and
  (.archiveBytes | positive) and (.exportBytes | positive) and
  (.closure | type == "array" and length > 0 and length <= 10000) and
  all(.closure[]; (.path | store) and (.narSize | positive) and
    (.narHash | type == "string" and test("^sha256-[A-Za-z0-9+/]{43}=$"))) and
  (.closure == (.closure | map({path,narHash,narSize}) | sort_by(.path))) and
  ((.closure | map(.path) | unique | length) == (.closure | length)) and
  (.storePath as $root | any(.closure[]; .path == $root)) and
  (([.closure[].narSize] | add) <= .exportBytes) and
  (.allocationEntries | type == "array") and
  (.allocationEntries == (.allocationEntries | map({path,fileCount,directoryCount,symlinkCount,payloadBytes}) | sort_by(.path))) and
  ((.allocationEntries | map(.path)) == (.closure | map(.path))) and
  all(.allocationEntries[]; (.fileCount | nonnegative) and (.directoryCount | nonnegative) and
    (.symlinkCount | nonnegative) and (.payloadBytes | nonnegative) and
    ((.fileCount + .directoryCount + .symlinkCount) | positive)) and
  (.closure as $members | all(.allocationEntries | to_entries[]; .value.payloadBytes <= $members[.key].narSize)))
' "$manifest" >/dev/null
[[ "$(stat -c '%s' "$directory/$asset")" == "$(jq -r .archiveBytes "$manifest")" ]]
expected="$(jq -r .sha256 "$manifest")"
actual="$(sha256sum "$directory/$asset" | cut -d ' ' -f 1)"
[[ "$expected" == "$actual" ]]
export_bytes="$(jq -r .exportBytes "$manifest")"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
if [[ "$import_closure" == true ]]; then
  [[ -z ${NIX_REMOTE:-} || $NIX_REMOTE == local || $NIX_REMOTE == daemon ]]
  [[ -z ${NIX_STORE_DIR:-} && -z ${NIX_STATE_DIR:-} ]]
  # Import the same bounded bytes whose decompressor status and length passed.
  zstd --decompress --stdout --memory=64MB "$directory/$asset" |
    head -c "$((export_bytes + 1))" >"$work_dir/export"
  [[ "$(stat -c '%s' "$work_dir/export")" -eq "$export_bytes" ]]
else
  zstd --decompress --stdout --memory=64MB "$directory/$asset" |
    head -c "$((export_bytes + 1))" | wc -c >"$work_dir/export-bytes"
  [[ "$(cat "$work_dir/export-bytes")" -eq "$export_bytes" ]]
fi
jq '.closure' "$manifest" >"$work_dir/members.json"
if [[ "$import_closure" == true ]]; then
  nix-store --import <"$work_dir/export" | head -c 4194305 >"$work_dir/imported"
  (( $(stat -c '%s' "$work_dir/imported") <= 4194304 ))
  LC_ALL=C sort "$work_dir/imported" >"$work_dir/imported-sorted"
  jq -r '.[].path' "$work_dir/members.json" >"$work_dir/expected-paths"
  cmp -s "$work_dir/imported-sorted" "$work_dir/expected-paths"
  store_path="$(jq -r .storePath "$manifest")"
  nix --extra-experimental-features nix-command path-info --recursive --json "$store_path" |
    head -c 4194305 >"$work_dir/path-info.json"
  (( $(stat -c '%s' "$work_dir/path-info.json") <= 4194304 ))
  jq -se 'length == 1' "$work_dir/path-info.json" >/dev/null
  bash "$0" --normalize "$store_path" "$work_dir/path-info.json" >"$work_dir/actual-closure.json"
  jq -e --slurpfile actual "$work_dir/actual-closure.json" '.closure == $actual[0]' "$manifest" >/dev/null
  while IFS= read -r member_path; do
    nix-store --verify-path "$member_path" >/dev/null
  done <"$work_dir/expected-paths"
  nix --extra-experimental-features nix-command store ls --json "$store_path/bin/t3code-morrowbyte" |
    head -c 4194305 >"$work_dir/launcher.json"
  (( $(stat -c '%s' "$work_dir/launcher.json") <= 4194304 ))
  jq -se 'length == 1 and (.[0] | .type == "regular" and .executable == true)' "$work_dir/launcher.json" >/dev/null
fi
allocation_entries "$work_dir/members.json" "$work_dir" >"$work_dir/actual-allocation.json"
jq -e --slurpfile actual "$work_dir/actual-allocation.json" '.allocationEntries == $actual[0]' "$manifest" >/dev/null || {
  echo 'filesystem allocation metadata differs from manifest' >&2
  exit 1
}
