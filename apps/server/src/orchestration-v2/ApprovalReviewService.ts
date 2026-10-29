// @effect-diagnostics nodeBuiltinImport:off - Frozen review hashes and receipt IDs use Node cryptography without an executor or provider runtime.
import * as NodeCrypto from "node:crypto";
import {
  ApprovalReviewError,
  ApprovalReviewSubmit,
  ApprovalReviewClaim,
  ApprovalReviewReport,
  type ApprovalReviewReady,
  type EnvironmentSessionPrincipalShape,
  type ApprovalReviewOriginalOrder,
  OrchestrationV2RuntimeRequestJson,
  ApprovalReviewAuthority,
  AuthSessionId,
  CommandId,
  NodeId,
  TurnItemId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "./Orchestrator.ts";
import { canonical, hash, frozenReview } from "./ApprovalReviewPackage.ts";
import * as Provenance from "./ApprovalReviewProvenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as HostOrders from "./ApprovalReviewHostOrders.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";

const Target = Schema.Struct({
  verifiedTargetId: Schema.String,
  approverSessionId: AuthSessionId,
  approverSubject: Schema.String,
  requesterSubject: Schema.String,
  workerSubject: Schema.String,
  allowedPath: Schema.String,
  implementationVersion: Schema.String,
  implementationSource: Schema.String.check(Schema.isMaxLength(65_536)),
});

export class ApprovalReviewTargets extends Context.Reference<readonly (typeof Target.Type)[]>(
  "t3/ApprovalReviewTargets",
  { defaultValue: () => [] },
) {}

// Deliberately absent from normal client scopes; only explicitly provisioned identities use it.
export const layerTargets = Layer.effect(
  ApprovalReviewTargets,
  Effect.gen(function* () {
    const json = yield* Config.String("T3CODE_APPROVAL_REVIEW_TARGETS").pipe(
      Config.withDefault("[]"),
    );
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(Target).check(Schema.isMaxLength(16))),
    )(json);
  }),
);

export class ApprovalReviewService extends Context.Service<
  ApprovalReviewService,
  {
    readonly ready: (subject: string) => Effect.Effect<ApprovalReviewReady, ApprovalReviewError>;
    readonly submit: (
      input: ApprovalReviewSubmit,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
        readonly authority: ApprovalReviewAuthority;
      },
      ApprovalReviewError
    >;
    readonly read: (
      input: { readonly threadId: ThreadId; readonly requestId: RuntimeRequestId },
      actor: string | EnvironmentSessionPrincipalShape,
      worker?: boolean,
    ) => Effect.Effect<ApprovalReviewAuthority, ApprovalReviewError>;
    readonly claim: (
      input: ApprovalReviewClaim,
      subject: string,
    ) => Effect.Effect<ApprovalReviewAuthority, ApprovalReviewError>;
    readonly receipt: (
      input: ApprovalReviewReport,
      subject: string,
    ) => Effect.Effect<ApprovalReviewAuthority, ApprovalReviewError>;
  }
>()("t3/orchestration-v2/ApprovalReviewService") {}

const decodeSubmit = Schema.decodeUnknownEffect(ApprovalReviewSubmit);
const decodeAuthority = Schema.decodeUnknownEffect(ApprovalReviewAuthority);
const decodeRuntimeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
);

