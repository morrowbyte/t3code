import * as Schema from "effect/Schema";
import {
  AuthSessionId,
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "./baseSchemas.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u));
export const ApprovalReviewHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const BoundedText = Schema.String.check(Schema.isMaxLength(65_536));

// Signatures cover these exact strings; decoding must never trim or normalize them.
const LegacyOriginalReceipt = Schema.Struct({
  version: Schema.Literal(1),
  issuerId: Identifier,
  keyId: Identifier,
  sourceHostId: Identifier,
  sourceEnvironmentId: EnvironmentId,
  sessionId: AuthSessionId,
  principal: Identifier,
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  revision: Schema.Struct({
    eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    updatedAt: Schema.Int,
  }),
  capturedAt: Schema.Int,
  expiresAt: Schema.Int,
  fullText: BoundedText,
  fullTextHash: ApprovalReviewHash,
  originalLink: Schema.String.check(Schema.isMaxLength(2_048)),
  // This version only verifies a root run on the independently trusted source host.
  lineage: Schema.Struct({
    rootThreadId: ThreadId,
    rootRunId: RunId,
    delegation: Schema.Literal("none"),
  }),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/u)),
});
export const ApprovalReviewHostSource = Schema.Struct({
  version: Schema.Literal(2),
  orderId: Identifier,
  orderRevision: Schema.Literal(1),
  sourceKind: Schema.Literals(["human", "synthetic"]),
  testOnly: Schema.Boolean,
  sourceEnvironmentId: EnvironmentId,
  sessionId: AuthSessionId,
  principal: Identifier,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: Schema.Int,
  expiresAt: Schema.Int,
  fullText: BoundedText,
  fullTextHash: ApprovalReviewHash,
  originalLink: Schema.String.check(Schema.isMaxLength(2_048)),
});
export type ApprovalReviewHostSource = typeof ApprovalReviewHostSource.Type;

