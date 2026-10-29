import {
  ApprovalReviewError,
  ApprovalReviewForwardAck,
  type ApprovalReviewAgentPropose,
  type ApprovalReviewHostOrder,
  type ApprovalReviewResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";
import * as Forward from "./ApprovalReviewOrderForward.ts";

export class ApprovalReviewOrderAgent extends Context.Service<
  ApprovalReviewOrderAgent,
  {
    readonly current: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ApprovalReviewHostOrder, ApprovalReviewError>;
    readonly propose: (
      scope: McpInvocationScope,
      input: ApprovalReviewAgentPropose,
    ) => Effect.Effect<typeof ApprovalReviewResult.Type, ApprovalReviewError>;
  }
>()("t3/orchestration-v2/ApprovalReviewOrderAgent") {}
const decodeApprovalReviewForwardAckJson = Schema.decodeEffect(
  Schema.fromJsonString(ApprovalReviewForwardAck),
);

const make = Effect.gen(function* () {
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const forward = yield* Forward.ApprovalReviewOrderForward;
  const bound = Effect.fn("ApprovalReviewOrderAgent.bound")(function* (scope: McpInvocationScope) {
    const caller = scope.thread;
    const receiver = policy.receiver;
    if (
      caller === undefined ||
      receiver?.host === undefined ||
      caller.threadId !== receiver.threadId ||
      !scope.capabilities.has("orchestration")
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const snapshot = yield* projections
      .getThreadRecords(caller.threadId, ["runs", "providerThreads", "attempts"])
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "forbidden" })));
    const run = snapshot.runs.find(
      (run) => run.status === "running" && run.providerInstanceId === caller.providerInstanceId,
    );
    const thread = snapshot.providerThreads.find(
      (thread) =>
        thread.id === run?.providerThreadId &&
        thread.providerSessionId === caller.providerSessionId &&
        thread.providerInstanceId === caller.providerInstanceId,
    );
    if (
      run === undefined ||
      thread === undefined ||
      snapshot.thread.archivedAt !== null ||
      snapshot.thread.deletedAt !== null ||
      snapshot.thread.activeProviderThreadId !== thread.id ||
      !snapshot.attempts.some(
        (attempt) => attempt.id === run.activeAttemptId && attempt.runId === run.id,
      )
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const rows = yield* sql<{
      readonly ack_json: string;
    }>`SELECT ack_json FROM approval_review_order_deliveries
      WHERE host_session_id = ${receiver.sessionId} AND state = 'received'
        AND json_extract(ack_json, '$.threadId') = ${caller.threadId} AND json_extract(ack_json, '$.runId') = ${run.id}
      LIMIT 1`.pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    if (rows[0] === undefined) return yield* new ApprovalReviewError({ reason: "forbidden" });
    const ack = yield* decodeApprovalReviewForwardAckJson(rows[0].ack_json).pipe(
      Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })),
    );
    return { ack, receiver, host: receiver.host };
  });
  const current = Effect.fn("ApprovalReviewOrderAgent.current")(function* (
    scope: McpInvocationScope,
  ) {
    const { ack, receiver, host } = yield* bound(scope);
    return yield* forward.readOrder(host, receiver.testOnly, ack.orderId);
  });
  const propose = Effect.fn("ApprovalReviewOrderAgent.propose")(function* (
    scope: McpInvocationScope,
    input: ApprovalReviewAgentPropose,
  ) {
    if (!policy.enabled) return yield* new ApprovalReviewError({ reason: "disabled" });
    const { ack, receiver, host } = yield* bound(scope);
    return yield* forward.propose(host, receiver.testOnly, { ...input, orderId: ack.orderId });
  });
  return ApprovalReviewOrderAgent.of({ current, propose });
});
export const layer = Layer.effect(ApprovalReviewOrderAgent, make);
