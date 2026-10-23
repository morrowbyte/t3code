import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export const ATTENTION_CATEGORIES = {
  questions: "Questions",
  approvals: "Approvals",
  completed: "Completed work",
  warnings: "Warnings",
} as const;

export type AttentionCategory = keyof typeof ATTENTION_CATEGORIES;
export type AttentionFilter = AttentionCategory | "all";

export interface AttentionEntry {
  readonly id: string;
  readonly category: AttentionCategory;
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
  readonly title: string;
  readonly description: string;
  readonly occurredAt: string;
}

export function deriveAttentionInbox(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
) {
  const entries: AttentionEntry[] = [];
  let loadedThreads = 0;
  let completionTimeUnavailable = 0;
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    loadedThreads++;
    if (thread.settledOverride === "settled") continue;
    const threadRef = scopeThreadRef(environmentId, thread.id);
    const key = scopedThreadKey(threadRef);
    const base = { threadRef, threadTitle: thread.title };
    const request = thread.pendingRuntimeRequest;
    if (request !== null && request.kind !== "dynamic_tool_call") {
      const category =
        request.kind === "user_input"
          ? "questions"
          : request.kind === "auth_refresh"
            ? "warnings"
            : "approvals";
      entries.push({
        ...base,
        id: `${key}:request:${request.id}`,
        category,
        title:
          category === "questions"
            ? "Question awaiting your answer"
            : category === "approvals"
              ? "Approval needed"
              : "Authentication required",
        description:
          category === "questions"
            ? "Read and answer the pending question in its conversation."
            : category === "approvals"
              ? "Review the request using the original approval controls."
              : "Open the conversation to review the authentication request.",
        occurredAt: DateTime.formatIso(request.createdAt),
      });
    }
    if (thread.status === "failed") {
      entries.push({
        ...base,
        id: `${key}:failure:${thread.latestRunId ?? thread.id}`,
        category: "warnings",
        title: thread.lastErrorClass === "usage_limit" ? "Usage limit reached" : "Work failed",
        description: thread.lastError?.trim() || "The latest run failed. Review its conversation.",
        occurredAt: DateTime.formatIso(thread.latestRunCompletedAt ?? thread.updatedAt),
      });
    }
    const completed =
      thread.latestRunId !== null &&
      thread.activeRunId === null &&
      thread.activityRunStatus == null &&
      !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
      (thread.status === "completed" || thread.status === "idle") &&
      request === null;
    if (!completed) continue;
    // Older shells omit this field. updatedAt can describe a title or visit,
    // so it cannot establish that work actually completed.
    if (thread.latestRunCompletedAt === undefined) {
      completionTimeUnavailable++;
      continue;
    }
    if (thread.latestRunCompletedAt === null) continue;
    entries.push({
      ...base,
      id: `${key}:completed:${thread.latestRunId}`,
      category: "completed",
      title: "Work completed",
      description: "Review the result in its conversation. Settle it there when finished.",
      occurredAt: DateTime.formatIso(thread.latestRunCompletedAt),
    });
  }
  const priority: Record<AttentionCategory, number> = {
    questions: 0,
    approvals: 1,
    warnings: 2,
    completed: 3,
  };
  entries.sort(
    (left, right) =>
      priority[left.category] - priority[right.category] ||
      right.occurredAt.localeCompare(left.occurredAt) ||
      left.id.localeCompare(right.id),
  );
  const counts = { questions: 0, approvals: 0, completed: 0, warnings: 0 };
  for (const entry of entries) counts[entry.category]++;
  return { entries, counts, loadedThreads, completionTimeUnavailable };
}

export type AttentionInboxModel = ReturnType<typeof deriveAttentionInbox>;

export function attentionCoverageLabel(status: EnvironmentShellStatus, hasSnapshot: boolean) {
  if (!hasSnapshot) return "Environment data is not loaded yet.";
  switch (status) {
    case "live":
      return "Live environment data";
    case "synchronizing":
      return "Reconnecting or synchronizing; shown items may be out of date.";
    default:
      return "Cached environment data; shown items may be out of date.";
  }
}
