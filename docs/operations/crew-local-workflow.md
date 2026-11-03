# Crew on your own machines

Use this guide for the Morrowbyte fork. GitHub stores source, check results and
published releases. Run development and checks at Crew's assigned compute
placement; reuse its matching Boat environment when assigned. Without an
assignment, use the project's daily user-selected execution location.

## Once per developer machine

Install the global [Vite+ CLI](https://viteplus.dev/guide/). It selects the exact
Node and pnpm versions from this repository. Open a new shell after installation.

```sh
git clone https://github.com/morrowbyte/t3code.git
cd t3code
vp install --frozen-lockfile
vp run dev
```

Keep WSL checkouts in the Linux filesystem, such as `~/src/t3code`, rather than
under `/mnt/c`. On NixOS, enter `nix-shell` before running the Vite commands;
the repository shell supplies the C/Rust toolchains, native library headers
and a managed browser for focused browser tests.
It also loads an installed Vite+ shell environment.

The terminal prints the actual web address and pairing link. Development uses
isolated data: `.t3` in a worktree, `~/.t3/dev` in the main checkout. For another
location use `--home-dir`. Production `T3CODE_HOME`, `T3CODE_HOST` and
`T3CODE_PORT` values inherited by an agent do not select the dev environment.
Explicit dev overrides are `T3CODE_DEV_HOME`, `T3CODE_DEV_HOST` and
`T3CODE_DEV_PORT`; `--home-dir`, `--host` and `--port` remain available.

## Work on a feature

Keep `vp run dev` and its browser tab running. Web edits use Vite hot reload;
server edits restart the watched backend. Run one focused regression when the
behavior needs one. A full package build is not part of this loop.

For Electron-specific behavior use `vp run dev:desktop`. Android UI development
uses Metro and the existing development client; native dependency changes need
a new development client. See the [mobile setup](../../apps/mobile/README.md).

Each independent feature has one stable project-local `workKey`, one owner and
its own branch/worktree, test state and ports. Reuse that owner and warm preview;
small helpers share its environment with one writer per path. Check the actual
user flow early, including screenshots for UI work, within the user's test
authorization. Native checks belong in the loop when native behavior changed.

Before integration:

```sh
vp run check:integration --exact-base <frozen-main-sha>
git add <changed-files>
git commit -m "feat: describe the feature"
git push -u origin <feature-branch>
```

`check:integration` checks changed-file formatting, lint and adjacent tests. It
includes uncommitted and untracked files. It compares with the merge base of
`origin/main` by default; `--exact-base` fixes the recorded comparison SHA.
Quick integration does not check types. Before main, assign required type
evidence for affected packages to a focused check or existing CI job. Qualify
the relevant current-main/feature combination, obtain independent review of
the frozen commit and explicit human merge approval. A comparison base alone
does not test that combination. Follow the [integration and review rules](../internals/testing.md#integration-and-review);
reuse passing evidence while its relevant inputs stay unchanged. These are
repository instructions, not GitHub branch-protection guarantees.

## Qualify and package a release

New builds require a successful external SourceProof from
`morrowbyte-local-source-check.yml` for the exact frozen source and its first
parent. The release verifies that proof; it does not run the broader source
suite itself. Produce the proof once through the existing workflow:

```sh
source_sha=$(git rev-parse HEAD)
base_sha=$(git rev-parse "$source_sha^1")
gh workflow run morrowbyte-local-source-check.yml --repo morrowbyte/t3code \
  --ref "$source_sha" -f source_sha="$source_sha" -f base_sha="$base_sha"
```

The proof binds the source/base SHAs, check program and lockfiles, toolchain,
complete check groups and producing run/attempt/artifact digest. A local
`check:release` is useful for diagnosis but does not replace that API-verified
workflow provenance. `check:changed` supplies the wider changed-file checks
when needed. Do not repeat the full suite manually before the workflow.

Linux, including the NixOS build shell:

```sh
vp run dist:desktop:linux --build-version <version> --output-dir <artifact-directory>
```

The command builds JS and native helpers, then packages the Crew AppImage.
It defaults to Crew's existing app identity and updater repository. It does not
install the result or publish it. Ubuntu/WSL builders need a C compiler, make,
pkg-config, libsecret headers, Rust/Cargo and the Wayland development libraries;
these are machine setup, not packages to reinstall before every feature check.

Windows x64 packaging uses `vp run dist:desktop:win:x64` with the same version
and output arguments. The current native helper and smoke checks use a Windows
toolchain/runtime. Android release packaging needs Java 21, the pinned Android
SDK/NDK and the existing signing key. Preserve that key and the app ID to keep
installed phones upgradeable. A debug APK does not qualify a signed update.

For an authorized published release use `morrowbyte-release.yml`, which packages
the shared JS once and consumes the qualified source. Set `proof_run_id`,
`proof_artifact_id` and `proof_digest` from the successful SourceProof artifact;
the workflow revalidates their exact identity:

```sh
gh workflow run morrowbyte-release.yml --repo morrowbyte/t3code --ref main \
  -f source_sha="$source_sha" -f publish=true \
  -f source_proof_run_id="$proof_run_id" \
  -f source_proof_artifact_id="$proof_artifact_id" \
  -f source_proof_digest="$proof_digest"
```

This needs the workflow enabled and the selected backend ready. For self-hosted
jobs, check the registered runners before requesting the release:

```sh
gh api repos/morrowbyte/t3code/actions/runners \
  --jq '.runners[] | {name,status,labels:[.labels[].name]}'
```

The Linux runner label defaults to `morrowbyte-linux`; Windows defaults to
`morrowbyte-windows`. Both require `self-hosted`. Setting a label variable to a
cloud runner name does not create that runner or switch execution providers.
An absent runner leaves a job queued. Do not call a dispatch a completed release.
`MORROWBYTE_ANDROID_RUNNER` can select a dedicated Android runner; otherwise
Android uses the Linux label. A fixed runner keeps native cache paths stable and
allows Linux packaging to proceed alongside Android.

For custom Linux build storage, set the repository variable
`MORROWBYTE_LINUX_INIT_SCRIPT` to a machine-local script. The workflow sources it
with `--github-env` after checkout. Configure writable build/cache paths and
installed toolchains there, outside the repository. The script must leave
`git status` clean, preserve the artifact paths expected by the workflow, and
support repeated jobs. With no variable, the runner uses its normal environment.
System libraries are installed during runner setup. Normal self-hosted release
jobs neither install OS packages nor request `sudo`.

Keep dependency stores on the runner. Self-hosted jobs do not archive and upload
those same stores to the Actions cache. A runner may enable CMake's standard
compiler launchers with `ccache` and a bounded persistent `CCACHE_DIR`; Gradle's
user-level `org.gradle.caching=true` also survives fresh checkouts.

The Android release emulator uses console port 5580 and ADB port 5581, leaving
the usual development pair 5554/5555 available. Set the repository variable
`MORROWBYTE_ANDROID_EMULATOR_PORT` to another free even port between 5554 and 5682
when needed. The release never stops an emulator that already owns its port.
Each job uses fresh Android user preferences and virtual-device state; the SDK,
Gradle and compiler caches remain shared. This prevents previous emulator state
from affecting a release startup check.
Android compilation and startup verification run as separate jobs. The startup
job uses the signed build artifacts after Linux/NixOS finish, independently of
Windows; retrying it does not compile another APK.

If the maintainer explicitly chooses a paid Blacksmith release for one run, add
`-f runner_backend=blacksmith` to that dispatch. It selects the existing Linux
and Windows Blacksmith platforms without editing the workflow or label variables.
The default remains `self-hosted`; this option is not an automatic fallback.

Use `-f runner_backend=boat` for Boat Large Linux, NixOS and Android jobs;
Windows still uses the native `morrowbyte-windows` runner. Set
`MORROWBYTE_CI_BACKEND=boat` to use Boat for Linux CI as well.
`MORROWBYTE_BOAT_RUNNER` optionally selects a prepared Boat snapshot label;
the default is `boat-large`. Public repositories require the Boat GitHub App
and an explicit allowed-user list in Boat's CI settings. Automatic publication
is separately controlled by `MORROWBYTE_AUTOMATIC_NIGHTLY`; do not change that
authorization while selecting compute.

The automatic Nightly dispatcher explicitly sets `linux_first=true`, retaining
the exact SourceProof fields, current-main check and single-dispatch intent.
It does not wait for a Windows start gate. Manual dispatch keeps
`linux_first=false` by default; add `-f linux_first=true` when that publication
order is intended. The existing Linux-first path requires the shared bundle,
Linux, NixOS and Android startup checks before publication. Windows is appended
after its own successful build, without delaying those verified assets.

Build once and promote the same hash/provenance-bound bytes. Keep successful
unchanged artifacts after an isolated platform failure; rebuild only artifacts
whose relevant inputs changed. Source, fixture, browser, native, package and
installed evidence prove different stages. Windows is appended to the same tag and
source without replacing any published asset. Its checksums and provenance are
`SHA256SUMS-windows` and `RELEASE-RECEIPT-windows.txt`; the original checksums and
receipt stay unchanged. Older Windows CLI launchers that only read `SHA256SUMS`
cannot install this appended payload; the new installer and npm launcher support
the additional manifest. Desktop updates continue to use `nightly.yml`.

After an actual local Windows failure, an explicitly approved fallback can set
`MORROWBYTE_WINDOWS_RELEASE_BACKEND=blacksmith` and rerun the failed jobs of the
same release. Stop the failed local attempt first, preserve the source/version,
and reset the variable after the fallback so later releases again prefer the
native runner. Never run both Windows builds concurrently.

If releases can target a commit whose workflows differ from current `main`,
configure the encrypted repository secret `MORROWBYTE_RELEASE_TOKEN` with
repository content and workflow write access. GitHub's built-in job token cannot
publish that case. Only the publishing steps use this optional credential;
builds and checks keep their normal job token.

## Integration CI

`morrowbyte-ci.yml` uses the short integration check on every branch push and
same-repository pull request. A newer run on the same branch replaces the older
automatic run, including duplicate push/PR runs. Fork PRs do not execute code on personal runners.
The broader qualification and platform-specific checks remain manual. A manual
short check is also available:

```sh
gh workflow run morrowbyte-ci.yml --repo morrowbyte/t3code --ref <feature-branch> \
  -f integrationOnly=true -f integrationBase=<base-sha>
```

Provision the runner's browser/desktop runtime libraries once. Browser and
Electron downloads are reused when present. Keep the checkout, pnpm store and
tool caches between trusted jobs. The first install is setup cost; normal
feature checks should not recreate an entire container and dependency tree.
`MORROWBYTE_INTEGRATION_RUNNER` can select a dedicated check runner without
claiming it can package every release platform.
`morrowbyte-local-source-check.yml` is a manual broader check, not a second
automatic full suite after each main push.

Before large installs/builds check all affected volumes, including Btrfs
metadata and device reserve where applicable. Keep build outputs outside Git, bound their retention, and
remove only completed owned disposable output. Keep active source, user data,
credentials and rollback versions.
