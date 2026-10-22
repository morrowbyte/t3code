import * as Schema from "effect/Schema";
import { AuthSessionId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u));
export const ApprovalReviewHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const BoundedText = Schema.String.check(Schema.isMaxLength(65_536));

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
  claimId: Schema.optional(Identifier),
  receipt: Schema.optional(ApprovalReviewReceipt),
});
export type ApprovalReviewAuthority = typeof ApprovalReviewAuthority.Type;

export const ApprovalReviewSubmit = Schema.Struct({
  threadId: ThreadId,
  submissionId: Identifier,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  action: ApprovalReviewAction,
});
export type ApprovalReviewSubmit = typeof ApprovalReviewSubmit.Type;

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
      "storage",
    ]),
  },
) {
  override get message(): string {
    return `Approval review request failed: ${this.reason}.`;
  }
}
