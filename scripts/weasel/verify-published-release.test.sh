#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fixture_repo="$test_root/repo"
fixture_remote="$test_root/origin.git"
fixture_assets="$test_root/assets"
fixture_api="$test_root/release.json"
fake_bin="$test_root/bin"
tag="v0.0.47-nightly.20261013.1"
version="0.0.47-nightly.20261013.1"
mkdir -p "$fixture_repo" "$fixture_assets" "$fake_bin"
git init --bare "$fixture_remote" >/dev/null
git -C "$fixture_repo" init -b main >/dev/null
git -C "$fixture_repo" config user.name fixture
git -C "$fixture_repo" config user.email fixture@example.invalid
git -C "$fixture_repo" commit --allow-empty -m fixture >/dev/null
source_sha="$(git -C "$fixture_repo" rev-parse HEAD)"
git -C "$fixture_repo" -c tag.gpgSign=false tag "$tag" "$source_sha"
git -C "$fixture_repo" remote add origin "$fixture_remote"
git -C "$fixture_repo" push origin main "refs/tags/$tag" >/dev/null

for asset in \
  nightly-linux.yml \
  nightly.yml \
  weasel-linux-x64.tar.gz \
  "T3-Code-$version-x86_64.AppImage" \
  "T3-Code-$version-x86_64-linux-nix-closure.nar.zst" \
  "T3-Code-$version-x86_64-linux-nix-closure.json" \
  install-linux.sh \
  "t3-$version-linux-x64.tar.gz" \
  "t3-$version-win32-x64.zip"; do
  printf 'fixture payload: %s\n' "$asset" > "$fixture_assets/$asset"
done
bash "$repo_root/scripts/weasel/verify-published-release.sh" --write-checksums "$version" "$fixture_assets"
cp "$fixture_assets/SHA256SUMS" "$test_root/fresh-checksums"
printf 'old receipt must not hash itself\n' > "$fixture_assets/RELEASE-RECEIPT.txt"
bash "$repo_root/scripts/weasel/verify-published-release.sh" --write-checksums "$version" "$fixture_assets"
cmp "$test_root/fresh-checksums" "$fixture_assets/SHA256SUMS"
rm "$fixture_assets/RELEASE-RECEIPT.txt"
sed 's/  /  .\//' "$fixture_assets/SHA256SUMS" > "$test_root/dot-prefix-checksums"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" --check-cli-checksums \
  "$version" "$test_root/dot-prefix-checksums" >/dev/null 2>&1; then
  echo "Legacy CLI consumer accepted dot-prefixed archive names." >&2
  exit 1
fi

