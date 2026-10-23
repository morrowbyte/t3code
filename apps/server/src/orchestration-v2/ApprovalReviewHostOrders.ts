// @effect-diagnostics nodeBuiltinImport:off - Host-generated identifiers are not bearer credentials.
import * as NodeCrypto from "node:crypto";
import {
  ApprovalReviewError,
  ApprovalReviewHostOrder,
  ApprovalReviewHostSource,
  ApprovalReviewOrderCreate,
  ApprovalReviewForwardAck,
  type ApprovalReviewOrderReadiness,
  type ApprovalReviewOrderCancelResult,
  type ApprovalReviewOriginalOrder,
  type ApprovalReviewProvenance,
  type ApprovalReviewOrderReceive,
  type EnvironmentSessionPrincipalShape,
  RuntimeRequestId,
  ThreadId,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Forward from "./ApprovalReviewOrderForward.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { canonical, hash, forwardedOrderText } from "./ApprovalReviewPackage.ts";

interface OrderRow {
  readonly order_id: string;
  readonly source_json: string;
  readonly channel_json: string;
  readonly state: ApprovalReviewHostOrder["state"];
  readonly assignment_json: string | null;
}
export class ApprovalReviewHostOrders extends Context.Service<
  ApprovalReviewHostOrders,
  {
    readonly readiness: (
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewOrderReadiness>;
    readonly create: (
      input: ApprovalReviewOrderCreate,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewHostOrder, ApprovalReviewError>;
    readonly read: (
      orderId: string,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewHostOrder, ApprovalReviewError>;
    readonly cancel: (
      orderId: string,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewOrderCancelResult, ApprovalReviewError>;
    readonly forProposal: (
      orderId: string,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewHostOrder, ApprovalReviewError>;
    readonly registerProposal: (input: {
      readonly orderId: string;
      readonly submissionId: string;
      readonly requestId: RuntimeRequestId;
      readonly packageHash: string;
    }) => Effect.Effect<void, ApprovalReviewError>;
    readonly verify: (
      order: ApprovalReviewOriginalOrder | undefined,
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      packageHash: string,
    ) => Effect.Effect<ApprovalReviewProvenance>;
  }
>()("t3/ApprovalReviewHostOrders") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sourceEnvironmentId = yield* environment.getEnvironmentId;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const forward = yield* Forward.ApprovalReviewOrderForward;
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const storageError = () => new ApprovalReviewError({ reason: "storage" });
  const decode = Effect.fn("ApprovalReviewHostOrders.decode")(function* (row: OrderRow) {
    const source = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ApprovalReviewHostSource),
    )(row.source_json).pipe(Effect.mapError(storageError));
    const channel = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Policy.PairedVm))(
      row.channel_json,
    ).pipe(Effect.mapError(storageError));
    const assignment = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.NullOr(ApprovalReviewForwardAck)),
    )(row.assignment_json ?? "null").pipe(Effect.mapError(storageError));
    const order = yield* Schema.decodeUnknownEffect(ApprovalReviewHostOrder)({
      source,
      vmId: channel.vmId,
      targetThreadId: channel.threadId,
      state: row.state,
      assignment,
      forwardRevision: row.assignment_json === null ? 0 : 1,
    }).pipe(Effect.mapError(storageError));
    if (
      source.sourceEnvironmentId !== sourceEnvironmentId ||
      hash(source.fullText) !== source.fullTextHash ||
      (source.sourceKind === "synthetic") !== source.testOnly
    )
      return yield* storageError();
    return { order, channel };
  });
  const load = Effect.fn("ApprovalReviewHostOrders.load")(function* (orderId: string) {
    const rows =
      yield* sql<OrderRow>`SELECT order_id, source_json, channel_json, state, assignment_json
      FROM approval_review_host_orders WHERE order_id = ${orderId}`.pipe(
        Effect.mapError(storageError),
      );
    if (rows[0] === undefined) return yield* new ApprovalReviewError({ reason: "missing" });
    return yield* decode(rows[0]);
  });
  const active = Effect.fn("ApprovalReviewHostOrders.active")(function* (
    order: ApprovalReviewHostOrder,
  ) {
    if (order.source.expiresAt <= DateTime.toEpochMillis(yield* DateTime.now))
      return yield* new ApprovalReviewError({ reason: "expired" });
    if (order.state !== "active" || order.assignment === null)
      return yield* new ApprovalReviewError({ reason: "order-inactive" });
  });
  const readiness = Effect.fn("ApprovalReviewHostOrders.readiness")(function* (
    actor: EnvironmentSessionPrincipalShape,
  ) {
    const human = Policy.humanFor(policy, actor);
    if (human === undefined)
      return {
        enabled: false,
        reason:
          policy.humans.length === 0 ? "human-authority-unconfigured" : "human-authority-required",
        channels: [],
      } satisfies ApprovalReviewOrderReadiness;
    const channels = yield* Effect.forEach(
      policy.channels,
      Effect.fn("ApprovalReviewHostOrders.channelReadiness")(function* (channel) {
        const control = yield* projections.getThread(channel.hostThreadId).pipe(Effect.option);
        const ready =
          control._tag === "Some" &&
          control.value.archivedAt === null &&
          control.value.deletedAt === null &&
          (yield* forward.ready(channel, human.testOnly));
        return {
          hostThreadId: channel.hostThreadId,
          vmId: channel.vmId,
          label: channel.label,
          environmentId: channel.environmentId,
          threadId: channel.threadId,
          ready,
          reason: ready ? ("ready" as const) : ("forward-unavailable" as const),
        };
      }),
    );
    const enabled = channels.some((channel) => channel.ready);
    return {
      enabled,
      reason: enabled
        ? "ready"
        : channels.length === 0
          ? "channel-unconfigured"
          : "forward-unavailable",
      sourceKind: human.sourceKind,
      testOnly: human.testOnly,
      channels,
    } satisfies ApprovalReviewOrderReadiness;
  });
  const read = Effect.fn("ApprovalReviewHostOrders.read")(function* (
    orderId: string,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    const { order, channel } = yield* load(orderId);
    const human = Policy.humanFor(policy, actor);
    if (
      (human === undefined ||
        actor.sessionId !== order.source.sessionId ||
        actor.subject !== order.source.principal) &&
      !(
        Policy.matchesVm(channel, actor) &&
        policy.channels.some((current) => canonical(current) === canonical(channel))
      )
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    return order;
  });
  const forProposal = Effect.fn("ApprovalReviewHostOrders.forProposal")(function* (
    orderId: string,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    const { order, channel } = yield* load(orderId);
    if (
      !Policy.matchesVm(channel, actor) ||
      !policy.channels.some((current) => canonical(current) === canonical(channel))
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    yield* active(order);
    return order;
  });
  const create = Effect.fn("ApprovalReviewHostOrders.create")(function* (
    raw: ApprovalReviewOrderCreate,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    const human = Policy.humanFor(policy, actor);
    if (human === undefined || !actor.scopes.has("orchestration:operate"))
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const input = yield* Schema.decodeUnknownEffect(ApprovalReviewOrderCreate)(raw, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })));
    const prior =
      yield* sql<OrderRow>`SELECT order_id, source_json, channel_json, state, assignment_json FROM approval_review_host_orders
      WHERE human_session_id = ${actor.sessionId} AND client_request_id = ${input.clientRequestId}`.pipe(
        Effect.mapError(storageError),
      );
    if (prior[0] !== undefined) {
      const existing = yield* decode(prior[0]);
      if (
        existing.order.source.fullText !== input.text ||
        existing.order.source.threadId !== input.sourceThreadId ||
        existing.order.source.principal !== actor.subject ||
        existing.order.source.expiresAt !== input.expiresAt ||
        existing.order.vmId !== input.vmId
      )
        return yield* new ApprovalReviewError({ reason: "conflict" });
      return existing.order;
    }
    const channel = policy.channels.find((channel) => channel.vmId === input.vmId);
    if (channel === undefined || !(yield* forward.ready(channel, human.testOnly)))
      return yield* new ApprovalReviewError({ reason: "channel-unconfigured" });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (input.expiresAt <= now || input.expiresAt > now + 3_600_000)
      return yield* new ApprovalReviewError({ reason: "expired" });
    if (!input.text.isWellFormed())
      return yield* new ApprovalReviewError({ reason: "invalid-action" });
    if (input.sourceThreadId !== channel.hostThreadId)
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const sourceThread = yield* projections
      .getThread(channel.hostThreadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "missing" })));
    if (sourceThread.archivedAt !== null || sourceThread.deletedAt !== null)
      return yield* new ApprovalReviewError({ reason: "order-inactive" });
    const orderId = `order:${NodeCrypto.randomUUID()}`;
    const source: ApprovalReviewHostSource = {
      version: 2,
      orderId,
      orderRevision: 1,
      sourceKind: human.sourceKind,
      testOnly: human.testOnly,
      sourceEnvironmentId,
      sessionId: actor.sessionId,
      principal: actor.subject,
      threadId: channel.hostThreadId,
      messageId: MessageId.make(`host-order:${orderId}`),
      createdAt: now,
      expiresAt: input.expiresAt,
      fullText: input.text,
      fullTextHash: hash(input.text),
      originalLink: `host-order:${orderId}`,
    };
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const reservation = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const inserted = yield* sql<{
                readonly order_id: string;
              }>`INSERT INTO approval_review_host_orders
        (order_id, human_session_id, client_request_id, source_json, channel_json, state, assignment_json, expires_at, created_at)
        VALUES (${orderId}, ${actor.sessionId}, ${input.clientRequestId}, ${canonical(source)}, ${canonical(channel)}, 'forwarding', NULL, ${input.expiresAt}, ${now})
        ON CONFLICT(human_session_id, client_request_id) DO NOTHING RETURNING order_id`;
              const rows =
                yield* sql<OrderRow>`SELECT order_id, source_json, channel_json, state, assignment_json FROM approval_review_host_orders
        WHERE human_session_id = ${actor.sessionId} AND client_request_id = ${input.clientRequestId}`;
              if (rows[0] === undefined) return yield* storageError();
              const existing = yield* decode(rows[0]);
              if (
                existing.order.source.fullText !== input.text ||
                existing.order.source.threadId !== input.sourceThreadId ||
                existing.order.source.principal !== actor.subject ||
                existing.order.source.expiresAt !== input.expiresAt ||
                canonical(existing.channel) !== canonical(channel)
              )
                return yield* new ApprovalReviewError({ reason: "conflict" });
              return { fresh: inserted.length === 1, order: existing.order };
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ApprovalReviewError" ? error : storageError(),
            ),
          );
        if (!reservation.fresh) return reservation.order;
        const delivery: ApprovalReviewOrderReceive = {
          testOnly: human.testOnly,
          orderId,
          orderRevision: 1,
          text: source.fullText,
          fullTextHash: source.fullTextHash,
          expiresAt: source.expiresAt,
          targetThreadId: channel.threadId,
          commandId: `host-order:${orderId}:forward:1`,
          messageId: MessageId.make(`host-order:${orderId}:vm-message`),
        };
        return yield* restore(
          Effect.gen(function* () {
            const ack = yield* forward.send(channel, delivery).pipe(Effect.option);
            if (
              ack._tag === "None" ||
              ack.value.orderId !== orderId ||
              ack.value.orderRevision !== 1 ||
              ack.value.commandId !== delivery.commandId ||
              ack.value.fullTextHash !== source.fullTextHash ||
              ack.value.instructionHash !== hash(forwardedOrderText(delivery)) ||
              ack.value.environmentId !== channel.environmentId ||
              ack.value.threadId !== channel.threadId ||
              ack.value.messageId !== delivery.messageId ||
              ack.value.runId !==
                derive.run({ threadId: channel.threadId, ordinal: ack.value.runOrdinal })
            ) {
              yield* sql`UPDATE approval_review_host_orders SET state = 'forward-unknown' WHERE order_id = ${orderId} AND state = 'forwarding'`.pipe(
                Effect.mapError(storageError),
              );
            } else {
              yield* sql`UPDATE approval_review_host_orders SET state = 'active', assignment_json = ${canonical(ack.value)}
        WHERE order_id = ${orderId} AND state = 'forwarding'`.pipe(Effect.mapError(storageError));
            }
            return (yield* load(orderId)).order;
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? sql`UPDATE approval_review_host_orders SET state = 'forward-unknown' WHERE order_id = ${orderId} AND state = 'forwarding'`.pipe(
                  Effect.ignore,
                  Effect.uninterruptible,
                )
              : Effect.void,
          ),
        );
      }),
    );
  });
  const cancel = Effect.fn("ApprovalReviewHostOrders.cancel")(function* (
    orderId: string,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    const order = yield* read(orderId, actor);
    // Accept/claim hold this same thread lock from provenance verification through event commit.
    return yield* threadDispatch.withLock(
      order.source.threadId,
      Effect.gen(function* () {
        const current = yield* read(orderId, actor);
        if (
          Policy.humanFor(policy, actor) === undefined ||
          actor.sessionId !== current.source.sessionId ||
          !actor.scopes.has("orchestration:operate")
        )
          return yield* new ApprovalReviewError({ reason: "forbidden" });
        yield* sql`UPDATE approval_review_host_orders SET state = 'cancelled' WHERE order_id = ${orderId}`.pipe(
          Effect.mapError(storageError),
        );
        const proposals = yield* sql<{
          readonly request_id: string;
          readonly package_hash: string;
        }>`SELECT request_id, package_hash FROM approval_review_order_proposals
          WHERE order_id = ${orderId} ORDER BY request_id`.pipe(Effect.mapError(storageError));
        const alreadyClaimedActions: ApprovalReviewOrderCancelResult["alreadyClaimedActions"][number][] =
          [];
        for (const proposal of proposals) {
          const requestId = RuntimeRequestId.make(proposal.request_id);
          const request = yield* projections
            .getRuntimeRequest(current.source.threadId, requestId)
            .pipe(Effect.mapError(storageError));
          const authority = request?.approvalReview;
          if (authority?.state !== "claimed" && authority?.state !== "completed") continue;
          if (authority.packageHash !== proposal.package_hash || authority.claimId === undefined)
            return yield* storageError();
          alreadyClaimedActions.push({
            threadId: current.source.threadId,
            requestId,
            packageHash: authority.packageHash,
            claimId: authority.claimId,
            state: authority.state,
            action: authority.action,
          });
        }
        return { ...(yield* load(orderId)).order, alreadyClaimedActions };
      }),
    );
  });
  const registerProposal = Effect.fn("ApprovalReviewHostOrders.registerProposal")(
    function* (input: {
      readonly orderId: string;
      readonly submissionId: string;
      readonly requestId: RuntimeRequestId;
      readonly packageHash: string;
    }) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* active((yield* load(input.orderId)).order);
            yield* sql`INSERT INTO approval_review_order_proposals(order_id, submission_id, request_id, package_hash)
        VALUES (${input.orderId}, ${input.submissionId}, ${input.requestId}, ${input.packageHash}) ON CONFLICT DO NOTHING`;
            const rows = yield* sql<{
              readonly request_id: string;
              readonly package_hash: string;
            }>`SELECT request_id, package_hash
        FROM approval_review_order_proposals WHERE order_id = ${input.orderId} AND submission_id = ${input.submissionId}`;
            if (
              rows[0]?.request_id !== input.requestId ||
              rows[0]?.package_hash !== input.packageHash
            )
              return yield* new ApprovalReviewError({ reason: "conflict" });
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ApprovalReviewError" ? error : storageError(),
          ),
        );
    },
  );
  const verify = Effect.fn("ApprovalReviewHostOrders.verify")(function* (
    original: ApprovalReviewOriginalOrder | undefined,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    packageHash: string,
  ) {
    const unverified = (
      reason: Extract<ApprovalReviewProvenance, { status: "unverified" }>["reason"],
    ): ApprovalReviewProvenance => ({ status: "unverified", reason });
    if (original === undefined) return unverified("missing-original");
    if (original.receipt.version !== 2) return unverified("legacy-original");
    const receipt = original.receipt;
    const loaded = yield* load(receipt.orderId).pipe(Effect.option);
    if (loaded._tag === "None") return unverified("invalid-original");
    const { order, channel } = loaded.value;
    const isActive = yield* active(order).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (
      !isActive ||
      order.assignment === null ||
      !policy.channels.some((current) => canonical(current) === canonical(channel))
    )
      return unverified("order-inactive");
    const expected = { ...order.source, forwardRevision: 1, assignment: order.assignment };
    if (
      canonical(receipt) !== canonical(expected) ||
      original.destination.threadId !== order.assignment.threadId ||
      original.destination.runId !== order.assignment.runId
    )
      return unverified("invalid-original");
    // Review requests live on the host's source thread; destination is separately host-bound.
    if (threadId !== order.source.threadId) return unverified("unsupported-lineage");
    const { excerpt } = original;
    if (
      excerpt.startUtf16 < 0 ||
      excerpt.startUtf16 >= excerpt.endUtf16 ||
      excerpt.endUtf16 > receipt.fullText.length ||
      receipt.fullText.slice(excerpt.startUtf16, excerpt.endUtf16) !== excerpt.text ||
      !excerpt.text.isWellFormed()
    )
      return unverified("invalid-excerpt");
    const proposal = yield* sql<{
      readonly package_hash: string;
    }>`SELECT package_hash FROM approval_review_order_proposals
      WHERE order_id = ${receipt.orderId} AND request_id = ${requestId}`.pipe(Effect.option);
    if (proposal._tag === "None" || proposal.value[0]?.package_hash !== packageHash)
      return unverified("package-mismatch");
    return { status: "verified", reason: "trusted-original" } satisfies ApprovalReviewProvenance;
  });
  return ApprovalReviewHostOrders.of({
    readiness,
    create,
    read,
    cancel,
    forProposal,
    registerProposal,
    verify,
  });
});
// The exact layer reference is shared with Orchestrator.layer by application-layer memoization.
export const layer = Layer.effect(ApprovalReviewHostOrders, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
