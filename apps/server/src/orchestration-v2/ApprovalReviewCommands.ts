import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
// @effect-diagnostics nodeBuiltinImport:off - Receipt validation hashes the exact frozen UTF-8 bytes with Node SHA-256.
import * as NodeCrypto from "node:crypto";
import {
  ApprovalReviewError,
  type ApprovalReviewAuthority,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Provenance from "./ApprovalReviewProvenance.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";

type ReviewCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "approval-review.submit" | "approval-review.claim" | "approval-review.receipt" }
>;

// Runs under the orchestrator's thread lock and commits through its existing event sink.
export const plan = Effect.fn("ApprovalReviewCommands.plan")(function* (command: ReviewCommand) {
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  if (!policy.enabled && command.type !== "approval-review.receipt")
    return yield* new ApprovalReviewError({ reason: "disabled" });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const current = yield* projections
    .getRuntimeResponseContext(command.threadId, command.requestId)
    .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [];
  if (command.type === "approval-review.submit") {
    const provenance = yield* Provenance.verifyAuthority(command);
    const authority = { ...command.authority, provenance };
    if (command.authority.originalOrder !== undefined && provenance.status !== "verified")
      return yield* new ApprovalReviewError({ reason: "unverified-original" });
    if (current.request !== undefined) {
      if (
        current.request.responseCapability.type !== "external" ||
        current.request.approvalReview?.packageHash !== command.authority.packageHash
      )
        return yield* new ApprovalReviewError({ reason: "conflict" });
      // A duplicate submission never resets a decision or a spent claim.
      events.push({
        type: "runtime-request.updated",
        threadId: command.threadId,
        nodeId: current.request.nodeId,
        occurredAt: now,
        payload: current.request,
      });
      return events;
    }
    if (command.authority.expiresAt <= DateTime.toEpochMillis(now))
      return yield* new ApprovalReviewError({ reason: "expired" });
    const projection = yield* projections
      .getThreadRecords(command.threadId, [])
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "missing" })));
    if (projection.thread.archivedAt !== null)
      return yield* new ApprovalReviewError({ reason: "conflict" });
    const ordinal = yield* projections
      .getNextTurnItemOrdinal(command.threadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    events.push({
      type: "node.updated",
      threadId: command.threadId,
      nodeId: command.nodeId,
      occurredAt: now,
      payload: {
        id: command.nodeId,
        threadId: command.threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: command.nodeId,
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
      nodeId: command.nodeId,
      occurredAt: now,
      payload: {
        id: command.turnItemId,
        threadId: command.threadId,
        runId: null,
        nodeId: command.nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "waiting",
        title: "Create one new file",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId: command.requestId,
        requestKind: "file-change",
        prompt: command.prompt,
        approvalReview: authority,
      },
    });
    events.push({
      type: "runtime-request.updated",
      threadId: command.threadId,
      nodeId: command.nodeId,
      occurredAt: now,
      payload: {
        id: command.requestId,
        nodeId: command.nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "file-change",
        status: "pending",
        responseCapability: { type: "external" },
        createdAt: now,
        resolvedAt: null,
        approvalReview: authority,
      },
    });
    return events;
  }
  const request = current.request;
  const authority = request?.approvalReview;
  if (request?.responseCapability.type !== "external" || authority === undefined)
    return yield* new ApprovalReviewError({ reason: "missing" });
  if (authority.packageHash !== command.packageHash)
    return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
  if (authority.verifiedTargetId !== command.verifiedTargetId)
    return yield* new ApprovalReviewError({ reason: "target-mismatch" });
  if (authority.workerSubject !== command.workerSubject)
    return yield* new ApprovalReviewError({ reason: "forbidden" });
  let updated: ApprovalReviewAuthority;
  if (command.type === "approval-review.claim") {
    if (authority.expiresAt <= DateTime.toEpochMillis(now))
      return yield* new ApprovalReviewError({ reason: "expired" });
    if (
      authority.originalOrder?.receipt.version === 2 &&
      (authority.originalOrder.receipt.testOnly ||
        authority.originalOrder.receipt.sourceKind !== "human")
    )
      return yield* new ApprovalReviewError({ reason: "synthetic-order" });
    const provenance = yield* Provenance.verifyAuthority({ ...command, authority });
    if (provenance.status !== "verified")
      return yield* new ApprovalReviewError({ reason: "unverified-original" });
    if (authority.state === "claimed" || authority.state === "completed")
      return yield* new ApprovalReviewError({ reason: "replayed" });
    if (
      request.status !== "resolved" ||
      request.decision !== "accept" ||
      authority.state !== "approved"
    )
      return yield* new ApprovalReviewError({ reason: "not-approved" });
    updated = { ...authority, state: "claimed", claimId: command.claimId };
  } else {
    if (
      authority.claimId !== command.claimId ||
      (authority.state !== "claimed" && authority.state !== "completed")
    )
      return yield* new ApprovalReviewError({ reason: "replayed" });
    if (
      authority.state === "completed" &&
      (authority.receipt?.outcome !== command.receipt.outcome ||
        authority.receipt?.contentHash !== command.receipt.contentHash ||
        authority.receipt?.errorCode !== command.receipt.errorCode ||
        authority.receipt?.readback?.path !== command.receipt.readback?.path ||
        authority.receipt?.readback?.contentHash !== command.receipt.readback?.contentHash ||
        authority.receipt?.readback?.mode !== command.receipt.readback?.mode ||
        authority.receipt?.readback?.uid !== command.receipt.readback?.uid ||
        authority.receipt?.readback?.gid !== command.receipt.readback?.gid ||
        authority.receipt?.readback?.targetIdentity !== command.receipt.readback?.targetIdentity)
    )
      return yield* new ApprovalReviewError({ reason: "conflict" });
    const expectedHash = NodeCrypto.createHash("sha256")
      .update(authority.action.content, "utf8")
      .digest("hex");
    if (
      command.receipt.outcome === "reported_succeeded" &&
      command.receipt.contentHash !== expectedHash
    )
      return yield* new ApprovalReviewError({ reason: "invalid-receipt" });
    const readback = command.receipt.readback;
    if (
      readback !== undefined &&
      (readback.path !== authority.action.path ||
        readback.contentHash !== expectedHash ||
        readback.mode !== authority.action.mode ||
        readback.targetIdentity !== authority.verifiedTargetId)
    )
      return yield* new ApprovalReviewError({ reason: "invalid-receipt" });
    updated = { ...authority, state: "completed", receipt: command.receipt };
  }
  events.push({
    type: "runtime-request.updated",
    threadId: command.threadId,
    nodeId: request.nodeId,
    occurredAt: now,
    payload: { ...request, approvalReview: updated },
  });
  if (current.item?.type === "approval_request")
    events.push({
      type: "turn-item.updated",
      threadId: command.threadId,
      nodeId: request.nodeId,
      occurredAt: now,
      payload: { ...current.item, approvalReview: updated, updatedAt: now },
    });
  return events;
});

