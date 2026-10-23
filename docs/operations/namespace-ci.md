# CI runners

Run routine CI and development checks locally when possible. Additional paid CI runs require maintainer approval. Release builds use the configured Blacksmith runners unless the maintainer chooses otherwise; reuse successful checks and avoid redundant builds.

`WEASEL_LINUX_RUNNER=blacksmith-8vcpu-ubuntu-2404` and `WEASEL_WINDOWS_RUNNER=blacksmith-8vcpu-windows-2025` control the fork CI and desktop release. Workflow defaults use the same labels. Existing larger Windows jobs retain 32 vCPUs.

The owner's current fork targets are Windows x64 and Linux x64 desktop (including NixOS packaging), with Android ARM64 APK packaging in the release workflow. Desktop ARM64 and macOS packaging are excluded. The inherited multi-platform `Release` entry job skips `morrowbyte/t3code`; use `Weasel desktop nightly` instead. The reusable desktop build also rejects ARM64/macOS calls in this fork, and macOS previews and iOS showcase builds skip it. Keep the inherited release and macOS preview workflows disabled. Their upstream definitions remain available for synchronization, including the native Windows ARM runner, but cannot allocate those build runners in this fork. Android workflows and device ABIs are unaffected; this restriction does not exclude Android ARM builds. Mobile static analysis may still use macOS tooling without producing an Apple or ARM desktop package.

Namespace cache-volume actions were removed. Vite+ and upstream Actions caches use Blacksmith's transparent Actions cache service. The synthetic Electron probe uses provider-neutral `MORROWBYTE_CI_PROBE` / `MORROWBYTE_CI_PROFILE` while retaining its CI-only, synthetic-profile guard.

Run `Weasel CI` manually to build an unpublished product bundle. `Weasel desktop nightly` accepts `publish=false` to exercise Linux, NixOS and Windows packaging without changing the release feed; normal release callers retain publishing by default. A runner acceptance workflow in `morrowbyte/.github` covers Linux x64/ARM64, Windows x64 and macOS. Dispatch, successful source checks, packaged artifacts and installed behavior are distinct evidence.

Runner and cache reference: https://docs.blacksmith.sh/blacksmith-runners/overview and https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions.
