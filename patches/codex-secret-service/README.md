# Noninteractive Linux MCP credential access

Native source: `openai/codex` tag `rust-v0.163.0`, commit
`83086188ae0614bd882818ff1aa23f3194962012`. The package revision is
`0.163.0-morrowbyte.2`; its CLI, manifest and cache directory use that full version.

Secret Service reads and normal Direct OAuth refresh saves can request an unlock
prompt before MCP's operation budget applies. `0001` keeps Linux's existing kernel
cache and reads unlocked entries without requesting Unlock or Prompt. `0002`
updates an existing unlocked item for Direct refresh through the same async DH
API. Each actual D-Bus future has one two-second budget, including connection,
search, legacy default-collection fallback and the read or SetSecret operation.
Expiry drops that future instead of detaching a blocking worker.

Refresh persistence requires an unambiguous existing item and a successful remote
ACK before updating the kernelcache. A missing SetSecret ACK remains an unknown
commit outcome; a failed cache update remains an error. Both attempt only the
specific kernelkey's invalidation and report cleanup failures or uncertain
coherence. They do not claim remote rollback or automatically retry a rotation.
Local kernelcache syscalls are outside the cooperative D-Bus deadline.

Locked, missing, unavailable, denied and timed-out operations remain distinct.
Healthy stored credential bytes, DH, both normal refresh entrypoints and pinned
authority guards are preserved. Initial login saves, Delete, File/Secrets storage
and non-Linux implementations retain their existing paths. No CreateItem,
Unlock or Prompt is used by the Linux refresh writer.

The locked `secret-service 4.0.0` and `zbus 4.4.0` APIs do not expose a configurable
blocking connection timeout. The reader uses async-io and zbus directly; both
versions already exist in the upstream lockfile.

## Apply

Use a separate clean checkout of the exact native commit:

```bash
./patches/codex-secret-service/apply.sh /absolute/path/to/codex-source
```

The script checks both patches against a temporary index before applying them.

## Build and package Linux x64

Prepare the musl toolchain with the pinned native source's
`.github/scripts/install-musl-build-tools.sh`, setting `TARGET` to
`x86_64-unknown-linux-musl`, `RUNNER_TEMP` to a private tools directory and
`GITHUB_ENV` to a private environment file. That script installs its Linux build
prerequisites and writes the target-specific compiler and OpenSSL configuration.
The build also requires LLD and `x86_64-linux-gnu-gcc`.

Then run from the Crew source checkout:

```bash
./patches/codex-secret-service/build.sh \
  /absolute/path/to/codex-source /private/native-target /private/musl.env test
./patches/codex-secret-service/build.sh \
  /absolute/path/to/codex-source /private/native-target /private/musl.env
./patches/codex-secret-service/package.sh \
  /private/original-0.163.0-package.tar.gz \
  /private/native-target/x86_64-unknown-linux-musl/release \
  /private/codex-package-x86_64-unknown-linux-musl.tar.gz
```

The test mode runs only the Linux keyring regressions and the existing OAuth
credential-store persistence case. Both modes validate the complete patch stack
without modifying the source's real index. Workspace package versions are
normalized to the custom revision; registry/git dependencies remain exact.

The build uses one compile job, LLD through the musl compiler's `REALGCC` wrapper,
release debug information disabled, LTO off and sixteen codegen units. It uses
Codex's own checksum-pinned V8 archive/bindings and embeds the digest of the
unchanged upstream bwrap helper. `setup-v8.sh` verifies the checksum manifest
against the source pin and verifies the downloaded artifacts.

Packaging verifies the original upstream archive's exact size and SHA-256,
replaces only the two native binaries and the manifest version, adds the exact
pinned upstream `LICENSE` and `NOTICE`, and checks every other helper remains
byte-identical, including bundled helper notices. The archive has normalized tar
metadata and gzip timestamp. Its JSON receipt records exact bytes, SHA-256,
source/patch/build-script/license pins and individual binary/helper digests.
Promote those qualified bytes unchanged under their unique release identity.
