import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(320));
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(160), Schema.isPattern(/^[\w.:-]+$/));
export const FeatureTimingEvidence = Schema.Struct({ threadId: ThreadId, messageId: MessageId });
export type FeatureTimingEvidence = typeof FeatureTimingEvidence.Type;
export const FeatureTimingEstimate = Schema.Struct({
  minimumMs: NonNegativeInt,
  maximumMs: NonNegativeInt,
  confidence: Schema.Literals(["low", "medium", "high"]),
});
export const FeatureTimingFact = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("registered"),
    featureId: Id,
    title: Label,
    intake: Schema.NullOr(FeatureTimingEvidence),
    threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(16)),
    targets: Schema.Array(
      Schema.Struct({ id: Id, label: Label, environmentId: Schema.optional(EnvironmentId) }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    originalEstimate: Schema.NullOr(FeatureTimingEstimate),
  }),
  Schema.Struct({ type: Schema.Literal("thread_linked"), featureId: Id, threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("phase_changed"),
    featureId: Id,
    phase: Schema.Literals(["research", "implementation", "review", "verification"]),
  }),
  Schema.Struct({
    type: Schema.Literal("wait_started"),
    featureId: Id,
    waitId: Id,
    reason: Schema.Literals([
      "build",
      "review",
      "dependency",
      "credential",
      "user",
      "physical",
      "offline",
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("wait_ended"), featureId: Id, waitId: Id }),
  Schema.Struct({
    type: Schema.Literal("target_accepted"),
    featureId: Id,
    targetId: Id,
    version: Id,
    evidence: FeatureTimingEvidence,
  }),
  Schema.Struct({
    type: Schema.Literal("target_reopened"),
    featureId: Id,
    targetId: Id,
    reason: Label,
  }),
]);
export type FeatureTimingFact = typeof FeatureTimingFact.Type;
export const FeatureTimingRecord = Schema.Struct({
  sequence: NonNegativeInt,
  at: IsoDateTime,
  fact: FeatureTimingFact,
  // Populated from the referenced canonical user message, never the recorder's actor label.
  userEvidence: Schema.optional(
    Schema.Struct({ actor: Schema.Literal("user"), at: IsoDateTime, source: Label }),
  ),
});
export type FeatureTimingRecord = typeof FeatureTimingRecord.Type;

const Interval = Schema.Struct({ start: IsoDateTime, end: Schema.NullOr(IsoDateTime) });
export const FeatureTimingObservation = Schema.Struct({
  threadId: ThreadId,
  runs: Schema.Array(
    Schema.Struct({
      id: Label,
      startedAt: Schema.NullOr(IsoDateTime),
      end: Schema.NullOr(IsoDateTime),
      requestedAt: IsoDateTime,
      status: Label,
    }),
  ),
  waits: Schema.Array(Schema.Struct({ id: Label, ...Interval.fields, reason: Label })),
});
export type FeatureTimingObservation = typeof FeatureTimingObservation.Type;
export const ProjectFeatureTimingInput = Schema.Struct({ projectId: ProjectId });
export const ProjectFeatureTimingHistory = Schema.Struct({
  projectId: ProjectId,
  asOf: IsoDateTime,
  // Completeness concerns recorded facts and linked telemetry, not missing history or effort.
  coverage: Schema.Literals(["complete", "no_feature_history", "incomplete", "unavailable"]),
  records: Schema.Array(FeatureTimingRecord),
  observations: Schema.Array(FeatureTimingObservation),
});
export type ProjectFeatureTimingHistory = typeof ProjectFeatureTimingHistory.Type;

const Millis = Schema.NullOr(NonNegativeInt);
export const ProjectFeatureTiming = Schema.Struct({
  projectId: ProjectId,
  asOf: IsoDateTime,
  coverage: ProjectFeatureTimingHistory.fields.coverage,
  features: Schema.Array(
    Schema.Struct({
      featureId: Id,
      title: Label,
      originalEstimate: Schema.NullOr(FeatureTimingEstimate),
      registeredAt: IsoDateTime,
      intakeAt: Millis,
      workStartedAt: Millis,
      elapsedFromIntakeMs: Millis,
      elapsedFromWorkMs: Millis,
      firstAcceptedAt: Millis,
      latestCompletionAt: Millis,
      reopenCount: NonNegativeInt,
      waitMs: NonNegativeInt,
      runCount: NonNegativeInt,
      state: Schema.Literals(["accepted", "reopened", "in_development"]),
      waitReasons: Schema.Array(Schema.Struct({ reason: Label, ms: NonNegativeInt })),
      phases: Schema.Array(Schema.Struct({ phase: Label, ms: NonNegativeInt })),
      targets: Schema.Array(
        Schema.Struct({
          id: Id,
          label: Label,
          environmentId: Schema.optional(EnvironmentId),
          acceptedBy: Schema.NullOr(Schema.Literal("user")),
          acceptedVersion: Schema.NullOr(Id),
          acceptedAt: Millis,
          evidence: Schema.NullOr(FeatureTimingEvidence),
          source: Schema.NullOr(Label),
          reopened: Schema.Boolean,
        }),
      ),
      records: Schema.Array(
        Schema.Struct({
          sequence: NonNegativeInt,
          at: IsoDateTime,
          type: Label,
          reason: Schema.NullOr(Label),
        }),
      ),
    }),
  ),
});
export type ProjectFeatureTiming = typeof ProjectFeatureTiming.Type;
export class FeatureTimingError extends Schema.TaggedError<FeatureTimingError>()(
  "FeatureTimingError",
  {
    reason: Schema.Literals(["invalid_history", "invalid_evidence", "unavailable"]),
  },
) {
  override get message() {
    return `Feature timing is unavailable (${this.reason}).`;
  }
}
