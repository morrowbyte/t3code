# Provider updates in the Crew fork

Codex and Claude do not require a patched provider executable. Codex uses the
upstream app-server protocol through `effect-codex-app-server`; Claude uses
`@anthropic-ai/claude-agent-sdk` with the configured Claude executable. Updating
one provider does not require replacing the other providers or their user state.

## Dependencies that matter

- [CodexInstallation](../../apps/server/src/provider/CodexInstallation.ts) selects
  checksum-pinned upstream Codex 0.163.0 for Linux and Windows. The protocol
  generator separately pins its upstream schema commit in
  [generate.ts](../../packages/effect-codex-app-server/scripts/generate.ts).
  A schema revision is a build input, not a requirement to fork the executable.
- Context is injected at the adapter boundary by
  [CodexDeveloperInstructions](../../apps/server/src/provider/CodexDeveloperInstructions.ts).
  Its `additionalContext` entries stay within Codex's per-entry truncation budget.
  Replacing this with a single long instruction can silently lose context.
- Stop uses `turn/interrupt` in
  [CodexAdapterV2](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).
  An active native goal is paused first so cancellation does not restart the work.
- [CodexHomeLayout](../../apps/server/src/provider/Drivers/CodexHomeLayout.ts)
  keeps shared sessions and private account credentials separate. Native
  `memories` remain local to each shadow home. There is no memory-engine patch
  to rebase when updating Codex; preserve this layout and existing state.
- The direct provider SDK patch is
  [Muse's process-exit callback](../../patches/@muse-code__sdk@1.4.6.patch), pinned
  with its package in `pnpm-workspace.yaml`. It lets the adapter observe an exited
  host even when descendants retain its stdio. Remove it only when the upstream
  SDK supplies equivalent exit observation; otherwise dead sessions can remain
  active. It does not block Codex or Claude updates.

## Qualify a replacement

Use an isolated provider home and a single provider instance. For Codex, install
an unmodified upstream release, verify its version and app-server initialization,
then probe that candidate's live app-server. Observe application context in its
model request, a terminal interrupted turn after Stop, and native thread
resumption after restarting that process with the same isolated home. A local
inference fixture can exercise this wire/lifecycle path without paid inference.
The [replay recorder](../../apps/server/scripts/record-codex-app-server-replay-fixture.ts)
also accepts `T3_CODEX_BIN` to select the candidate for a live recording.

Run existing adapter tests separately to check the app's context chunking,
goal-stop ordering and shadow-home behavior. Mocked/replayed tests do not execute
the candidate binary and cannot establish its compatibility. The
[upstream app-server contract](https://developers.openai.com/codex/app-server)
defines cancellation as a terminal `turn/completed` with `interrupted` status;
an accepted interrupt request alone is insufficient evidence.

Compatibility advice belongs in the provider's existing manifest policy and
capability probe. Name the unsupported method or lost behavior when a candidate
fails; do not turn one optional extension into a blanket provider-update ban.
Keep the previous executable and provider home available until the replacement
passes. No user-state migration or fleet upgrade follows from this procedure.
