# Crew on your own machines

Use this guide for the Morrowbyte fork. GitHub stores source, check results and
published releases; development and build commands run on your machines.

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

Parallel agents use separate branches/worktrees and separate dev state. Give
each agent ownership of its files. Reuse its worktree, dependencies and preview
instead of creating another copy for every check. A native desktop or Android
test only belongs in a feature's loop when that native behavior changed.

Before integration:

```sh
vp run check:integration
git add <changed-files>
git commit -m "feat: describe the feature"
git push -u origin <feature-branch>
```

`check:integration` checks changed-file formatting, lint and adjacent tests. It
includes uncommitted and untracked files. It compares with the merge base of
`origin/main`; pass another base ref when needed. A passing result is reused
while its inputs stay unchanged. Fix failures, integrate through the repository's
normal merge rules, and keep developing. Do not add a package build or repeat
the release suite for every merge.

## Qualify and package a release

From a committed source revision, run the broader qualification once:

```sh
vp run check:changed <previous-qualified-ref>
vp run check:release
```

The first command adds type checks, unused code/dependency checks and generated
operations for the changes since that ref. The second runs the fork's broader
regressions and writes its generation evidence into a private task directory
when it runs outside Actions. Keep the same source revision for packaging.

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

For a complete published release use `morrowbyte-release.yml`, which packages
the shared JS once and joins the Linux, Windows, NixOS and Android artifacts:

```sh
gh workflow run morrowbyte-release.yml --repo morrowbyte/t3code --ref main \
  -f source_sha="$(git rev-parse HEAD)" -f publish=true
```

This needs the workflow enabled and its own runners online. Check them before
requesting the release:

```sh
gh api repos/morrowbyte/t3code/actions/runners \
  --jq '.runners[] | {name,status,labels:[.labels[].name]}'
```

The Linux runner label defaults to `morrowbyte-linux`; Windows defaults to
`morrowbyte-windows`. Both require `self-hosted`. Setting a label variable to a
cloud runner name does not create that runner or switch execution providers.
An absent runner leaves a job queued. Do not call a dispatch a completed release.

If the maintainer explicitly chooses a paid Blacksmith release for one run, add
`-f runner_backend=blacksmith` to that dispatch. It selects the existing Linux
and Windows Blacksmith platforms without editing the workflow or label variables.
The default remains `self-hosted`; this option is not an automatic fallback.

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

Before large installs/builds check all affected volumes. On Nixy use the
installed `agent-storage-admit --target /home`, including Btrfs metadata and
device reserve. Keep build outputs outside Git, bound their retention, and
remove only completed owned disposable output. Keep active source, user data,
credentials and rollback versions.