payload_digests='[]'
for file in "$fixture_assets"/*; do
  name="$(basename "$file")"
  digest="sha256:$(sha256sum "$file" | cut -d ' ' -f 1)"
  payload_digests="$(jq -c --arg name "$name" --arg digest "$digest" '. + [{name: $name, digest: $digest}]' <<<"$payload_digests")"
done
{
  printf 'fork_release=%s\nsource_sha=%s\npnpm_lock_sha256=fixture\n' "$tag" "$source_sha"
  printf 'github_asset_digests=%s\n' "$(jq -c 'sort_by(.name)' <<<"$payload_digests")"
  printf 'artifact_sha256:\n'
  cat "$fixture_assets/SHA256SUMS"
} > "$fixture_assets/RELEASE-RECEIPT.txt"

all_asset_digests="$payload_digests"
receipt_digest="sha256:$(sha256sum "$fixture_assets/RELEASE-RECEIPT.txt" | cut -d ' ' -f 1)"
all_asset_digests="$(jq -c --arg digest "$receipt_digest" '. + [{name: "RELEASE-RECEIPT.txt", digest: $digest}]' <<<"$all_asset_digests")"
jq -n --arg tag "$tag" --argjson assets "$all_asset_digests" \
  '{tag_name: $tag, draft: false, prerelease: true, assets: $assets}' > "$fixture_api"

cat > "$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then
  printf '%s\n' "$2" >> "$WEASEL_FIXTURE_GH_LOG"
  cat "$WEASEL_FIXTURE_API"
elif [[ "$1" == "release" && "$2" == "download" ]]; then
  destination=""
  while (($#)); do
    if [[ "$1" == "--dir" ]]; then
      destination="$2"
      shift 2
    else
      shift
    fi
  done
  cp "$WEASEL_FIXTURE_ASSETS"/* "$destination/"
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
EOF
chmod +x "$fake_bin/gh"

export PATH="$fake_bin:$PATH"
export WEASEL_FIXTURE_API="$fixture_api"
export WEASEL_FIXTURE_ASSETS="$fixture_assets"
export WEASEL_FIXTURE_GH_LOG="$test_root/gh-api-calls.log"
export WEASEL_VERIFY_GIT_REMOTE=origin
export GH_REPO=fixture/t3code

cd "$fixture_repo"
bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null
grep -Fxq "repos/fixture/t3code/releases/tags/$tag" "$WEASEL_FIXTURE_GH_LOG"

: > "$WEASEL_FIXTURE_GH_LOG"
unset GH_REPO
bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null
grep -Fxq "repos/EvilWeasel/t3code/releases/tags/$tag" "$WEASEL_FIXTURE_GH_LOG"
export GH_REPO=fixture/t3code

if bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "0000000000000000000000000000000000000000" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo "Verifier accepted a tag pointing at the wrong source SHA." >&2
  exit 1
fi

cp "$fixture_api" "$test_root/release.good.json"
jq '(.assets[] | select(.name == "nightly.yml").digest) = "sha256:wrong"' \
  "$fixture_api" > "$test_root/release.bad-digest.json"
mv "$test_root/release.bad-digest.json" "$fixture_api"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo "Verifier accepted a mismatched GitHub asset digest." >&2
  exit 1
fi
mv "$test_root/release.good.json" "$fixture_api"

printf 'changed payload\n' >> "$fixture_assets/nightly-linux.yml"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo "Verifier accepted an asset set that differs from the published release." >&2
  exit 1
fi

# Android publication must not replace a complete desktop updater release.
tag="android/v$version"
git -c tag.gpgSign=false tag "$tag" "$source_sha"
git push origin "refs/tags/$tag" >/dev/null
fixture_assets="$test_root/android-assets"
mkdir -p "$fixture_assets"
export WEASEL_FIXTURE_ASSETS="$fixture_assets"
apk_name="Morrowbyte-$version-android-arm64.apk"
printf 'fixture APK bytes, not a signature test\n' > "$fixture_assets/$apk_name"
apk_sha="$(sha256sum "$fixture_assets/$apk_name" | cut -d ' ' -f 1)"
printf '%s  %s\n' "$apk_sha" "$apk_name" > "$fixture_assets/$apk_name.sha256"
jq -n --arg name "$apk_name" --arg digest "$apk_sha" --arg version "$version" --arg source "$source_sha" \
  '{apk: $name, apkSha256: $digest, version: $version, versionCode: 61, source: $source,
    package: "com.morrowbyte.t3code", abis: ["arm64-v8a"],
    certificateSha256: "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2",
    signatureVerified: true, zip16KB: true, elf16KB: true}' > "$fixture_assets/$apk_name.json"
bash "$repo_root/scripts/weasel/verify-published-release.sh" --android-only --write-checksums "$version" "$fixture_assets"

payload_digests='[]'
for file in "$fixture_assets"/*; do
  name="$(basename "$file")"
  digest="sha256:$(sha256sum "$file" | cut -d ' ' -f 1)"
  payload_digests="$(jq -c --arg name "$name" --arg digest "$digest" '. + [{name: $name, digest: $digest}]' <<<"$payload_digests")"
done
{
  printf 'fork_release=%s\nsource_sha=%s\nrelease_platforms=android-arm64\n' "$tag" "$source_sha"
  printf 'github_asset_digests=%s\nartifact_sha256:\n' "$payload_digests"
  cat "$fixture_assets/SHA256SUMS"
} > "$fixture_assets/RELEASE-RECEIPT.txt"
receipt_digest="sha256:$(sha256sum "$fixture_assets/RELEASE-RECEIPT.txt" | cut -d ' ' -f 1)"
all_asset_digests="$(jq -c --arg digest "$receipt_digest" '. + [{name: "RELEASE-RECEIPT.txt", digest: $digest}]' <<<"$payload_digests")"
jq -n --arg tag "$tag" --argjson assets "$all_asset_digests" \
  '{tag_name: $tag, draft: false, prerelease: false, assets: $assets}' > "$fixture_api"
bash "$repo_root/scripts/weasel/verify-published-release.sh" --android-only \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null

cp "$fixture_api" "$test_root/android.good.json"
jq '.prerelease = true' "$fixture_api" > "$test_root/android.bad-feed.json"
mv "$test_root/android.bad-feed.json" "$fixture_api"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" --android-only \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo 'Android verifier accepted the desktop prerelease feed.' >&2
  exit 1
fi
mv "$test_root/android.good.json" "$fixture_api"

printf 'desktop feed must not be mixed into Android\n' > "$fixture_assets/nightly.yml"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" --android-only --write-checksums \
  "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo 'Android checksum writer accepted a desktop asset.' >&2
  exit 1
fi
rm "$fixture_assets/nightly.yml"

echo 'Desktop and Android-only publication fixtures passed.'
