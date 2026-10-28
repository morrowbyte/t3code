import {
  ApprovalReviewError,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isValidPrivilegedCommand, privilegedCommandHash } from "./PrivilegedCommandPackage.ts";

type Command = Exclude<
  Extract<OrchestrationV2InternalCommand, { readonly type: `privileged-command.${string}` }>,
  { readonly type: "privileged-command.run-ended" }
>;

// Called while the orchestrator holds the thread lock; its event sink commits the claim.
export const plan = Effect.fn("PrivilegedCommandCommands.plan")(function* (command: Command) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const context = yield* store
    .getRuntimeResponseContext(command.threadId, command.requestId)
    .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [];
  if (command.type === "privileged-command.submit") {
    const { authority } = command;
    const running = yield* store
      .getRunningTurnContext(command.threadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    if (
      context.request !== undefined ||
      authority.state !== "pending" ||
      authority.result !== undefined
    )
      return yield* new ApprovalReviewError({ reason: "conflict" });
    if (
      authority.bundle.threadId !== command.threadId ||
      running.run?.id !== authority.bundle.runId ||
      !isValidPrivilegedCommand(authority.bundle) ||
      privilegedCommandHash(command.requestId, authority.bundle) !== authority.packageHash
    )
      return yield* new ApprovalReviewError({ reason: "invalid-action" });
    const ordinal = yield* store
      .getNextTurnItemOrdinal(command.threadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    events.push({
      type: "node.updated",
      threadId: command.threadId,
      runId: authority.bundle.runId,
      nodeId: command.nodeId,
      occurredAt: now,
      payload: {
        id: command.nodeId,
        threadId: command.threadId,
        runId: authority.bundle.runId,
        parentNodeId: running.run.rootNodeId,
        rootNodeId: running.run.rootNodeId ?? command.nodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: command.requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    events.push({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: authority.bundle.runId,
      nodeId: command.nodeId,
      occurredAt: now,
      payload: {
        id: command.turnItemId,
        threadId: command.threadId,
        runId: authority.bundle.runId,
        nodeId: command.nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "waiting",
        title: "Run one privileged script",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId: command.requestId,
        requestKind: "command",
        prompt: authority.bundle.purpose,
        privilegedCommand: authority,
      },
    });
    events.push({
      type: "runtime-request.updated",
      threadId: command.threadId,
      runId: authority.bundle.runId,
      nodeId: command.nodeId,
      occurredAt: now,
      payload: {
        id: command.requestId,
        nodeId: command.nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "external" },
        createdAt: now,
        resolvedAt: null,
        privilegedCommand: authority,
      },
    });
    return events;
  }
  const request = context.request;
  const authority = request?.privilegedCommand;
  if (request?.responseCapability.type !== "external" || authority === undefined)
    return yield* new ApprovalReviewError({ reason: "missing" });
  if (
    command.packageHash !== authority.packageHash ||
    privilegedCommandHash(command.requestId, authority.bundle) !== authority.packageHash
  )
    return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
  if (command.type === "privileged-command.cleanup-visible") {
    if (authority.state !== "unknown" || authority.claimId !== command.claimId)
      return yield* new ApprovalReviewError({ reason: "replayed" });
    if (context.item?.type === "approval_request" && context.item.status === "waiting")
      events.push({
        type: "turn-item.updated",
        threadId: command.threadId,
        nodeId: request.nodeId,
        occurredAt: now,
        payload: { ...context.item, status: "cancelled", completedAt: now, updatedAt: now },
      });
    return events;
  }
  if (
    command.type === "privileged-command.claim" &&
    (request.status !== "resolved" ||
      request.decision !== "accept" ||
      authority.state !== "approved")
  )
    return yield* new ApprovalReviewError({ reason: "not-approved" });
  if (command.type === "privileged-command.claim") {
    const running = yield* store
      .getRunningTurnContext(command.threadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    if (running.run?.id !== authority.bundle.runId)
      return yield* new ApprovalReviewError({ reason: "conflict" });
  }
  if (
    command.type === "privileged-command.result" &&
    authority.state !== "claimed" &&
    !(
      authority.state === "unknown" &&
      command.result.status === "unknown" &&
      command.cleanupConfirmed === true
    )
  )
    return yield* new ApprovalReviewError({ reason: "replayed" });
  if (command.type === "privileged-command.result" && authority.claimId !== command.claimId)
    return yield* new ApprovalReviewError({ reason: "forbidden" });
  if (
    command.type === "privileged-command.unconfirmed" &&
    authority.state !== "approved" &&
    authority.state !== "claimed"
  )
    return yield* new ApprovalReviewError({ reason: "replayed" });
  if (
    command.type === "privileged-command.unconfirmed" &&
    authority.state === "claimed" &&
    authority.claimId !== command.claimId
  )
    return yield* new ApprovalReviewError({ reason: "replayed" });
  const updated =
    command.type === "privileged-command.claim"
      ? {
          ...authority,
          state: "claimed" as const,
          claimId: command.claimId,
          recoveryIdentity: command.recoveryIdentity,
        }
      : command.type === "privileged-command.unconfirmed"
        ? {
            ...authority,
            state: "unknown" as const,
            result: {
              status: "unknown" as const,
              exitCode: null,
              stdout: "",
              stderr: "The execution claim could not be confirmed.",
            },
          }
        : {
            ...authority,
            state:
              command.result.status === "unknown" ? ("unknown" as const) : ("completed" as const),
            result: command.result,
          };
  events.push({
    type: "runtime-request.updated",
    threadId: command.threadId,
    nodeId: request.nodeId,
    occurredAt: now,
    payload: { ...request, privilegedCommand: updated },
  });
  if (context.item?.type === "approval_request")
    events.push({
      type: "turn-item.updated",
      threadId: command.threadId,
      nodeId: request.nodeId,
      occurredAt: now,
      payload: {
        ...context.item,
        ...(command.type === "privileged-command.result" &&
        command.cleanupConfirmed === true &&
        context.item.status === "waiting" &&
        authority.state === "unknown"
          ? { status: "cancelled" as const, completedAt: now }
          : {}),
        privilegedCommand: updated,
        updatedAt: now,
      },
    });
  return events;
});

export const resolve = Effect.fn("PrivilegedCommandCommands.resolve")(function* (
  request: OrchestrationV2RuntimeRequest,
  command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
) {
  const authority = request.privilegedCommand;
  const human = yield* HumanAuthority.ApprovalReviewHumanAuthority;
  if (
    authority === undefined ||
    (human?.method !== "browser-session-cookie" && human?.method !== "dpop-access-token")
  )
    return yield* new ApprovalReviewError({ reason: "forbidden" });
  if (
    command.packageHash !== authority.packageHash ||
    privilegedCommandHash(command.requestId, authority.bundle) !== authority.packageHash
  )
    return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
  if (authority.state !== "pending") return yield* new ApprovalReviewError({ reason: "replayed" });
  if (
    command.decision !== "accept" &&
    command.decision !== "decline" &&
    command.decision !== "cancel"
  )
    return yield* new ApprovalReviewError({ reason: "forbidden" });
  return {
    ...authority,
    state: command.decision === "accept" ? ("approved" as const) : ("rejected" as const),
  };
});

export const stop = Effect.fn("PrivilegedCommandCommands.stop")(function* (input: {
  readonly threadId: import("@t3tools/contracts").ThreadId;
  readonly runId?: import("@t3tools/contracts").RunId;
  readonly onlyPending?: boolean;
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const projection = yield* store
    .getThreadRecords(input.threadId, ["runtimeRequests"])
    .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [];
  for (const request of projection.runtimeRequests) {
    const authority = request.privilegedCommand;
    if (
      authority === undefined ||
      (input.runId !== undefined && authority.bundle.runId !== input.runId) ||
      (input.onlyPending === true && authority.state !== "pending") ||
      !["pending", "approved", "claimed"].includes(authority.state)
    )
      continue;
    const context = yield* store
      .getRuntimeResponseContext(input.threadId, request.id)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const updated =
      authority.state === "pending"
        ? { ...authority, state: "rejected" as const }
        : {
            ...authority,
            state: "unknown" as const,
            result: {
              status: "unknown" as const,
              exitCode: null,
              stdout: "",
              stderr: "Stopped before the result was confirmed.",
            },
          };
    events.push({
      type: "runtime-request.updated",
      threadId: input.threadId,
      nodeId: request.nodeId,
      occurredAt: now,
      payload: {
        ...request,
        status: request.status === "pending" ? "cancelled" : request.status,
        resolvedAt: request.resolvedAt ?? now,
        privilegedCommand: updated,
      },
    });
    if (context.item?.type === "approval_request")
      events.push({
        type: "turn-item.updated",
        threadId: input.threadId,
        nodeId: request.nodeId,
        occurredAt: now,
        payload: {
          ...context.item,
          status: authority.state === "claimed" ? "waiting" : "cancelled",
          completedAt: authority.state === "claimed" ? null : now,
          updatedAt: now,
          privilegedCommand: updated,
        },
      });
    if (
      context.node !== undefined &&
      ["pending", "running", "waiting"].includes(context.node.status)
    )
      events.push({
        type: "node.updated",
        threadId: input.threadId,
        nodeId: request.nodeId,
        occurredAt: now,
        payload: { ...context.node, status: "cancelled", completedAt: now },
      });
  }
  return events;
});
