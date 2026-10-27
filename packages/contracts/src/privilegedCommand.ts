import * as Schema from "effect/Schema";
import { EnvironmentId, RunId, ThreadId } from "./baseSchemas.ts";
import { ApprovalReviewHash } from "./approvalReviewAuthority.ts";

/** A single immutable request. The server supplies the target and run identity. */
export const PrivilegedCommandBundle = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: RunId,
  providerSessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  script: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  shell: Schema.Literals(["powershell", "sh"]),
  cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
});
export type PrivilegedCommandBundle = typeof PrivilegedCommandBundle.Type;

export const PrivilegedCommandResult = Schema.Struct({
  status: Schema.Literals(["succeeded", "failed", "cancelled", "unknown"]),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
});
export type PrivilegedCommandResult = typeof PrivilegedCommandResult.Type;

export const PrivilegedCommandRecoveryIdentity = Schema.Struct({
  platform: Schema.Literals(["linux", "win32"]),
  bootId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  processId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  processStart: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  ),
});
export type PrivilegedCommandRecoveryIdentity = typeof PrivilegedCommandRecoveryIdentity.Type;

/** New claims must record the full process identity; old saved claims remain readable. */
export const PrivilegedCommandClaimRecoveryIdentity = Schema.Struct({
  platform: Schema.Literals(["linux", "win32"]),
  bootId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  processStart: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
});

export const PrivilegedCommandAuthority = Schema.Struct({
  bundle: PrivilegedCommandBundle,
  packageHash: ApprovalReviewHash,
  claimId: Schema.optional(Schema.String),
  recoveryIdentity: Schema.optional(PrivilegedCommandRecoveryIdentity),
  state: Schema.Literals(["pending", "approved", "rejected", "claimed", "completed", "unknown"]),
  result: Schema.optional(PrivilegedCommandResult),
});
export type PrivilegedCommandAuthority = typeof PrivilegedCommandAuthority.Type;