export const resolve = Effect.fn("ApprovalReviewCommands.resolve")(function* (
  request: OrchestrationV2RuntimeRequest,
  command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
  now: DateTime.Utc,
) {
  const authority = request.approvalReview;
  if (authority === undefined || request.responseCapability.type !== "external")
    return yield* new ApprovalReviewError({ reason: "missing" });
  const reviewer = yield* HumanAuthority.ApprovalReviewHumanAuthority;
  if (
    reviewer === undefined ||
    reviewer.sessionId !== authority.approverSessionId ||
    reviewer.subject !== authority.approverSubject
  )
    return yield* new ApprovalReviewError({ reason: "forbidden" });
  if (command.packageHash !== authority.packageHash)
    return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
  if (authority.expiresAt <= DateTime.toEpochMillis(now))
    return yield* new ApprovalReviewError({ reason: "expired" });
  if (command.decision === "accept" || command.decision === "acceptForSession") {
    const policy = yield* Policy.ApprovalReviewOrderPolicy;
    if (!policy.enabled) return yield* new ApprovalReviewError({ reason: "disabled" });
    if (
      authority.originalOrder?.receipt.version === 2 &&
      (authority.originalOrder.receipt.testOnly ||
        authority.originalOrder.receipt.sourceKind !== "human")
    )
      return yield* new ApprovalReviewError({ reason: "synthetic-order" });
    const provenance = yield* Provenance.verifyAuthority({ ...command, authority });
    if (provenance.status !== "verified")
      return yield* new ApprovalReviewError({ reason: "unverified-original" });
  }
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
