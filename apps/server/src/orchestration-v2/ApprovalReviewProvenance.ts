import {
  type ApprovalReviewAuthority,
  type ApprovalReviewOriginalOrder,
  type ApprovalReviewProvenance as Provenance,
  type ApprovalReviewProvenanceReadiness,
  type ThreadId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostOrders from "./ApprovalReviewHostOrders.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";
import { frozenReview } from "./ApprovalReviewPackage.ts";

export class ApprovalReviewProvenance extends Context.Reference<{
  readonly readiness: typeof ApprovalReviewProvenanceReadiness.Type;
  readonly verify: (
    original: ApprovalReviewOriginalOrder | undefined,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    packageHash: string,
  ) => Effect.Effect<Provenance>;
}>("t3/ApprovalReviewProvenance", {
  defaultValue: () => ({
    readiness: { mode: "disabled", reason: "trust-unconfigured" },
    verify: (original) =>
      Effect.succeed({
        status: "unverified",
        reason: original === undefined ? "missing-original" : "trust-unconfigured",
      }),
  }),
}) {}
const make = Effect.gen(function* () {
  const orders = yield* HostOrders.ApprovalReviewHostOrders;
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  return {
    readiness:
      !policy.enabled || policy.channels.length === 0
        ? ({ mode: "disabled", reason: "trust-unconfigured" } as const)
        : ({ mode: "host-channel", reason: "paired-channel" } as const),
    verify: orders.verify,
  };
});
export const layer = Layer.effect(ApprovalReviewProvenance, make);

export const verifyAuthority = Effect.fn("ApprovalReviewProvenance.verifyAuthority")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly authority: ApprovalReviewAuthority;
  }) {
    const { authority, threadId, requestId } = input;
    const expected = frozenReview(
      {
        threadId,
        requestId,
        expiresAt: authority.expiresAt,
        action: authority.action,
        ...(authority.originalOrder === undefined
          ? {}
          : { originalOrder: authority.originalOrder }),
        ...(authority.agentRationale === undefined
          ? {}
          : { agentRationale: authority.agentRationale }),
      },
      authority,
    );
    if (expected.packageHash !== authority.packageHash)
      return { status: "unverified", reason: "package-mismatch" } satisfies Provenance;
    const provenance = yield* ApprovalReviewProvenance;
    return yield* provenance.verify(
      authority.originalOrder,
      threadId,
      requestId,
      authority.packageHash,
    );
  },
);
