import type {
  OrchestrationV2Notification,
  OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const ACTIVE_SUBAGENT_STATUSES = new Set<OrchestrationV2Subagent["status"]>([
  "pending",
  "running",
  "waiting",
]);

/**
 * Whether a subagent started another run after a notification reported its
 * final outcome, so that outcome no longer describes it. Claude resumes a
 * finished subagent under the same id. An active subagent is always on a later
 * run, even when the notification was delivered late from the queue; a settled
 * one is on a later run when it started after the notification arrived.
 */
export function subagentResumedSince(
  agent: Pick<OrchestrationV2Subagent, "status" | "startedAt">,
  notifiedAt: string,
): boolean {
  if (ACTIVE_SUBAGENT_STATUSES.has(agent.status)) return true;
  if (agent.startedAt === null) return false;
  const notifiedAtMillis = Date.parse(notifiedAt);
  return (
    !Number.isNaN(notifiedAtMillis) && DateTime.toEpochMillis(agent.startedAt) > notifiedAtMillis
  );
}

export function notificationSubagent<
  T extends Pick<OrchestrationV2Subagent, "id" | "childThreadId">,
>(
  agents: ReadonlyArray<T>,
  source: OrchestrationV2Notification["source"],
  childThreadId: ThreadId,
): T | null {
  return (
    agents.find(
      (agent) =>
        agent.childThreadId === childThreadId &&
        (source.kind !== "delegated_task" || source.taskIds.includes(agent.id)),
    ) ?? null
  );
}