export const ApprovalReviewForwardAck = Schema.Struct({
  instructionHash: ApprovalReviewHash,
  orderId: Identifier,
  orderRevision: Schema.Literal(1),
  commandId: Schema.String.check(Schema.isMaxLength(1_024)),
  fullTextHash: ApprovalReviewHash,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  runOrdinal: Schema.Int.check(Schema.isGreaterThan(0)),
  acceptedSequence: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ApprovalReviewForwardAck = typeof ApprovalReviewForwardAck.Type;

export const ApprovalReviewOriginalReceipt = Schema.Union([
  LegacyOriginalReceipt,
  Schema.Struct({
    ...ApprovalReviewHostSource.fields,
    forwardRevision: Schema.Literal(1),
    assignment: ApprovalReviewForwardAck,
  }),
]);
export type ApprovalReviewOriginalReceipt = typeof ApprovalReviewOriginalReceipt.Type;

export const ApprovalReviewHostOrder = Schema.Struct({
  source: ApprovalReviewHostSource,
  vmId: Identifier,
  targetThreadId: ThreadId,
  state: Schema.Literals(["forwarding", "active", "forward-unknown", "cancelled"]),
  assignment: Schema.NullOr(ApprovalReviewForwardAck),
  forwardRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type ApprovalReviewHostOrder = typeof ApprovalReviewHostOrder.Type;

export const ApprovalReviewOrderCreate = Schema.Struct({
  clientRequestId: Identifier,
  sourceThreadId: ThreadId,
  vmId: Identifier,
  text: BoundedText.check(Schema.isMinLength(1)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ApprovalReviewOrderCreate = typeof ApprovalReviewOrderCreate.Type;
export const ApprovalReviewOrderRead = Schema.Struct({ orderId: Identifier });
export type ApprovalReviewOrderRead = typeof ApprovalReviewOrderRead.Type;
export const ApprovalReviewOrderReceive = Schema.Struct({
  testOnly: Schema.Boolean,
  orderId: Identifier,
  orderRevision: Schema.Literal(1),
  text: BoundedText.check(Schema.isMinLength(1)),
  fullTextHash: ApprovalReviewHash,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  targetThreadId: ThreadId,
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  messageId: MessageId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ApprovalReviewOrderReceive = typeof ApprovalReviewOrderReceive.Type;
export const ApprovalReviewReceiverReadinessInput = Schema.Struct({
  targetThreadId: ThreadId,
  testOnly: Schema.Boolean,
});
export type ApprovalReviewReceiverReadinessInput = typeof ApprovalReviewReceiverReadinessInput.Type;
export const ApprovalReviewReceiverReadiness = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Identifier,
  method: Schema.Literal("dpop-access-token"),
  proofKeyThumbprint: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  testOnly: Schema.Boolean,
  ready: Schema.Boolean,
});
export type ApprovalReviewReceiverReadiness = typeof ApprovalReviewReceiverReadiness.Type;

export const ApprovalReviewOrderReadiness = Schema.Struct({
  enabled: Schema.Boolean,
  configured: Schema.optional(Schema.Boolean),
  reason: Schema.Literals([
    "ready",
    "feature-disabled",
    "human-authority-unconfigured",
    "human-authority-required",
    "channel-unconfigured",
    "forward-unavailable",
  ]),
  sourceKind: Schema.optional(Schema.Literals(["human", "synthetic"])),
  testOnly: Schema.optional(Schema.Boolean),
  channels: Schema.Array(
    Schema.Struct({
      hostThreadId: ThreadId,
      vmId: Identifier,
      label: Schema.String,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      ready: Schema.Boolean,
      reason: Schema.Literals(["ready", "forward-unavailable"]),
    }),
  ),
});
export type ApprovalReviewOrderReadiness = typeof ApprovalReviewOrderReadiness.Type;

export const ApprovalReviewOriginalOrder = Schema.Struct({
  receipt: ApprovalReviewOriginalReceipt,
  excerpt: Schema.Struct({
    startUtf16: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    endUtf16: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    text: BoundedText,
  }),
  destination: Schema.Struct({ threadId: ThreadId, runId: RunId }),
});
export type ApprovalReviewOriginalOrder = typeof ApprovalReviewOriginalOrder.Type;

export const ApprovalReviewProvenance = Schema.Union([
  Schema.Struct({ status: Schema.Literal("verified"), reason: Schema.Literal("trusted-original") }),
  Schema.Struct({
    status: Schema.Literal("unverified"),
    reason: Schema.Literals([
      "missing-original",
      "trust-unconfigured",
      "untrusted-issuer",
      "invalid-signature",
      "invalid-original",
      "invalid-excerpt",
      "stale-original",
      "unsupported-lineage",
      "package-mismatch",
      "order-inactive",
      "legacy-original",
    ]),
  }),
]);
export type ApprovalReviewProvenance = typeof ApprovalReviewProvenance.Type;

export const ApprovalReviewProvenanceReadiness = Schema.Struct({
  mode: Schema.Literals(["disabled", "host-channel"]),
  reason: Schema.Literals(["trust-unconfigured", "paired-channel"]),
});

export const ApprovalReviewAction = Schema.Struct({
  kind: Schema.Literal("create_file_once"),
  verifiedTargetId: Identifier,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  content: BoundedText,
  mode: Schema.Literals([384, 420]),
  expectedAbsent: Schema.Literal(true),
  implementationVersion: Identifier,
  implementationHash: ApprovalReviewHash,
});
export type ApprovalReviewAction = typeof ApprovalReviewAction.Type;

export const ApprovalReviewOrderCancelResult = Schema.Struct({
  ...ApprovalReviewHostOrder.fields,
  alreadyClaimedActions: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      packageHash: ApprovalReviewHash,
      claimId: Identifier,
      state: Schema.Literals(["claimed", "completed"]),
      action: ApprovalReviewAction,
    }),
  ),
});
export type ApprovalReviewOrderCancelResult = typeof ApprovalReviewOrderCancelResult.Type;

export const ApprovalReviewReceipt = Schema.Struct({
  outcome: Schema.Literals(["reported_succeeded", "reported_failed", "unknown"]),
  contentHash: Schema.optional(ApprovalReviewHash),
  errorCode: Schema.optional(Identifier),
  readback: Schema.optional(
    Schema.Struct({
      path: Schema.String.check(Schema.isMaxLength(1_024)),
      contentHash: ApprovalReviewHash,
      mode: Schema.Int,
      uid: Schema.optional(Schema.Int),
      gid: Schema.optional(Schema.Int),
      targetIdentity: Identifier,
    }),
  ),
});
export type ApprovalReviewReceipt = typeof ApprovalReviewReceipt.Type;

export const ApprovalReviewAuthority = Schema.Struct({
  packageHash: ApprovalReviewHash,
  verifiedTargetId: Identifier,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(["pending", "approved", "rejected", "claimed", "completed"]),
  approverSessionId: AuthSessionId,
  approverSubject: Identifier,
  requesterSubject: Identifier,
  workerSubject: Identifier,
  action: ApprovalReviewAction,
  implementationSource: BoundedText,
  originalOrder: Schema.optional(ApprovalReviewOriginalOrder),
  agentRationale: Schema.optional(BoundedText),
  provenance: Schema.optional(ApprovalReviewProvenance),
  claimId: Schema.optional(Identifier),
  receipt: Schema.optional(ApprovalReviewReceipt),
});
export type ApprovalReviewAuthority = typeof ApprovalReviewAuthority.Type;

export const ApprovalReviewSubmit = Schema.Struct({
  orderId: Identifier,
  submissionId: Identifier,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  action: ApprovalReviewAction,
  excerpt: ApprovalReviewOriginalOrder.fields.excerpt,
  agentRationale: Schema.optional(BoundedText),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ApprovalReviewSubmit = typeof ApprovalReviewSubmit.Type;

export const ApprovalReviewAgentPropose = Schema.Struct({
  submissionId: Identifier,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  action: ApprovalReviewAction,
  excerpt: ApprovalReviewOriginalOrder.fields.excerpt,
  agentRationale: Schema.optional(BoundedText),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ApprovalReviewAgentPropose = typeof ApprovalReviewAgentPropose.Type;

export const ApprovalReviewRead = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});
export const ApprovalReviewClaim = Schema.Struct({
  ...ApprovalReviewRead.fields,
  packageHash: ApprovalReviewHash,
  verifiedTargetId: Identifier,
  claimId: Identifier,
});
export type ApprovalReviewClaim = typeof ApprovalReviewClaim.Type;

export const ApprovalReviewReport = Schema.Struct({
  ...ApprovalReviewClaim.fields,
  receipt: ApprovalReviewReceipt,
});
export type ApprovalReviewReport = typeof ApprovalReviewReport.Type;

export const ApprovalReviewResult = Schema.Struct({
  ...ApprovalReviewRead.fields,
  authority: ApprovalReviewAuthority,
});

export const ApprovalReviewReady = Schema.Struct({
  provenance: Schema.optional(ApprovalReviewProvenanceReadiness),
  requests: Schema.Array(
    Schema.Struct({
      ...ApprovalReviewRead.fields,
      packageHash: ApprovalReviewHash,
      verifiedTargetId: Identifier,
    }),
  ).check(Schema.isMaxLength(10)),
});
export type ApprovalReviewReady = typeof ApprovalReviewReady.Type;

export class ApprovalReviewError extends Schema.TaggedError<ApprovalReviewError>()(
  "ApprovalReviewError",
  {
    reason: Schema.Literals([
      "disabled",
      "forbidden",
      "invalid-action",
      "expired",
      "missing",
      "hash-mismatch",
      "target-mismatch",
      "conflict",
      "not-approved",
      "replayed",
      "invalid-receipt",
      "unverified-original",
      "channel-unconfigured",
      "order-inactive",
      "synthetic-order",
      "forward-unknown",
      "storage",
    ]),
  },
) {
  override get message(): string {
    return `Approval review request failed: ${this.reason}.`;
  }
}
