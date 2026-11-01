import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
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

export function observatoryTaskPriority(shell: OrchestrationV2ThreadShell): number {
  if (shell.archivedAt !== null) return 6;
  if (shell.pendingRuntimeRequest && userRequest(shell.pendingRuntimeRequest.kind)) return 0;
  if (active(shell.activityRunStatus ?? shell.status) || shell.blockedOnThreadWait) return 1;
  if (shell.goal?.status === "complete") return 5;
  if (shell.goal?.status === "paused" || shell.snoozedUntil) return 4;
  return 2;
}

/** A run ending, or even a completed plan, does not complete the assignment. */
export function observatoryTaskStatus(
  shell: OrchestrationV2ThreadShell,
  input: { readonly blockingRequest: boolean; readonly pendingAgents: boolean },
): ObservatoryTaskStatus {
  if (input.blockingRequest) return "waiting_user";
  if (shell.blockedOnThreadWait || input.pendingAgents) return "waiting_agent";
  if (active(shell.activityRunStatus ?? shell.status)) return "working";
  if (shell.goal?.status === "complete") return "complete";
  if (shell.goal?.status === "paused" || shell.snoozedUntil) return "paused";
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
) {
  const shell = node.shell;
  const projection = detail?.projection;
  const roots = new Set(
    projection?.runs.flatMap((run) => (run.rootNodeId ? [run.rootNodeId] : [])),
  );
  const requests = projection?.runtimeRequests.filter(
    (request) =>
      request.status === "pending" && roots.has(request.nodeId) && userRequest(request.kind),
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
  const request = pending?.find(blocks) ?? pending?.[0];
  const requestItem =
    request &&
    projection?.turnItems.findLast(
      (item) =>
        (item.type === "user_input_request" || item.type === "approval_request") &&
        item.threadId === node.ref.threadId &&
        item.requestId === request.id,
    );
  const requestLabel =
    requestItem?.type === "user_input_request"
      ? requestItem.questions[0]?.question
      : requestItem?.type === "approval_request"
        ? (requestItem.prompt ?? requestItem.reason)
        : null;
  const summary = shell.pendingRuntimeRequest;
  const blockingRequest =
    requests === undefined
      ? summary !== null && userRequest(summary.kind) && summary.blocking !== false
      : pending!.some(blocks);
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
  return {
    status: observatoryTaskStatus(shell, {
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
          ? ("missing" as const)
          : ("ready" as const),
    currentStep: detail?.currentStep?.text ?? null,
    completedSteps: detail?.completedSteps ?? [],
    nextSteps: detail?.nextSteps ?? [],
    steps: detail?.steps ?? [],
    plans: detail?.plans ?? [],
    parent: parent ? { title: parent.title, ref: parent.ref } : null,
    parentOutsidePage: node.parentKey !== null && parent === undefined,
    dependencies,
    request:
      request || (requests === undefined && summary && userRequest(summary.kind))
        ? {
            id: request?.id ?? summary!.id,
            label:
              requestLabel ??
              (request?.kind === "user_input" || summary?.kind === "user_input"
                ? "Open question"
                : "Approval requested"),
            blocking: request ? blocks(request) : summary?.blocking !== false,
          }
        : null,
  };
}
export type ObservatoryTask = ReturnType<typeof projectObservatoryTask>;
