import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function isOrchestrationV2ThreadSnoozed(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingRuntimeRequests"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  if (thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs)
    return false;
  if (
    (
      thread.pendingRuntimeRequests ??
      (thread.pendingRuntimeRequest === null ? [] : [thread.pendingRuntimeRequest])
    ).some(
      (request) =>
        request.kind !== "user_input" ||
        thread.snoozedAt == null ||
        DateTime.toEpochMillis(request.createdAt) > DateTime.toEpochMillis(thread.snoozedAt),
    ) ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  )
    return false;
  return !(
    thread.status === "failed" &&
    (thread.snoozedAt == null ||
      (thread.latestRunCompletedAt != null &&
        DateTime.toEpochMillis(thread.latestRunCompletedAt) >
          DateTime.toEpochMillis(thread.snoozedAt)))
  );
}
