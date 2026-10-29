import {
  ApprovalReviewError,
  ApprovalReviewForwardAck,
  ApprovalReviewOrderReceive,
  type ApprovalReviewReceiverReadinessInput,
  type ApprovalReviewReceiverReadiness,
  type EnvironmentSessionPrincipalShape,
  CommandId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { canonical, hash, forwardedOrderText } from "./ApprovalReviewPackage.ts";

export class ApprovalReviewOrderReceiver extends Context.Service<
  ApprovalReviewOrderReceiver,
  {
    readonly readiness: (
      input: ApprovalReviewReceiverReadinessInput,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewReceiverReadiness, ApprovalReviewError>;
    readonly receive: (
      input: ApprovalReviewOrderReceive,
      actor: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ApprovalReviewForwardAck, ApprovalReviewError>;
  }
>()("t3/orchestration-v2/ApprovalReviewOrderReceiver") {}
const decodeApprovalReviewOrderReceive = Schema.decodeEffect(ApprovalReviewOrderReceive);
const decodeApprovalReviewForwardAckJson = Schema.decodeEffect(
  Schema.fromJsonString(ApprovalReviewForwardAck),
);

const make = Effect.gen(function* () {
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const readiness = Effect.fn("ApprovalReviewOrderReceiver.readiness")(function* (
    input: ApprovalReviewReceiverReadinessInput,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    if (!policy.enabled) return yield* new ApprovalReviewError({ reason: "disabled" });
    const receiver = policy.receiver;
    if (
      receiver === undefined ||
      actor.method !== "dpop-access-token" ||
      actor.sessionId !== receiver.sessionId ||
      actor.subject !== receiver.subject ||
      actor.proofKeyThumbprint !== receiver.proofKeyThumbprint ||
      !actor.scopes.has("orchestration:operate") ||
      input.targetThreadId !== receiver.threadId ||
      input.testOnly !== receiver.testOnly
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const thread = yield* projections.getThread(receiver.threadId).pipe(Effect.option);
    return {
      sessionId: actor.sessionId,
      subject: actor.subject,
      method: "dpop-access-token" as const,
      proofKeyThumbprint: receiver.proofKeyThumbprint,
      environmentId,
      threadId: receiver.threadId,
      testOnly: receiver.testOnly,
      ready:
        thread._tag === "Some" &&
        thread.value.archivedAt === null &&
        thread.value.deletedAt === null,
    };
  });
  const receive = Effect.fn("ApprovalReviewOrderReceiver.receive")(function* (
    raw: ApprovalReviewOrderReceive,
    actor: EnvironmentSessionPrincipalShape,
  ) {
    if (!policy.enabled) return yield* new ApprovalReviewError({ reason: "disabled" });
    const receiver = policy.receiver;
    if (
      receiver === undefined ||
      actor.method !== "dpop-access-token" ||
      actor.sessionId !== receiver.sessionId ||
      actor.subject !== receiver.subject ||
      actor.proofKeyThumbprint !== receiver.proofKeyThumbprint ||
      !actor.scopes.has("orchestration:operate")
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const input = yield* decodeApprovalReviewOrderReceive(raw, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })));
    if (
      input.targetThreadId !== receiver.threadId ||
      input.testOnly !== receiver.testOnly ||
      !input.text.isWellFormed() ||
      hash(input.text) !== input.fullTextHash ||
      input.commandId !== `host-order:${input.orderId}:forward:1` ||
      input.messageId !== `host-order:${input.orderId}:vm-message`
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (input.expiresAt <= now || input.expiresAt > now + 3_600_000)
      return yield* new ApprovalReviewError({ reason: "expired" });
    const payloadHash = hash(canonical(input));
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const reservation = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const inserted = yield* sql<{
                readonly order_id: string;
              }>`INSERT INTO approval_review_order_deliveries
        (host_session_id, order_id, payload_hash, state, ack_json) VALUES (${actor.sessionId}, ${input.orderId}, ${payloadHash}, 'receiving', NULL)
        ON CONFLICT DO NOTHING RETURNING order_id`;
              const existing = yield* sql<{
                readonly payload_hash: string;
                readonly state: string;
                readonly ack_json: string | null;
              }>`SELECT payload_hash, state, ack_json
        FROM approval_review_order_deliveries WHERE host_session_id = ${actor.sessionId} AND order_id = ${input.orderId}`;
              if (existing[0]?.payload_hash !== payloadHash)
                return yield* new ApprovalReviewError({ reason: "conflict" });
              return { fresh: inserted.length === 1, row: existing[0] };
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ApprovalReviewError"
                ? error
                : new ApprovalReviewError({ reason: "storage" }),
            ),
          );
        if (!reservation.fresh) {
          if (reservation.row.state !== "received" || reservation.row.ack_json === null)
            return yield* new ApprovalReviewError({ reason: "forward-unknown" });
          return yield* decodeApprovalReviewForwardAckJson(reservation.row.ack_json).pipe(
            Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })),
          );
        }
        return yield* restore(
          Effect.gen(function* () {
            const accepted = yield* orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(input.commandId),
                threadId: receiver.threadId,
                messageId: input.messageId,
                text: forwardedOrderText(input),
                attachments: [],
                createdBy: "agent",
                creationSource: "server",
                dispatchMode: receiver.testOnly
                  ? { type: "defer_start" }
                  : { type: "start_immediately" },
              })
              .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "forward-unknown" })));
            const message = accepted.storedEvents
              .flatMap(({ event }) =>
                event.type === "message.updated" && event.payload.id === input.messageId
                  ? [event.payload]
                  : [],
              )
              .at(-1);
            const run = accepted.storedEvents
              .flatMap(({ event }) =>
                (event.type === "run.created" || event.type === "run.updated") &&
                event.payload.id === message?.runId
                  ? [event.payload]
                  : [],
              )
              .at(-1);
            if (
              message?.runId == null ||
              run?.userMessageId !== input.messageId ||
              run.threadId !== receiver.threadId ||
              message.text !== forwardedOrderText(input)
            )
              return yield* new ApprovalReviewError({ reason: "forward-unknown" });
            const ack: ApprovalReviewForwardAck = {
              instructionHash: hash(forwardedOrderText(input)),
              orderId: input.orderId,
              orderRevision: input.orderRevision,
              commandId: input.commandId,
              fullTextHash: input.fullTextHash,
              environmentId,
              threadId: receiver.threadId,
              messageId: input.messageId,
              runId: message.runId,
              runOrdinal: run.ordinal,
              acceptedSequence: accepted.sequence,
            };
            yield* sql`UPDATE approval_review_order_deliveries SET state = 'received', ack_json = ${canonical(ack)}
        WHERE host_session_id = ${actor.sessionId} AND order_id = ${input.orderId} AND state = 'receiving'`.pipe(
              Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })),
            );
            return ack;
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? sql`UPDATE approval_review_order_deliveries SET state = 'unknown' WHERE host_session_id = ${actor.sessionId} AND order_id = ${input.orderId} AND state = 'receiving'`.pipe(
                  Effect.ignore,
                  Effect.uninterruptible,
                )
              : Effect.void,
          ),
        );
      }),
    );
  });
  return ApprovalReviewOrderReceiver.of({ receive, readiness });
});
export const layer = Layer.effect(ApprovalReviewOrderReceiver, make);
