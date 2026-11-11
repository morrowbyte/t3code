import type {
  OrchestrationV2ProviderGoal,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { RuntimeRequestId } from "@t3tools/contracts";
import { isOrchestrationV2ThreadSnoozed } from "@t3tools/shared/orchestrationV2ThreadSnooze";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { threadAttentionRequests } from "../state/models.ts";
import type { ObservatoryNativeDetails, ObservatoryNode } from "./native.ts";

export type ObservatoryTaskStatus =
  | "working"
  | "waiting_agent"
  | "waiting_user"
  | "complete"
  | "paused"
  | "blocked"
  | "open";

export const OBSERVATORY_TASK_LABELS: Record<ObservatoryTaskStatus, string> = {
  working: "Working",
  waiting_agent: "Waiting for agent",
  waiting_user: "Waiting for you",
  complete: "Complete",
  paused: "Paused",
  blocked: "Blocked",
  open: "Needs follow-up",
};

const active = (status: string) =>
  ["pending", "queued", "preparing", "starting", "running", "waiting"].includes(status);
const userRequest = (kind: string) => kind !== "dynamic_tool_call" && kind !== "auth_refresh";

export function presentTaskInterruption(goal: OrchestrationV2ProviderGoal | null, failed = false) {
  const reason =
    goal?.status === "paused" || goal?.status === "blocked"
      ? "No reason provided with this status."
      : goal?.status === "budget_limited"
        ? "The goal reached its token budget."
        : goal?.status === "usage_limited"
          ? "The provider reported a usage limit."
          : failed
            ? "The last run failed."
            : null;
  if (reason === null) return null;
  return {
    reason,
    nextStep:
      goal?.status === "usage_limited"
        ? "Review usage limits, then send /goal resume when capacity is available."
        : goal !== null && goal.status !== "active" && goal.status !== "complete"
          ? "Review the latest update, then send /goal resume when ready."
          : "Review the last error and send a follow-up in the thread.",
  };
}

export function observatoryTaskPriority(
  shell: OrchestrationV2ThreadShell,
  nowMs = Clock.Clock.defaultValue().currentTimeMillisUnsafe(),
): number {
  if (shell.archivedAt !== null) return 6;
  if (threadAttentionRequests(shell).length > 0) return 0;
  if (active(shell.activityRunStatus ?? shell.status) || shell.blockedOnThreadWait) return 1;
  if (shell.goal?.status === "complete") return 5;
  if (shell.goal?.status === "paused" || isOrchestrationV2ThreadSnoozed(shell, nowMs)) return 4;
  return 2;
}

/** A run ending, or even a completed plan, does not complete the assignment. */
export function observatoryTaskStatus(
  shell: OrchestrationV2ThreadShell,
  input: {
    readonly blockingRequest: boolean;
    readonly pendingAgents: boolean;
    readonly nowMs?: number;
  },
): ObservatoryTaskStatus {
  if (input.blockingRequest) return "waiting_user";
  if (shell.blockedOnThreadWait || input.pendingAgents) return "waiting_agent";
  if (active(shell.activityRunStatus ?? shell.status)) return "working";
  if (shell.goal?.status === "complete") return "complete";
  if (
    shell.goal?.status === "paused" ||
    isOrchestrationV2ThreadSnoozed(
      shell,
      input.nowMs ?? Clock.Clock.defaultValue().currentTimeMillisUnsafe(),
    )
  )
    return "paused";
  if (
    shell.status === "failed" ||
    ["blocked", "budget_limited", "usage_limited"].includes(shell.goal?.status ?? "")
  )
    return "blocked";
  return "open";
}

export function projectObservatoryTask(
  node: ObservatoryNode,
  nodes: readonly ObservatoryNode[],
  detail: ObservatoryNativeDetails | null,
  nowMs = Clock.Clock.defaultValue().currentTimeMillisUnsafe(),
) {
  const shell = node.shell;
  const projection = detail?.projection;
  const summaries = shell.settledOverride === "settled" ? [] : threadAttentionRequests(shell);
  const includesRequest = (id: string) =>
    shell.settledOverride !== "settled" &&
    (shell.pendingRuntimeRequests === undefined || summaries.some((summary) => summary.id === id));
  const requests = projection?.runtimeRequests.filter(
    (request) =>
      request.status === "pending" &&
      includesRequest(request.id) &&
      detail?.ownedNodeIds.has(request.nodeId) &&
      userRequest(request.kind),
  );
  const pending = requests?.filter(
    (request) => request.responseCapability.type !== "not_resumable",
  );
  const blocks = (request: NonNullable<typeof pending>[number]) => {
    const item = projection?.turnItems.findLast(
      (item) => item.type === "user_input_request" && item.requestId === request.id,
    );
    return (
      request.responseCapability.type !== "message" &&
      !(item?.type === "user_input_request" && item.responseMode === "message")
    );
  };
  const decisions = (pending ?? []).map((request) => {
    const item = projection?.turnItems.findLast(
      (item) =>
        (item.type === "user_input_request" || item.type === "approval_request") &&
        item.threadId === node.ref.threadId &&
        item.requestId === request.id,
    );
    return {
      id: request.id,
      label:
        (item?.type === "user_input_request"
          ? item.questions[0]?.question
          : item?.type === "approval_request"
            ? (item.prompt ?? item.reason)
            : null) ?? (request.kind === "user_input" ? "Open question" : "Approval requested"),
      blocking: blocks(request),
    };
  });
  for (const item of projection?.turnItems ?? []) {
    if (
      (item.type !== "secret_request" && item.type !== "link_request") ||
      item.threadId !== node.ref.threadId ||
      item.nodeId === null ||
      !detail?.ownedNodeIds.has(item.nodeId) ||
      !includesRequest(item.id) ||
      item.status !== "waiting"
    )
      continue;
    if (item.type === "secret_request") {
      const run = projection?.runs.find((run) => run.id === item.runId);
      if (
        item.secretStatus !== "pending" ||
        (run ? !active(run.status) : !summaries.some((summary) => summary.id === item.id))
      )
        continue;
    } else if (
      item.linkStatus !== "pending" ||
      projection?.messages.some(
        (message) =>
          message.threadId === node.ref.threadId &&
          message.role === "user" &&
          message.createdBy === "user" &&
          DateTime.isGreaterThan(message.updatedAt, item.startedAt ?? item.updatedAt),
      )
    )
      continue;
    decisions.push({
      id: RuntimeRequestId.make(item.id),
      label:
        item.type === "secret_request"
          ? item.label
          : item.label?.trim() || item.url || item.hint || "Link an environment",
      blocking: true,
    });
  }
  for (const summary of summaries) {
    if (
      decisions.some((request) => request.id === summary.id) ||
      projection?.runtimeRequests.some((request) => request.id === summary.id) ||
      projection?.turnItems.some(
        (item) =>
          item.threadId === node.ref.threadId &&
          (item.type === "secret_request" || item.type === "link_request") &&
          item.id === summary.id,
      )
    )
      continue;
    // A pending summary can outlive the loaded history window without being resolved.
    decisions.push({
      id: summary.id,
      label: summary.kind === "user_input" ? "Open question" : "Approval requested",
      blocking: summary.blocking !== false,
    });
  }
  const request = decisions.find((request) => request.blocking) ?? decisions[0] ?? null;
  const blockingRequest = decisions.some((request) => request.blocking);
  const children = nodes.filter((child) => child.parentKey === node.key);
  const dependencies: {
    key: string;
    title: string;
    ref: ScopedThreadRef | null;
    active: boolean;
  }[] = children.map((child) => ({
    key: child.key,
    title: child.title,
    ref: child.ref,
    active:
      active(child.shell.activityRunStatus ?? child.shell.status) ||
      child.shell.blockedOnThreadWait === true,
  }));
  for (const agent of detail?.subagents ?? []) {
    if (agent.childThreadId && children.some((child) => child.ref.threadId === agent.childThreadId))
      continue;
    dependencies.push({
      key: agent.id,
      title: agent.title ?? "Agent",
      ref: agent.childThreadId
        ? { environmentId: node.ref.environmentId, threadId: agent.childThreadId }
        : null,
      active: active(agent.status),
    });
  }
  const parent = nodes.find((candidate) => candidate.key === node.parentKey);
  const run = projection?.runs.find((candidate) => candidate.id === node.runId);
  const message = projection?.messages.find(
    (candidate) => candidate.id === run?.userMessageId && candidate.threadId === node.ref.threadId,
  );
  const interruption = isOrchestrationV2ThreadSnoozed(shell, nowMs)
    ? {
        reason: "The thread is snoozed.",
        nextStep: "Use Wake now in the thread status controls to end the snooze.",
      }
    : presentTaskInterruption(shell.goal, shell.status === "failed");
  const lastError = interruption
    ? projection?.turnItems.findLast(
        (item) =>
          item.type === "error" && item.threadId === node.ref.threadId && item.runId === node.runId,
      )
    : null;
  const lastUpdate = interruption
    ? projection?.turnItems.findLast(
        (item) =>
          item.type === "assistant_message" &&
          item.threadId === node.ref.threadId &&
          item.runId === node.runId &&
          item.text.trim().length > 0,
      )
    : null;
  return {
    interruption,
    lastError: lastError?.type === "error" ? lastError.failure.message : null,
    lastUpdate: lastUpdate?.type === "assistant_message" ? lastUpdate.text : null,
    status: observatoryTaskStatus(shell, {
      nowMs,
      blockingRequest,
      pendingAgents:
        dependencies.some((dependency) => dependency.active) &&
        (!active(shell.activityRunStatus ?? shell.status) || shell.status === "waiting"),
    }),
    objective: shell.goal?.objective ?? message?.text ?? null,
    objectiveSource: shell.goal
      ? ("goal" as const)
      : message
        ? ("request" as const)
        : ("missing" as const),
    planStatus:
      detail === null
        ? ("loading" as const)
        : detail.plans.length === 0
          ? detail.hasUnresolvedPlans
            ? ("unavailable" as const)
            : ("missing" as const)
          : ("ready" as const),
    currentStep: detail?.currentStep?.text ?? null,
    completedSteps: detail?.completedSteps ?? [],
    nextSteps: detail?.nextSteps ?? [],
    steps: detail?.steps ?? [],
    plans: detail?.plans ?? [],
    parent: parent ? { title: parent.title, ref: parent.ref } : null,
    parentOutsidePage: node.parentKey !== null && parent === undefined,
    dependencies,
    request,
  };
}
export type ObservatoryTask = ReturnType<typeof projectObservatoryTask>;
