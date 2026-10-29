import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const isVoiceWorkActive = (status: string) =>
  ["idle", "pending", "preparing", "queued", "starting", "running", "waiting"].includes(status);

export function voiceRunStatus(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "attempts" | "providerTurns" | "turnItems" | "messages"
  >,
  run: OrchestrationV2Run,
  observedAt: DateTime.Utc,
) {
  const active = isVoiceWorkActive(run.status);
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const turnIds = new Map(
    projection.providerTurns
      .filter((turn) => turn.runAttemptId === attempt?.id)
      .map((turn) => [turn.id, turn.ordinal] as const),
  );
  const latestTurn = projection.providerTurns
    .filter((turn) => turn.runAttemptId === attempt?.id)
    .sort((a, b) => b.ordinal - a.ordinal)[0];
  const items = projection.turnItems
    .filter(
      (item) =>
        item.runId === run.id &&
        item.threadId === run.threadId &&
        item.providerTurnId !== null &&
        turnIds.has(item.providerTurnId),
    )
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(DateTime.makeUnsafe(b.updatedAt)) -
          DateTime.toEpochMillis(DateTime.makeUnsafe(a.updatedAt)) ||
        (turnIds.get(b.providerTurnId!) ?? 0) - (turnIds.get(a.providerTurnId!) ?? 0) ||
        b.ordinal - a.ordinal,
    );
  // Only public progress is returned: tool arguments/output and reasoning stay private.
  const activity = active
    ? items.flatMap((item) => {
        if (
          item.type === "todo_list"
            ? items.find((candidate) => candidate.type === "todo_list") !== item
            : !["running", "waiting", "pending"].includes(item.status)
        )
          return [];
        if (
          item.type !== "todo_list" &&
          (item.providerTurnId !== latestTurn?.id || latestTurn.status !== "running")
        )
          return [];
        const step =
          item.type === "todo_list"
            ? item.steps.find((step) => step.status === "running")?.text
            : item.type === "command_execution"
              ? "Befehl wird ausgeführt"
              : item.type === "file_change"
                ? "Dateien werden bearbeitet"
                : item.type === "web_search"
                  ? "Webrecherche läuft"
                  : item.type === "file_search"
                    ? "Dateien werden durchsucht"
                    : item.type === "dynamic_tool" && item.toolName
                      ? `Tool ${item.toolName.slice(0, 160)} läuft`
                      : item.type === "user_input_request"
                        ? "Wartet auf eine Antwort"
                        : item.type === "approval_request"
                          ? "Wartet auf eine Freigabe"
                          : undefined;
        return step ? [{ text: step.slice(0, 1_000), updatedAt: item.updatedAt }] : [];
      })[0]
    : undefined;
  const publicItem = active
    ? items.find((item) => item.type === "assistant_message" && item.text.trim())
    : undefined;
  const publicText = publicItem?.type === "assistant_message" ? publicItem.text : undefined;
  const stepAgeMs = activity
    ? Math.max(
        0,
        DateTime.toEpochMillis(observedAt) -
          DateTime.toEpochMillis(DateTime.makeUnsafe(activity.updatedAt)),
      )
    : null;
  const evidenceAt = [activity?.updatedAt, publicItem?.updatedAt]
    .filter((date) => date !== undefined)
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(DateTime.makeUnsafe(b)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(a)),
    )[0];
  const ageMs = evidenceAt
    ? Math.max(
        0,
        DateTime.toEpochMillis(observedAt) -
          DateTime.toEpochMillis(DateTime.makeUnsafe(evidenceAt)),
      )
    : null;
  const request = projection.messages.find(
    (message) =>
      message.id === run.userMessageId &&
      message.threadId === run.threadId &&
      message.role === "user",
  );
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    request: request?.text.slice(0, 2_000) ?? null,
    model: run.modelSelection,
    requestedAt: DateTime.formatIso(DateTime.makeUnsafe(run.requestedAt)),
    observedAt: DateTime.formatIso(observedAt),
    visibility: !active
      ? "historical"
      : ageMs === null
        ? "unknown"
        : ageMs > 60_000
          ? "stale"
          : "recent",
    currentStep: stepAgeMs !== null && stepAgeMs <= 60_000 ? activity!.text : null,
    lastObservedStep: activity
      ? {
          text: activity.text,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(activity.updatedAt)),
          ageMs: stepAgeMs,
        }
      : null,
    lastUpdate: publicText?.slice(-2_000) ?? null,
    lastUpdateAt: publicItem ? DateTime.formatIso(DateTime.makeUnsafe(publicItem.updatedAt)) : null,
    evidenceAt: evidenceAt ? DateTime.formatIso(DateTime.makeUnsafe(evidenceAt)) : null,
    ageMs,
    commentary: publicText?.slice(-2_000) ?? null,
  };
}
