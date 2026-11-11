#!/usr/bin/env bash
set -euo pipefail

repo="${T3_MORROWBYTE_REPOSITORY:-morrowbyte/t3code}"
channel="${T3_MORROWBYTE_CHANNEL:-nightly}"
base_dir="${T3_MORROWBYTE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/t3code-morrowbyte}"
install_dir="$base_dir/versions"
current_link="$base_dir/current"
mode="${1:---update}"
managed="${T3_MORROWBYTE_MANAGED:-0}"
legacy_executable="${T3_MORROWBYTE_LEGACY_EXECUTABLE_NAME:-}"
release_prefix="${T3_MORROWBYTE_RELEASE_NAME_PREFIX:-Morrowbyte}"
previous_release_prefix="${T3_MORROWBYTE_PREVIOUS_RELEASE_NAME_PREFIX:-}"
die() { printf 't3code-morrowbyte: %s\n' "$*" >&2; exit 1; }
valid_version() { [[ "$1" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]*$ ]]; }
installed_version() { if [[ -L "$current_link" ]]; then basename "$(readlink "$current_link")"; fi; }
restore_home=""
new_installation=0
[[ -e "$base_dir" || -L "$base_dir" ]] || new_installation=1
home_binding="$base_dir/restore-home.json"
inventory_file="$base_dir/installer-roots.json"
declare -A owned_roots=() evicted_roots=()
candidate_version="" candidate_store=""
import_ledger='[]'
pending_import='null'
needs_import=1
desktop_lock="" lock_owner="" lock_recovery="" lock_observed="" work_dir=""
lock_recovery_open=0
cleanup() {
  if [[ -n "$desktop_lock" && -n "$lock_owner" && -f "$desktop_lock" && ! -L "$desktop_lock" && "$desktop_lock" -ef "$lock_owner" ]]; then rm -- "$desktop_lock"; fi
  if [[ "$lock_recovery_open" == 1 ]]; then exec 8>&-; fi
  [[ -z "$lock_observed" ]] || rm -f -- "$lock_observed"
  [[ -z "$lock_owner" ]] || rm -f -- "$lock_owner"
  [[ -z "$work_dir" ]] || rm -rf -- "$work_dir"
}
trap cleanup EXIT
resolve_restore_home() {
  local explicit_home="" bound_home binding_mode
  if [[ -n "${T3CODE_HOME:-}" ]]; then
    [[ "$T3CODE_HOME" == /* ]] || die 'T3CODE_HOME must be absolute'
    explicit_home="$(realpath -m -- "$T3CODE_HOME")" || die 'AppHome cannot be resolved'
  fi
  if [[ -e "$home_binding" || -L "$home_binding" ]]; then
    [[ -f "$home_binding" && ! -L "$home_binding" ]] || die 'invalid restore home binding'
    binding_mode="$(stat -c '%a' -- "$home_binding")" || die 'cannot verify restore home binding permissions'
    [[ "$(stat -c '%u' -- "$home_binding")" == "$(id -u)" ]] && (( (8#$binding_mode & 8#022) == 0 )) || die 'unsafe restore home binding ownership or permissions'
    bound_home="$(jq -er 'select(.format == 1) | .baseDir | select(type == "string" and startswith("/") and (contains("\n") | not))' "$home_binding")" || die 'invalid restore home binding'
    [[ -d "$bound_home" && "$(realpath -e -- "$bound_home")" == "$bound_home" ]] || die 'restore AppHome identity changed'
    [[ -z "$explicit_home" || "$explicit_home" == "$bound_home" ]] || die 'T3CODE_HOME disagrees with the restore home binding'
    restore_home="$bound_home"
  elif [[ -n "$explicit_home" ]]; then
    restore_home="$explicit_home"
  elif [[ "$new_installation" == 1 && ! -e "${XDG_BIN_HOME:-$HOME/.local/bin}/t3code-morrowbyte" && ! -L "${XDG_BIN_HOME:-$HOME/.local/bin}/t3code-morrowbyte" ]]; then
    restore_home="$(realpath -m -- "$base_dir")" || die 'AppHome cannot be resolved'
  else
    die 'installation AppHome is unknown; set T3CODE_HOME explicitly to bind it'
  fi
}
bind_restore_home() {
  resolve_restore_home
  mkdir -p "$restore_home"
  [[ "$(realpath -e -- "$restore_home")" == "$restore_home" ]] || die 'restore AppHome identity changed'
  if [[ ! -e "$home_binding" && ! -L "$home_binding" ]]; then
    local next
    next="$(mktemp "$base_dir/.restore-home.XXXXXX")"
    jq -n --arg baseDir "$restore_home" '{format:1,baseDir:$baseDir}' >"$next"
    chmod 0600 "$next"
    # A concurrent registry writer may establish the same binding first.
    ln -T -- "$next" "$home_binding" 2>/dev/null || [[ -e "$home_binding" ]] || die 'could not bind restore AppHome'
    rm -f -- "$next"
    resolve_restore_home
  fi
}
valid_install() {
  local target
  target="$(readlink -f "$install_dir/$1" 2>/dev/null)" || return 1
  [[ "$target" == /nix/store/* ]] || return 1
  [[ -x "$target/bin/t3code-morrowbyte" || ( -n "$legacy_executable" && -x "$target/bin/$legacy_executable" ) ]]
}
assert_update_not_held() {
  local restore_dir="$restore_home/runtime/desktop-restore"
  [[ ! -e "$restore_dir/transaction.json" && ! -L "$restore_dir/transaction.json" ]] || die 'desktop restore recovery is pending; updates are held'
  if [[ -e "$restore_dir/registry.json" || -L "$restore_dir/registry.json" ]]; then
    jq -e '.format == 1 and .updateHold == false' "$restore_dir/registry.json" >/dev/null || die 'desktop updates are held; resume them explicitly'
  fi
}
write_inventory() {
  local next="$base_dir/.installer-roots.$$"
  jq -n --arg candidateVersion "$candidate_version" --arg candidateStore "$candidate_store" \
    --argjson imports "$import_ledger" \
    --argjson pendingImport "$pending_import" \
    --argjson ownedRoots "$(printf '%s\n' "${!owned_roots[@]}" | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')" \
    --argjson pendingEvictions "$(printf '%s\n' "${!evicted_roots[@]}" | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')" \
    '{format:1, candidate:(if $candidateVersion == "" then null else {version:$candidateVersion,storePath:$candidateStore} end), ownedRoots:$ownedRoots, pendingEvictions:$pendingEvictions, imports:$imports, pendingImport:$pendingImport}' >"$next"
  chmod 0600 "$next"
  mv -Tf "$next" "$inventory_file"
}
load_inventory() {
  local path receipt version store
  owned_roots=() evicted_roots=()
  candidate_version="" candidate_store=""
  [[ ! -L "$base_dir/.gcroots" ]] || die 'installer GC-root directory must not be a symlink'
  if [[ -e "$inventory_file" || -L "$inventory_file" ]]; then
    [[ -f "$inventory_file" && ! -L "$inventory_file" ]] || die 'invalid installer root inventory'
    (( $(stat -c '%s' "$inventory_file") <= 4194304 )) || die 'installer root inventory exceeds metadata bound'
    jq -e '
      def store: type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$");
      .format == 1 and (.ownedRoots | type == "array") and all(.ownedRoots[]; store) and
      (.pendingEvictions | type == "array") and all(.pendingEvictions[]; store) and
      (.candidate == null or (.candidate.version | type == "string" and test("^[0-9A-Za-z][0-9A-Za-z.+_-]*$")) and (.candidate.storePath | store))
    ' "$inventory_file" >/dev/null || die 'invalid installer root inventory'
    while IFS= read -r path; do owned_roots["$path"]=1; done < <(jq -r '.ownedRoots[]' "$inventory_file")
    while IFS= read -r path; do
      [[ -n "${owned_roots[$path]:-}" ]] || die 'invalid installer eviction ownership'
      evicted_roots["$path"]=1
    done < <(jq -r '.pendingEvictions[]' "$inventory_file")
    candidate_version="$(jq -r '.candidate.version // ""' "$inventory_file")"
    candidate_store="$(jq -r '.candidate.storePath // ""' "$inventory_file")"
    import_ledger="$(jq -ce '.imports // [] | if type == "array" and length <= 10000 then . else error("invalid import ledger") end' "$inventory_file")" || die 'invalid import ledger'
    pending_import="$(jq -c '.pendingImport // null' "$inventory_file")"
  fi
  # Legacy roots are ours only when both installed link and receipt prove them.
  for receipt in "$base_dir"/prepared/*.json; do
    [[ -f "$receipt" && ! -L "$receipt" ]] || continue
    version="${receipt##*/}"; version="${version%.json}"
    valid_version "$version" || continue
    store="$(jq -er --arg version "$version" --arg repository "$repo" '
      select(.schemaVersion == 1 and .version == $version and .repository == $repository and
        (.channel == "nightly" or .channel == "stable") and .system == "x86_64-linux" and
        (.sha256 | type == "string" and test("^[a-f0-9]{64}$"))) |
      .storePath | select(type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$"))
    ' "$receipt" 2>/dev/null)" || continue
    path="$base_dir/.gcroots/${store##*/}"
    if [[ -L "$install_dir/$version" && "$(readlink "$install_dir/$version")" == "$store" && -L "$path" && "$(readlink "$path")" == "$store" ]]; then
      owned_roots["$store"]=1
    fi
  done
}
reconcile_roots() {
  local store path selected
  local -A keep=()
  for selected in "$current_link" "$base_dir/previous"; do
    [[ -L "$selected" ]] || continue
    store="$(readlink -m -- "$selected")" || die 'installed selection cannot be resolved'
    [[ "$store" =~ ^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$ ]] || die 'invalid installed selection'
    keep["$store"]=1
    if [[ "$store" == "$candidate_store" ]]; then candidate_version="" candidate_store=""; fi
  done
  [[ -z "$candidate_store" ]] || keep["$candidate_store"]=1
  for store in "${!owned_roots[@]}"; do
    path="$base_dir/.gcroots/${store##*/}"
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -L "$path" && "$(readlink "$path")" == "$store" ]] || die 'owned installer GC root changed'
    fi
    if [[ -n "${keep[$store]:-}" ]]; then unset 'evicted_roots[$store]'; else evicted_roots["$store"]=1; fi
  done
  write_inventory
  for store in "${!evicted_roots[@]}"; do
    path="$base_dir/.gcroots/${store##*/}"
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -L "$path" && "$(readlink "$path")" == "$store" ]] || die 'owned installer GC root changed'
      rm -- "$path"
    fi
    unset 'owned_roots[$store]'
  done
  evicted_roots=()
  write_inventory
}
select_candidate_root() {
  candidate_version="$1" candidate_store="$2"
  owned_roots["$2"]=1
  reconcile_roots
}
retain_candidate_root() {
  local store="$1" root="$base_dir/.gcroots/${1##*/}"
  if [[ -e "$root" || -L "$root" ]]; then
    [[ -L "$root" && "$(readlink "$root")" == "$store" ]] || die 'owned installer GC root changed'
  else
    nix-store --add-root "$root" --indirect --realise "$store" \
      --option max-jobs 0 --option builders '' --option substitute false >/dev/null
  fi
  [[ -L "$root" && "$(readlink "$root")" == "$store" ]] || die 'installer GC root was not registered'
}
read_closure() {
  local root="$1"
  nix --extra-experimental-features nix-command path-info --recursive --json "$root" |
    head -c 4194305 >"$work_dir/path-info.json" || die 'closure membership is unavailable'
  (( $(stat -c '%s' "$work_dir/path-info.json") <= 4194304 )) || die 'closure membership exceeds metadata bound'
  jq -ce --arg root "$root" '
    (if type == "array" then . elif type == "object" then to_entries | map(.value + {path:.key})
      else error("invalid path-info JSON") end) | map({path,narHash,narSize}) | sort_by(.path) |
    if length > 0 and length <= 10000 and
      all(.[]; (.path | type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$")) and
        (.narHash | type == "string" and test("^sha256[:-][A-Za-z0-9+/=]+$")) and
        (.narSize | type == "number" and . > 0 and . <= 9007199254740991 and floor == .)) and
      (map(.path) | unique | length) == length and any(.[]; .path == $root)
    then . else error("invalid closure membership") end
  ' "$work_dir/path-info.json" >"$work_dir/members.json" || die 'invalid closure membership'
  jq -r '.[].narHash' "$work_dir/members.json" >"$work_dir/hashes"
  local -a hashes
  mapfile -t hashes <"$work_dir/hashes"
  nix --extra-experimental-features nix-command hash to-sri --type sha256 "${hashes[@]}" >"$work_dir/sri" || die 'cannot canonicalize NAR hashes'
  jq -Rsc 'split("\n") | map(select(length > 0))' "$work_dir/sri" >"$work_dir/sri.json"
  jq -ce --slurpfile hashes "$work_dir/sri.json" '
    if length != ($hashes[0] | length) then error("hash conversion failed") else
      to_entries | map(.value + {narHash:$hashes[0][.key]}) end
  ' "$work_dir/members.json" || die 'cannot canonicalize closure membership'
}
walk_allocation_nodes() {
  local node="$1" child size
  if [[ -L "$node" ]]; then
    size="$(stat -c '%s' -- "$node")" || return 1
    printf 'l %s\n' "$size"
  elif [[ -f "$node" ]]; then
    size="$(stat -c '%s' -- "$node")" || return 1
    printf 'f %s\n' "$size"
  elif [[ -d "$node" ]]; then
    printf 'd 0\n'
    for child in "$node"/*; do walk_allocation_nodes "$child" || return 1; done
  else
    return 1
  fi
}
read_allocation() {
  local path nar_size
  jq -r '.[] | [.path,.narSize] | @tsv' "$work_dir/actual-closure.json" >"$work_dir/closure-sizes"
  : >"$work_dir/actual-allocation"
  while IFS=$'\t' read -r path nar_size; do
    {
      if command -v find >/dev/null 2>&1; then find "$path" -printf '%y %s\n'
      else (shopt -s nullglob dotglob; walk_allocation_nodes "$path"); fi
    } | jq -Rnce --arg path "$path" --argjson narSize "$nar_size" '
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
    ' >>"$work_dir/actual-allocation" || die 'invalid closure allocation'
  done <"$work_dir/closure-sizes"
  jq -sc 'sort_by(.path)' "$work_dir/actual-allocation"
}
verify_bound_closure() {
  local closure_source="$1" path
  read_closure "$store_path" >"$work_dir/actual-closure.json"
  jq -e --slurpfile actual "$work_dir/actual-closure.json" '.closure == $actual[0]' "$work_dir/manifest.json" >/dev/null || die "$closure_source closure membership, NAR hash or size differs from manifest"
  jq -r '.[].path' "$work_dir/actual-closure.json" >"$work_dir/closure-paths"
  while IFS= read -r path; do
    nix-store --verify-path "$path" || die "$closure_source closure integrity verification failed for $path"
  done <"$work_dir/closure-paths"
  read_allocation >"$work_dir/actual-allocation.json"
  jq -e --slurpfile actual "$work_dir/actual-allocation.json" '.allocationEntries == $actual[0]' "$work_dir/manifest.json" >/dev/null || die "$closure_source closure allocation differs from manifest"
  [[ -x "$store_path/bin/t3code-morrowbyte" ]] || die "$closure_source closure lacks the declared launcher"
}
assert_desktop_lock_owner_dead() {
  local owner="$1" owner_pid owner_start process_stat
  local -a fields
  [[ "$owner" =~ ^([1-9][0-9]*):([0-9]+)$ ]] || die 'another desktop restore operation has an unknown owner'
  owner_pid="${BASH_REMATCH[1]}" owner_start="${BASH_REMATCH[2]}"
  if [[ -e "/proc/$owner_pid/stat" ]]; then
    process_stat="$(cat "/proc/$owner_pid/stat")" || die 'cannot prove desktop restore lock owner is dead'
    process_stat="${process_stat##*) }"
    read -r -a fields <<<"$process_stat"
    [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || die 'cannot prove desktop restore lock owner is dead'
    [[ "${fields[0]}" == Z || "${fields[19]}" != "$owner_start" ]] || die 'another desktop restore operation is active'
  else
    [[ -d /proc/self && ! -e "/proc/$owner_pid" ]] || die 'cannot prove desktop restore lock owner is dead'
  fi
}
verify_desktop_recovery_lock() {
  local descriptor="/proc/$$/fd/8" mode
  [[ -f "$lock_recovery" && ! -L "$lock_recovery" && "$lock_recovery" -ef "$descriptor" ]] || die 'desktop restore recovery mutex identity changed'
  mode="$(stat -Lc '%a' -- "$descriptor")" || die 'cannot prove desktop restore recovery mutex permissions'
  [[ "$(stat -Lc '%u' -- "$descriptor")" == "$(id -u)" && "$mode" == 600 ]] || die 'unsafe desktop restore recovery mutex ownership or permissions'
}
lock_desktop_retention() {
  local directory="$restore_home/runtime/desktop-restore" process_stat owner mode
  mkdir -p "$directory"
  [[ -d "$directory" && ! -L "$directory" ]] || die 'desktop restore directory changed'
  mode="$(stat -c '%a' -- "$directory")" || die 'cannot prove desktop restore directory permissions'
  [[ "$(stat -c '%u' -- "$directory")" == "$(id -u)" ]] && (( (8#$mode & 8#022) == 0 )) || die 'unsafe desktop restore directory ownership or permissions'
  desktop_lock="$directory/mutation.lock"
  process_stat="$(cat "/proc/$$/stat")" || die 'cannot prove import lock owner'
  process_stat="${process_stat##*) }"
  local -a fields
  read -r -a fields <<<"$process_stat"
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || die 'cannot prove import lock owner'
  lock_recovery="$desktop_lock.recovery"
  if [[ ! -e "$lock_recovery" && ! -L "$lock_recovery" ]]; then
    (umask 077; set -o noclobber; : >"$lock_recovery") 2>/dev/null || [[ -f "$lock_recovery" && ! -L "$lock_recovery" ]] || die 'cannot create desktop restore recovery mutex'
  fi
  [[ -f "$lock_recovery" && ! -L "$lock_recovery" ]] || die 'invalid desktop restore recovery mutex'
  exec 8<>"$lock_recovery" || die 'cannot open desktop restore recovery mutex'
  lock_recovery_open=1
  verify_desktop_recovery_lock
  flock -n 8 || die 'another desktop restore operation is active or recovering'
  verify_desktop_recovery_lock
  (( $(stat -Lc '%s' -- "/proc/$$/fd/8") <= 128 )) || die 'another desktop restore operation has an unknown recovery owner'
  if [[ -s "/proc/$$/fd/8" ]]; then
    owner="$(cat <&8)" || die 'cannot read desktop restore recovery owner'
    assert_desktop_lock_owner_dead "$owner"
  fi
  lock_owner="$(mktemp "$directory/.import-owner.XXXXXX")"
  printf '%s:%s' "$$" "${fields[19]}" >"$lock_owner"
  sync -- "$lock_owner" || die 'cannot persist desktop restore lock owner'
  if ! ln -T -- "$lock_owner" "$desktop_lock" 2>/dev/null; then
    lock_observed="$(mktemp "$directory/.import-observed.XXXXXX")"
    rm -- "$lock_observed"
    ln -T -- "$desktop_lock" "$lock_observed" 2>/dev/null || die 'cannot prove stale desktop restore lock'
    [[ -f "$lock_observed" && ! -L "$lock_observed" && "$desktop_lock" -ef "$lock_observed" ]] || die 'cannot prove stale desktop restore lock'
    mode="$(stat -c '%a' -- "$lock_observed")" || die 'cannot prove desktop restore lock permissions'
    [[ "$(stat -c '%u' -- "$lock_observed")" == "$(id -u)" ]] && (( (8#$mode & 8#022) == 0 )) || die 'cannot prove desktop restore lock ownership'
    (( $(stat -c '%s' -- "$lock_observed") <= 128 )) || die 'another desktop restore operation has an unknown owner'
    owner="$(cat "$lock_observed")"
    assert_desktop_lock_owner_dead "$owner"
    [[ "$(cat "$lock_observed")" == "$owner" && ! -L "$desktop_lock" && "$desktop_lock" -ef "$lock_observed" ]] || die 'desktop restore lock changed during recovery'
    rm -- "$desktop_lock"
    ln -T -- "$lock_owner" "$desktop_lock" 2>/dev/null || die 'another desktop restore operation acquired the lock'
    rm -- "$lock_observed"
    lock_observed=""
  fi
  # Keep this inode persistent; unlinking it would split concurrent flock owners.
  flock -u 8 || die 'cannot release desktop restore recovery mutex'
  exec 8>&-
  lock_recovery_open=0
  [[ ! -e "$directory/transaction.json" && ! -L "$directory/transaction.json" ]] || die 'desktop restore recovery is pending; import is held'
}
admit_import() {
  local registry="$restore_home/runtime/desktop-restore/registry.json" root path entry members previous
  local max_versions=2 max_bytes=6442450944 archive_bytes export_bytes candidate_slot=1
  local -A roots=()
  if [[ "$pending_import" != null ]]; then
    jq -e --arg manifest "$manifest_digest" --arg root "$store_path" '
      .manifestSha256 == $manifest and .storePath == $root
    ' <<<"$pending_import" >/dev/null || die 'an unverified import is pending; only the identical bound manifest can resume'
  fi
  [[ -z "$candidate_store" || "$candidate_store" == "$store_path" ]] || die 'another journaled candidate occupies the temporary version slot'
  [[ -z "${NIX_REMOTE:-}" || "$NIX_REMOTE" == daemon || "$NIX_REMOTE" == local ]] || die 'cannot prove import peak for a remote Nix store'
  [[ -z "${NIX_STORE_DIR:-}" && -z "${NIX_STATE_DIR:-}" ]] || die 'cannot prove import peak for a redirected Nix store'
  if [[ -e "$registry" || -L "$registry" ]]; then
    [[ -f "$registry" && ! -L "$registry" ]] || die 'invalid desktop retention registry'
    jq -e --arg home "$restore_home" --arg data "$(realpath -e "$base_dir")" '
      .format == 1 and .identity.kind == "nix" and .identity.baseDir == $home and .identity.nixDataDir == $data and
      (.maxVersions | type == "number" and . >= 2 and . <= 10 and floor == .) and
      (.maxBytes | type == "number" and . > 0 and . <= 9007199254740991 and floor == .)
    ' "$registry" >/dev/null || die 'invalid desktop retention limits or installation binding'
    [[ "$(jq -cj '.identity' "$registry" | sha256sum | cut -d ' ' -f 1)" == "$(jq -r '.installationId' "$registry")" ]] || die 'desktop retention installation identity changed'
    max_versions="$(jq -r .maxVersions "$registry")" max_bytes="$(jq -r .maxBytes "$registry")"
  fi
  needs_import=0
  jq -r '.closure[].path' "$work_dir/manifest.json" >"$work_dir/candidate-paths"
  while IFS= read -r path; do
    if [[ ! -e "$path" && ! -L "$path" ]] || ! nix-store --check-validity "$path" >/dev/null 2>&1; then needs_import=1; fi
  done <"$work_dir/candidate-paths"
  if (( !needs_import )); then verify_bound_closure existing; fi
  for path in "$current_link" "$base_dir/previous"; do
    [[ -L "$path" ]] || continue
    root="$(readlink -m -- "$path")" || die 'installed selection cannot be resolved'
    roots["$root"]=1
    [[ "$root" != "$store_path" ]] || candidate_slot=0
  done
  for root in "${!owned_roots[@]}"; do
    path="$base_dir/.gcroots/${root##*/}"
    [[ ! -L "$path" ]] || roots["$root"]=1
  done
  for path in "$restore_home"/runtime/desktop-restore/nix-roots/*; do
    [[ -e "$path" || -L "$path" ]] || continue
    [[ -L "$path" && -f "$registry" ]] || die 'unproven desktop retained root prevents import admission'
    root="$(readlink -m -- "$path")"
    jq -e --arg hash "${path##*/}" --arg root "$root" '
      any(.artifacts[]; .sha256 == $hash and .nixStorePath == $root)
    ' "$registry" >/dev/null || die 'unproven desktop retained root prevents import admission'
    roots["$root"]=1
  done
  : >"$work_dir/retained-members"
  for root in "${!roots[@]}"; do
    [[ "$root" =~ ^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$ ]] || die 'invalid retained root'
    read_closure "$root" >>"$work_dir/retained-members"
  done
  # Only paths absent before an import enter this accounting ledger; never GC the shared store.
  printf '%s' "$import_ledger" >"$work_dir/ledger.json"
  jq -e 'all(.[]; .storePath | type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$"))' "$work_dir/ledger.json" >/dev/null || die 'invalid import accounting ledger'
  jq -c '.[]' "$work_dir/ledger.json" >"$work_dir/ledger-entries"
  : >"$work_dir/live-ledger"
  while IFS= read -r entry; do
    jq -e '(.members | type == "array") and all(.members[];
      (.path | type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$")) and
      (.narHash | type == "string" and test("^sha256-[A-Za-z0-9+/]{43}=$")) and
      (.narSize | type == "number" and . > 0 and . <= 9007199254740991 and floor == .))' <<<"$entry" >/dev/null || die 'invalid import accounting ledger'
    jq -c '.members[]' <<<"$entry" >"$work_dir/ledger-members"
    : >"$work_dir/live-members"
    while IFS= read -r members; do
      path="$(jq -r .path <<<"$members")"
      if [[ -e "$path" || -L "$path" ]]; then printf '%s\n' "$members" >>"$work_dir/live-members"; fi
    done <"$work_dir/ledger-members"
    if [[ -s "$work_dir/live-members" ]]; then
      root="$(jq -r .storePath <<<"$entry")"
      if [[ -e "$root" || -L "$root" ]]; then roots["$root"]=1; fi
      jq -sc '.' "$work_dir/live-members" >>"$work_dir/retained-members"
      jq -c --slurpfile members "$work_dir/live-members" '.members = $members' <<<"$entry" >>"$work_dir/live-ledger"
    fi
  done <"$work_dir/ledger-entries"
  import_ledger="$(jq -sc '.' "$work_dir/live-ledger")"
  roots["$store_path"]=1
  (( ${#roots[@]} <= max_versions + candidate_slot )) || die 'retained roots plus one temporary candidate exceed the version cap before download/import'
  jq '.closure' "$work_dir/manifest.json" >>"$work_dir/retained-members"
  jq -se '
    add | group_by(.path) | map(if (map({narHash,narSize}) | unique | length) != 1
      then error("shared closure identity changed") else .[0] end) | [.[].narSize] | add // 0 |
      if . <= 9007199254740991 then . else error("unprovable retained byte total") end
  ' "$work_dir/retained-members" >"$work_dir/retained-bytes" || die 'retained closure identity changed'
  archive_bytes="$(jq -r .archiveBytes "$work_dir/manifest.json")"
  export_bytes="$(jq -r .exportBytes "$work_dir/manifest.json")"
  # The importer may spool the stream as well as materialize it, even for shared paths.
  previous="$(cat "$work_dir/retained-bytes")"
  (( previous <= max_bytes && (!needs_import || archive_bytes + 2 * export_bytes <= max_bytes - previous) )) || die 'archive and import peak exceed the byte cap before download/import'
  local work_device store_device state_device device directory available fragment reserve=67108864 required filesystem filesystem_type allocation spool
  work_device="$(stat -c '%d' "$work_dir")" || die 'cannot prove work filesystem placement'
  store_device="$(stat -c '%d' /nix/store)" || die 'cannot prove store filesystem placement'
  state_device="$(stat -c '%d' /nix/var/nix)" || die 'cannot prove Nix state filesystem placement'
  for directory in "$work_dir" /nix/store /nix/var/nix; do
    device="$(stat -c '%d' "$directory")" || die 'cannot prove import filesystem placement'
    filesystem="$(stat -f -c '%a %S' "$directory")" || die 'cannot prove free space for import peak'
    read -r available fragment <<<"$filesystem"
    [[ "$available" =~ ^[0-9]+$ && "$fragment" =~ ^[1-9][0-9]*$ ]] || die 'cannot prove free space for import peak'
    required="$reserve"
    if (( needs_import )); then
      (( fragment >= 4096 )) || fragment=4096
      # NAR bytes include payload and names; fragments cover nodes, directory entries and dot entries.
      allocation="$(jq -er --argjson block "$fragment" '
        .closure as $members | [.allocationEntries | to_entries[] | .key as $index | .value |
          $members[$index].narSize +
          $block * (2 * (.fileCount + .directoryCount + .symlinkCount) + 2 * .directoryCount + 1)] |
        add | if . <= 9007199254740991 then . else error("unprovable allocation peak") end
      ' "$work_dir/manifest.json")" || die 'cannot prove filesystem allocation peak'
      spool="$(jq -er --argjson block "$fragment" '.exportBytes + $block * ((.closure | length) + 1) |
        if . <= 9007199254740991 then . else error("unprovable spool allocation") end' "$work_dir/manifest.json")" || die 'cannot prove spool allocation'
      required="$(jq -nr --argjson base "$required" --argjson spool "$spool" --argjson archive "$archive_bytes" \
        --argjson allocation "$allocation" --argjson block "$fragment" \
        --arg device "$device" --arg work "$work_device" --arg store "$store_device" --arg state "$state_device" '
        $base + $spool + (if $device == $work then $archive + $block else 0 end) +
          (if $device == $store or $device == $state then $allocation else 0 end) |
        if . <= 9007199254740991 then . else error("unprovable allocation peak") end')" || die 'cannot prove filesystem allocation peak'
    fi
    # Keep the actual filesystem fragment for available bytes; the estimate uses at least 4 KiB.
    read -r available fragment <<<"$filesystem"
    jq -en --argjson available "$available" --argjson fragment "$fragment" --argjson required "$required" \
      '$available * $fragment >= $required' >/dev/null || die "insufficient free space for bounded import peak on $directory"
    filesystem_type="$(stat -f -c '%T' "$directory")" || die 'cannot prove import filesystem type'
    if [[ "$filesystem_type" == btrfs ]]; then
      command -v weasel-btrfs-health >/dev/null 2>&1 || die 'cannot prove Btrfs metadata headroom for import'
      weasel-btrfs-health check --target "$directory" >/dev/null || die 'insufficient verified Btrfs metadata headroom for import'
    fi
  done
  if (( needs_import )); then
    jq -c '.closure[]' "$work_dir/manifest.json" >"$work_dir/candidate-members"
    : >"$work_dir/new-members"
    while IFS= read -r members; do
      path="$(jq -r .path <<<"$members")"
      if [[ ! -e "$path" && ! -L "$path" ]]; then printf '%s\n' "$members" >>"$work_dir/new-members"; fi
    done <"$work_dir/candidate-members"
    import_ledger="$(jq -c --arg root "$store_path" --slurpfile members "$work_dir/new-members" '
      if ($members | length) == 0 then . else . + [{storePath:$root,members:$members}] |
        group_by(.storePath) | map({storePath:.[0].storePath,members:([.[].members[]] | unique_by(.path))}) end
    ' <<<"$import_ledger")"
    (( ${#import_ledger} <= 4000000 )) || die 'import accounting exceeds metadata bound'
  fi
}
point_to() {
  # Both the version link and current are in the same filesystem; rename is atomic.
  local next="$base_dir/.current.$$" previous
  previous="$(readlink "$current_link" 2>/dev/null || true)"
  if [[ -n "$previous" && "$previous" != "$install_dir/$1" ]]; then
    ln -s "$previous" "$base_dir/.previous.$$"
    mv -Tf "$base_dir/.previous.$$" "$base_dir/previous"
  fi
  ln -s "$install_dir/$1" "$next"
  mv -Tf "$next" "$current_link"
}

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'invalid release repository'
[[ "$repo" == morrowbyte/t3code ]] || die 'release repository is not the approved fork'
[[ "$channel" == nightly || "$channel" == stable ]] || die 'channel must be nightly or stable'
[[ "$base_dir" == /* ]] || die 'data directory must be absolute'
[[ -z "$legacy_executable" || "$legacy_executable" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'legacy executable must be a simple file name'
[[ -n "$release_prefix" ]] || die 'release name prefix must not be empty'
case "$mode" in
  --status)
    printf 'Installed version: %s\nChannel: %s\nRepository: %s\n' "$(installed_version)" "$channel" "$repo"
    exit 0 ;;
  --rollback|--activate)
    for tool in jq nix-store flock realpath; do command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"; done
    version="${2:-}"
    [[ $# -eq 2 ]] && valid_version "$version" || die 'activation requires an installed version'
    [[ -d "$base_dir" ]] || die 'activation requires an installed version'
    exec 9>"$base_dir/.update.lock"
    flock -n 9 || die 'another update is running'
    valid_install "$version" || die 'activation requires an installed version'
    bind_restore_home
    if [[ "$mode" == --activate ]]; then
      assert_update_not_held
      [[ -f "$base_dir/prepared/$version.json" ]] || die 'version has not been prepared'
      jq -e --arg version "$version" --arg repository "$repo" --arg channel "$channel" \
        --arg storePath "$(readlink -f "$install_dir/$version")" \
        '.schemaVersion == 1 and .version == $version and .repository == $repository and .channel == $channel and .system == "x86_64-linux" and .storePath == $storePath' \
        "$base_dir/prepared/$version.json" >/dev/null || die 'prepared version provenance changed'
    else
      [[ -f "$base_dir/prepared/$version.json" ]] || die 'rollback version lacks verified provenance'
      jq -e --arg version "$version" --arg repository "$repo" \
        --arg storePath "$(readlink -f "$install_dir/$version")" \
        '.schemaVersion == 1 and .version == $version and .repository == $repository and (.channel == "stable" or .channel == "nightly") and .system == "x86_64-linux" and .storePath == $storePath and (.sha256 | test("^[a-f0-9]{64}$"))' \
        "$base_dir/prepared/$version.json" >/dev/null || die 'rollback version provenance changed'
    fi
    mkdir -p "$base_dir/.gcroots"
    load_inventory
    select_candidate_root "$version" "$(readlink -f "$install_dir/$version")"
    if jq -e 'has("closureSha256")' "$base_dir/prepared/$version.json" >/dev/null; then
      command -v nix >/dev/null 2>&1 || die 'required command not found: nix'
      work_dir="$(mktemp -d)"
      read_closure "$(readlink -f "$install_dir/$version")" >"$work_dir/actual-closure.json"
      expected_closure="$(jq -er '.closureSha256 | select(type == "string" and test("^[a-f0-9]{64}$"))' "$base_dir/prepared/$version.json")" || die 'invalid prepared closure commitment'
      [[ "$(jq -cj '.' "$work_dir/actual-closure.json" | sha256sum | cut -d ' ' -f 1)" == "$expected_closure" ]] || die 'prepared closure membership, NAR hash or size changed'
      closure_paths="$(jq -r '.[].path' "$work_dir/actual-closure.json")"
    else
      closure_paths="$(nix-store --query --requisites "$(readlink -f "$install_dir/$version")")" || die 'closure membership is unavailable'
    fi
    [[ -n "$closure_paths" ]] || die 'closure membership is empty'
    while IFS= read -r path; do
      [[ "$path" == /nix/store/* ]] || die 'invalid closure member'
      nix-store --verify-path "$path" || die 'closure integrity verification failed'
    done <<<"$closure_paths"
    retain_candidate_root "$(readlink -f "$install_dir/$version")"
    point_to "$version"
    reconcile_roots
    printf 'Selected installed version %s; running processes unchanged.\n' "$version"
    exit 0 ;;
  --prepare) [[ $# -eq 2 ]] && valid_version "$2" || die 'prepare requires an exact version' ;;
  --update|--check) [[ $# -le 1 ]] || die 'unexpected arguments' ;;
  *) die 'usage: install.sh [--update|--check|--prepare VERSION|--activate VERSION|--status|--rollback VERSION]' ;;
esac
for tool in curl jq sha256sum nix-store nix zstd flock realpath head stat wc sort cmp; do command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"; done
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'this updater supports x86_64 Linux with Nix'
if [[ "$mode" != --check ]]; then
  resolve_restore_home
  [[ "$mode" != --update ]] || assert_update_not_held
fi
fetch() { curl --proto '=https' --fail --silent --show-error --location --connect-timeout 10 --max-time 1800 --retry 2 "$@"; }
fetch_exact() {
  local url="$1" destination="$2" bytes="$3" extra
  fetch "$url" --max-filesize "$bytes" | {
    head -c "$bytes" >"$destination" || exit 1
    extra="$(head -c 1 | wc -c)" || exit 1
    [[ "$extra" -eq 0 ]]
  } || die 'bounded download failed'
  [[ "$(stat -c '%s' "$destination")" == "$bytes" ]] || die 'download size does not match SHA-256-bound metadata'
}
releases_json="$(fetch "https://api.github.com/repos/$repo/releases?per_page=100" | head -c 4194305)" || die 'could not read bounded releases metadata'
(( ${#releases_json} <= 4194304 )) || die 'releases metadata exceeds size bound'
requested=""; [[ "$mode" != --prepare ]] || requested="$2"
release_json="$(jq -cer --arg channel "$channel" --arg requested "$requested" --arg prefix "$release_prefix" --arg previousPrefix "$previous_release_prefix" '
def titled($stage): .name | (startswith($prefix + " " + $stage) or ($previousPrefix != "" and startswith($previousPrefix + " " + $stage)));
[.[] | select(.draft == false) | select(
  if $channel == "nightly" then .prerelease == true and
    (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\.[0-9]{8}\\.[0-9]+$")) and
    titled("Nightly")
  else .prerelease == false and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    titled("Stable") end
) | select($requested == "" or .tag_name == ("v" + $requested))] | sort_by(.published_at) | last' <<<"$releases_json")" || die "no fork-owned $channel release found"
tag="$(jq -er '.tag_name' <<<"$release_json")"
version="${tag#v}"
valid_version "$version" || die 'invalid release version'
asset_name="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest_name="T3-Code-$version-x86_64-linux-nix-closure.json"
# Both the manifest and archive must be assets on this exact release. Never fetch
# executable packaging code, evaluate a flake, build or substitute on the host.
asset_metadata() {
  jq -cer --arg name "$1" '[.assets[] | select(.name == $name)] | if length == 1 then .[0] else error("missing or duplicate asset") end' <<<"$release_json"
}
asset_url() {
  local metadata url
  metadata="$(asset_metadata "$1")" || die "release $tag lacks unique $1"
  url="$(jq -er '.browser_download_url' <<<"$metadata")"
  [[ "$url" == "https://github.com/$repo/releases/download/$tag/$1" ]] || die 'asset URL does not match selected repository/release'
  printf '%s' "$url"
}
asset_digest() {
  asset_metadata "$1" | jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$")) | sub("^sha256:"; "")'
}
manifest_url="$(asset_url "$manifest_name")"
manifest_digest="$(asset_digest "$manifest_name")" || die 'manifest asset lacks SHA-256'
archive_url="$(asset_url "$asset_name")"
archive_digest="$(asset_digest "$asset_name")" || die 'closure asset lacks SHA-256'
manifest_bytes="$(asset_metadata "$manifest_name" | jq -er '.size | select(type == "number" and . > 0 and . <= 4194304 and floor == .)')" || die 'manifest asset lacks bounded size metadata'
archive_bytes="$(asset_metadata "$asset_name" | jq -er '.size | select(type == "number" and . > 0 and . <= 9007199254740991 and floor == .)')" || die 'closure asset lacks bounded size metadata'
# Preserve the exact downloaded bytes for digest validation (command substitution
# removes trailing newlines), so fetch to a temporary file even for --check.
work_dir="$(mktemp -d)"
fetch_exact "$manifest_url" "$work_dir/manifest.json" "$manifest_bytes"
[[ "$(sha256sum "$work_dir/manifest.json" | cut -d ' ' -f 1)" == "$manifest_digest" ]] || die 'closure manifest does not match SHA-256'
store_path="$(jq -er --arg version "$version" --arg asset "$asset_name" --arg digest "$archive_digest" --argjson archiveBytes "$archive_bytes" '
  def positive: type == "number" and . > 0 and . <= 9007199254740991 and floor == .;
  def nonnegative: type == "number" and . >= 0 and . <= 9007199254740991 and floor == .;
  def store: type == "string" and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$");
  select(.schemaVersion == 1 and .version == $version and .system == "x86_64-linux" and .asset == $asset and .sha256 == $digest and .compression == "zstd" and
    (.sourceSha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.archiveBytes | positive) and .archiveBytes == $archiveBytes and (.exportBytes | positive) and
    (.closure | type == "array" and length > 0 and length <= 10000) and
    all(.closure[]; (.path | store) and (.narSize | positive) and (.narHash | type == "string" and test("^sha256-[A-Za-z0-9+/]{43}=$"))) and
    (.closure == (.closure | map({path,narHash,narSize}) | sort_by(.path))) and
    ((.closure | map(.path) | unique | length) == (.closure | length)) and
    (.storePath as $root | any(.closure[]; .path == $root)) and
    (([.closure[].narSize] | add) <= .exportBytes) and
    (.allocationEntries | type == "array") and
    (.allocationEntries == (.allocationEntries | map({path,fileCount,directoryCount,symlinkCount,payloadBytes}) | sort_by(.path))) and
    ([.allocationEntries[].path] == [.closure[].path]) and
    all(.allocationEntries[]; (.fileCount | nonnegative) and (.directoryCount | nonnegative) and
      (.symlinkCount | nonnegative) and (.payloadBytes | nonnegative) and
      ((.fileCount + .directoryCount + .symlinkCount) | positive)) and
    (.closure as $members | all(.allocationEntries | to_entries[]; .value.payloadBytes <= $members[.key].narSize))) |
  .storePath | select(test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$"))' "$work_dir/manifest.json")" || die 'invalid closure manifest'
if [[ "$mode" == --check ]]; then
  jq -n --arg installed "$(installed_version)" --arg available "$version" --arg channel "$channel" --arg repository "$repo" \
    '{installed:$installed,available:$available,channel:$channel,repository:$repository,updateAvailable:($installed!=$available)}'
  exit 0
fi
mkdir -p "$base_dir" "$install_dir" "$base_dir/prepared" "$base_dir/.gcroots"
exec 9>"$base_dir/.update.lock"
flock -n 9 || die 'another update is running'
bind_restore_home
[[ "$mode" != --update ]] || assert_update_not_held
# Version links may be the target of current/previous. Replacing one during
# preparation would activate different bytes indirectly, before --activate.
if [[ -e "$install_dir/$version" || -L "$install_dir/$version" ]]; then
  [[ "$(readlink -f "$install_dir/$version")" == "$store_path" ]] || die 'installed version identity changed'
fi
load_inventory
lock_desktop_retention
reconcile_roots
admit_import
select_candidate_root "$version" "$store_path"
if (( needs_import )); then
  fetch_exact "$archive_url" "$work_dir/closure.nar.zst" "$archive_bytes"
  [[ "$(sha256sum "$work_dir/closure.nar.zst" | cut -d ' ' -f 1)" == "$archive_digest" ]] || die 'closure download does not match SHA-256'
  export_bytes="$(jq -r .exportBytes "$work_dir/manifest.json")"
  zstd --decompress --stdout --memory=64MB "$work_dir/closure.nar.zst" |
    head -c "$((export_bytes + 1))" | wc -c >"$work_dir/export-bytes" || die 'decompression exceeds the bounded export stream or failed'
  [[ "$(cat "$work_dir/export-bytes")" -eq "$export_bytes" ]] || die 'decompressed export size does not match manifest'
  pending_import="$(jq -nc --arg manifest "$manifest_digest" --arg root "$store_path" --argjson exportBytes "$export_bytes" '{manifestSha256:$manifest,storePath:$root,exportBytes:$exportBytes}')"
  write_inventory
  zstd --decompress --stdout --memory=64MB "$work_dir/closure.nar.zst" |
    head -c "$export_bytes" | nix-store --import | head -c 4194305 >"$work_dir/imported" || die 'bounded closure import failed'
  (( $(stat -c '%s' "$work_dir/imported") <= 4194304 )) || die 'import path inventory exceeds metadata bound'
  LC_ALL=C sort "$work_dir/imported" >"$work_dir/imported-sorted"
  jq -r '.closure[].path' "$work_dir/manifest.json" >"$work_dir/expected-paths"
  cmp -s "$work_dir/imported-sorted" "$work_dir/expected-paths" || die 'imported path set differs from bound closure manifest'
  verify_bound_closure imported
fi
pending_import='null'
write_inventory
# --realise only registers an already imported root. Disable both builders and
# substitutions: missing outputs fail rather than compile on the destination.
retain_candidate_root "$store_path"
ln -s "$store_path" "$install_dir/.candidate.$$"
mv -Tf "$install_dir/.candidate.$$" "$install_dir/$version"
jq --arg repository "$repo" --arg channel "$channel" --arg manifestSha256 "$manifest_digest" \
  --arg closureSha256 "$(jq -cj '.closure | map({path,narHash,narSize})' "$work_dir/manifest.json" | sha256sum | cut -d ' ' -f 1)" \
  'del(.closure) + {repository:$repository,channel:$channel,manifestSha256:$manifestSha256,closureSha256:$closureSha256}' "$work_dir/manifest.json" > "$work_dir/prepared.json"
install -m 0600 "$work_dir/prepared.json" "$base_dir/prepared/.$version.$$"
mv -Tf "$base_dir/prepared/.$version.$$" "$base_dir/prepared/$version.json"
if [[ "$mode" == --prepare ]]; then
  printf 'Prepared %s; running version unchanged.\n' "$version"
  exit 0
fi
point_to "$version"
reconcile_roots
if [[ "$managed" != 1 ]]; then
  launcher_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$launcher_dir" "$desktop_dir"
  # Keep an existing user launcher: it may own a credential wrapper/profile.
  if [[ ! -e "$launcher_dir/t3code-morrowbyte" && ! -L "$launcher_dir/t3code-morrowbyte" ]]; then
    printf '#!/usr/bin/env bash\nset -euo pipefail\nexport T3CODE_HOME=%q\nexec %q "$@"\n' "$restore_home" "$current_link/bin/t3code-morrowbyte" >"$work_dir/launcher"
    install -m 0755 "$work_dir/launcher" "$launcher_dir/t3code-morrowbyte"
  fi
  if [[ ! -e "$desktop_dir/t3code-morrowbyte.desktop" ]]; then
    cat >"$work_dir/desktop" <<DESKTOP
[Desktop Entry]
Name=Crew
Comment=AI coding assistant desktop app
Exec="$launcher_dir/t3code-morrowbyte" %U
Icon=applications-development
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=T3 Code
DESKTOP
    install -m 0644 "$work_dir/desktop" "$desktop_dir/t3code-morrowbyte.desktop"
  fi
fi
printf 'Selected %s; the next launch uses this version. Running processes unchanged.\n' "$version"