const make = Effect.gen(function* () {
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  const targets = yield* ApprovalReviewTargets;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const orders = yield* HostOrders.ApprovalReviewHostOrders;
  const provenanceAuthority = yield* Provenance.ApprovalReviewProvenance;
  const dispatch = Effect.fn("ApprovalReviewService.dispatch")(function* (
    command: Parameters<typeof orchestrator.dispatch>[0],
  ) {
    return yield* orchestrator.dispatch(command).pipe(
      Effect.provideService(Provenance.ApprovalReviewProvenance, provenanceAuthority),
      Effect.mapError((cause) =>
        cause._tag === "ApprovalReviewError"
          ? cause
          : new ApprovalReviewError({ reason: "storage" }),
      ),
    );
  });
  const read = Effect.fn("ApprovalReviewService.read")(function* (
    input: { readonly threadId: ThreadId; readonly requestId: RuntimeRequestId },
    actor: string | EnvironmentSessionPrincipalShape,
    worker = false,
  ) {
    if (targets.length === 0) return yield* new ApprovalReviewError({ reason: "disabled" });
    const request = yield* projections
      .getRuntimeRequest(input.threadId, input.requestId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const authority = request?.approvalReview;
    if (request?.responseCapability.type !== "external" || authority === undefined)
      return yield* new ApprovalReviewError({ reason: "missing" });
    const subject = typeof actor === "string" ? actor : actor.subject;
    if (!worker && typeof actor === "string")
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    if (!worker && typeof actor !== "string" && authority.originalOrder?.receipt.version === 2)
      yield* orders.read(authority.originalOrder.receipt.orderId, actor);
    if ((worker ? authority.workerSubject : authority.requesterSubject) !== subject)
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    if (
      !targets.some(
        (target) =>
          target.verifiedTargetId === authority.verifiedTargetId &&
          target.workerSubject === authority.workerSubject &&
          target.requesterSubject === authority.requesterSubject &&
          target.approverSessionId === authority.approverSessionId &&
          target.approverSubject === authority.approverSubject &&
          target.allowedPath === authority.action.path &&
          target.implementationVersion === authority.action.implementationVersion &&
          target.implementationSource === authority.implementationSource &&
          hash(target.implementationSource) === authority.action.implementationHash,
      )
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    return {
      ...authority,
      provenance: yield* Provenance.verifyAuthority({ ...input, authority }).pipe(
        Effect.provideService(Provenance.ApprovalReviewProvenance, provenanceAuthority),
      ),
    };
  });
  const submit = Effect.fn("ApprovalReviewService.submit")(function* (
    raw: ApprovalReviewSubmit,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    const decoded = yield* decodeSubmit(raw, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })),
    );
    const hostOrder = yield* orders.forProposal(decoded.orderId, actor);
    if (hostOrder.assignment === null)
      return yield* new ApprovalReviewError({ reason: "order-inactive" });
    const subject = actor.subject;
    const originalOrder: ApprovalReviewOriginalOrder = {
      receipt: { ...hostOrder.source, forwardRevision: 1, assignment: hostOrder.assignment },
      excerpt: decoded.excerpt,
      destination: { threadId: hostOrder.assignment.threadId, runId: hostOrder.assignment.runId },
    };
    if (
      decoded.excerpt.startUtf16 >= decoded.excerpt.endUtf16 ||
      decoded.excerpt.endUtf16 > hostOrder.source.fullText.length ||
      hostOrder.source.fullText.slice(decoded.excerpt.startUtf16, decoded.excerpt.endUtf16) !==
        decoded.excerpt.text ||
      !decoded.excerpt.text.isWellFormed()
    )
      return yield* new ApprovalReviewError({ reason: "unverified-original" });
    const input = {
      threadId: hostOrder.source.threadId,
      expiresAt: Math.min(decoded.expiresAt, hostOrder.source.expiresAt),
      action: Object.freeze({ ...decoded.action }),
      originalOrder,
      ...(decoded.agentRationale === undefined ? {} : { agentRationale: decoded.agentRationale }),
      requestId: RuntimeRequestId.make(
        `approval-review:${hash(canonical([decoded.orderId, decoded.submissionId]))}`,
      ),
    };
    if (targets.length === 0) return yield* new ApprovalReviewError({ reason: "disabled" });
    const target = targets.find(
      (target) =>
        target.verifiedTargetId === input.action.verifiedTargetId &&
        target.requesterSubject === subject,
    );
    if (target === undefined) return yield* new ApprovalReviewError({ reason: "forbidden" });
    // Exact configured paths keep this first operation bounded; no path-prefix or shell parsing.
    if (
      input.action.path !== target.allowedPath ||
      input.action.path.includes("\0") ||
      !input.action.content.isWellFormed() ||
      !target.implementationSource.isWellFormed() ||
      target.implementationSource.length === 0 ||
      input.action.implementationVersion !== target.implementationVersion ||
      input.action.implementationHash !== hash(target.implementationSource)
    )
      return yield* new ApprovalReviewError({ reason: "invalid-action" });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (input.expiresAt <= now || input.expiresAt > now + 3_600_000)
      return yield* new ApprovalReviewError({ reason: "expired" });
    if (input.agentRationale !== undefined && !input.agentRationale.isWellFormed())
      return yield* new ApprovalReviewError({ reason: "invalid-action" });
    const review = frozenReview(input, target);
    yield* orders.registerProposal({
      orderId: decoded.orderId,
      submissionId: decoded.submissionId,
      requestId: input.requestId,
      packageHash: review.packageHash,
    });
    const sourceAuthority = provenanceAuthority;
    const provenance = yield* sourceAuthority.verify(
      originalOrder,
      input.threadId,
      input.requestId,
      review.packageHash,
    );
    if (provenance.status !== "verified")
      return yield* new ApprovalReviewError({ reason: "unverified-original" });
    const authority = yield* decodeAuthority({
      packageHash: review.packageHash,
      verifiedTargetId: target.verifiedTargetId,
      expiresAt: input.expiresAt,
      state: "pending",
      approverSessionId: target.approverSessionId,
      approverSubject: target.approverSubject,
      requesterSubject: subject,
      workerSubject: target.workerSubject,
      action: input.action,
      implementationSource: target.implementationSource,
      ...(input.originalOrder === undefined ? {} : { originalOrder: input.originalOrder }),
      ...(input.agentRationale === undefined ? {} : { agentRationale: input.agentRationale }),
      provenance,
    }).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })));
    yield* dispatch({
      type: "approval-review.submit",
      commandId: CommandId.make(`approval-submit:${NodeCrypto.randomUUID()}`),
      threadId: input.threadId,
      requestId: input.requestId,
      nodeId: NodeId.make(`approval-review:${input.requestId}`),
      turnItemId: TurnItemId.make(`approval-review:${input.requestId}`),
      authority,
      prompt: review.prompt,
    });
    return {
      threadId: input.threadId,
      requestId: input.requestId,
      authority: yield* read(input, actor),
    };
  });
  const ready = Effect.fn("ApprovalReviewService.ready")(function* (subject: string) {
    if (targets.length === 0) return yield* new ApprovalReviewError({ reason: "disabled" });
    const configured = targets.filter((target) => target.workerSubject === subject);
    if (configured.length === 0) return yield* new ApprovalReviewError({ reason: "forbidden" });
    if (!policy.enabled) return { requests: [], provenance: provenanceAuthority.readiness };
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const requests: ApprovalReviewReady["requests"][number][] = [];
    const sourceAuthority = provenanceAuthority;
    for (const target of configured) {
      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE status = 'resolved' AND json_extract(payload_json, '$.approvalReview.state') = 'approved'
          AND json_extract(payload_json, '$.approvalReview.workerSubject') = ${subject}
          AND json_extract(payload_json, '$.approvalReview.verifiedTargetId') = ${target.verifiedTargetId}
          AND json_extract(payload_json, '$.approvalReview.expiresAt') > ${now}
          AND json_extract(payload_json, '$.approvalReview.approverSessionId') = ${target.approverSessionId}
          AND json_extract(payload_json, '$.approvalReview.approverSubject') = ${target.approverSubject}
          AND json_extract(payload_json, '$.approvalReview.requesterSubject') = ${target.requesterSubject}
          AND json_extract(payload_json, '$.approvalReview.action.path') = ${target.allowedPath}
          AND json_extract(payload_json, '$.approvalReview.action.implementationVersion') = ${target.implementationVersion}
          AND json_extract(payload_json, '$.approvalReview.implementationSource') = ${target.implementationSource}
        ORDER BY created_at ASC, runtime_request_id ASC LIMIT 10
      `.pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
      for (const row of rows) {
        const request = yield* decodeRuntimeRequest(row.payload_json).pipe(
          Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })),
        );
        if (
          request.responseCapability.type !== "external" ||
          request.decision !== "accept" ||
          request.approvalReview === undefined
        )
          continue;
        if (
          request.approvalReview.originalOrder?.receipt.version === 2 &&
          request.approvalReview.originalOrder.receipt.testOnly
        )
          continue;
        const provenance = yield* Provenance.verifyAuthority({
          threadId: ThreadId.make(row.thread_id),
          requestId: request.id,
          authority: request.approvalReview,
        }).pipe(Effect.provideService(Provenance.ApprovalReviewProvenance, provenanceAuthority));
        if (provenance.status !== "verified") continue;
        requests.push({
          threadId: ThreadId.make(row.thread_id),
          requestId: request.id,
          packageHash: request.approvalReview.packageHash,
          verifiedTargetId: target.verifiedTargetId,
        });
        if (requests.length === 10) return { requests, provenance: sourceAuthority.readiness };
      }
    }
    return { requests, provenance: sourceAuthority.readiness };
  });
  const claim = Effect.fn("ApprovalReviewService.claim")(function* (
    input: ApprovalReviewClaim,
    subject: string,
  ) {
    yield* read(input, subject, true);
    yield* dispatch({
      ...input,
      type: "approval-review.claim",
      commandId: CommandId.make(`approval-claim:${NodeCrypto.randomUUID()}`),
      workerSubject: subject,
    });
    return yield* read(input, subject, true);
  });
  const receipt = Effect.fn("ApprovalReviewService.receipt")(function* (
    input: ApprovalReviewReport,
    subject: string,
  ) {
    yield* read(input, subject, true);
    yield* dispatch({
      ...input,
      type: "approval-review.receipt",
      commandId: CommandId.make(`approval-receipt:${NodeCrypto.randomUUID()}`),
      workerSubject: subject,
    });
    return yield* read(input, subject, true);
  });
  return ApprovalReviewService.of({ submit, read, claim, receipt, ready });
});

export const layer = Layer.effect(ApprovalReviewService, make);
