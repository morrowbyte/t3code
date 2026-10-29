# CI runners

Run development, CI and release builds on the owner's machines. GitHub retains source, workflow results and publication. See [Crew on your own machines](crew-local-workflow.md) for setup and commands. Additional paid runners need a separate maintainer decision; there is no automatic cloud fallback.

The fork workflows require `self-hosted` plus `MORROWBYTE_LINUX_RUNNER` (default `morrowbyte-linux`) or `MORROWBYTE_WINDOWS_RUNNER` (default `morrowbyte-windows`). Register and qualify those runners before enabling automatic jobs. A label variable does not provision a machine.

The owner's current fork targets are Windows x64 and Linux x64 desktop (including NixOS packaging), with Android ARM64 APK packaging in the release workflow. Desktop ARM64 and macOS packaging are excluded. The inherited multi-platform `Release` entry job skips `morrowbyte/t3code`; use `Morrowbyte desktop nightly` instead. The reusable desktop build also rejects ARM64/macOS calls in this fork, and macOS previews and iOS showcase builds skip it. Keep the inherited release and macOS preview workflows disabled. Their upstream definitions remain available for synchronization, including the native Windows ARM runner, but cannot allocate those build runners in this fork. Android workflows and device ABIs are unaffected; this restriction does not exclude Android ARM builds. Mobile static analysis may still use macOS tooling without producing an Apple or ARM desktop package.

Keep the checkout, pnpm store and tool downloads between trusted jobs. The synthetic Electron probe uses provider-neutral `MORROWBYTE_CI_PROBE` / `MORROWBYTE_CI_PROFILE` while retaining its CI-only, synthetic-profile guard.

Run `Morrowbyte CI` manually to build an unpublished product bundle. `Morrowbyte desktop nightly` accepts `publish=false` to exercise Linux, NixOS and Windows packaging without changing the release feed; normal release callers retain publishing by default. A runner acceptance workflow in `morrowbyte/.github` covers Linux x64/ARM64, Windows x64 and macOS. Dispatch, successful source checks, packaged artifacts and installed behavior are distinct evidence.

Runner reference: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners.
