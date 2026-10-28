import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Text = Schema.String.check(Schema.isMaxLength(8_000));
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const VoiceIntakeSegment = Schema.Struct({
  id: Id,
  revision: Revision,
  text: Text,
  final: Schema.Boolean,
  stopId: Schema.NullOr(Id),
});
export type VoiceIntakeSegment = typeof VoiceIntakeSegment.Type;

export const VoiceIntakeSource = Schema.Struct({
  segmentId: Id,
  stopId: Schema.NullOr(Id),
  revision: Revision,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Revision,
  quote: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type VoiceIntakeSource = typeof VoiceIntakeSource.Type;
const Sources = Schema.Array(VoiceIntakeSource).check(Schema.isMinLength(1), Schema.isMaxLength(8));
export const VoiceIntakeProvenance = Schema.Struct({
  leaseId: Id,
  generation: Revision,
  intentId: Id,
  stopId: Schema.NullOr(Id),
  provisional: Schema.Boolean,
  sources: Sources,
});
export type VoiceIntakeProvenance = typeof VoiceIntakeProvenance.Type;

const PendingSteer = Schema.Struct({
  requestId: Id,
  message: Text,
  readOnly: Schema.Boolean,
  sources: Sources,
  previewContext: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(24_000))),
  ),
});
export const VoiceIntakeIntent = Schema.Struct({
  id: Id,
  request: Text,
  sources: Sources,
  claimedSources: Schema.Array(VoiceIntakeSource).check(Schema.isMaxLength(128)),
  taskId: Id,
  threadId: Id,
  runId: Id,
  provisional: Schema.Boolean,
  startedProvisional: Schema.Boolean,
  pendingSteer: Schema.NullOr(PendingSteer),
  // Keep the existing head for persisted receipts; retain bounded subsequent constraints.
  queuedSteers: Schema.optionalKey(Schema.Array(PendingSteer).check(Schema.isMaxLength(31))),
  status: Schema.String,
  result: Schema.NullOr(Text),
});
export type VoiceIntakeIntent = typeof VoiceIntakeIntent.Type;
const KnownIntent = Schema.Struct({
  id: Id,
  request: Text,
  provisional: Schema.Boolean,
  status: Schema.String,
  result: Schema.NullOr(Text),
  sources: Schema.Array(
    Schema.Struct({
      segmentId: Id,
      revision: Revision,
      start: Schema.Int,
      end: Schema.Int,
      quote: Schema.optionalKey(Text),
    }),
  ).check(Schema.isMaxLength(128)),
});
export const VoiceIntakeSnapshot = Schema.Struct({
  requestId: Id,
  previewContext: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(24_000))),
  ),
  leaseId: Id,
  generation: Revision,
  version: Revision,
  provisionalReadOnlyAvailable: Schema.Boolean,
  defaultProjectId: Id,
  projects: Schema.Array(Schema.Struct({ id: Id, title: TrimmedNonEmptyString })).check(
    Schema.isMaxLength(24),
  ),
  segments: Schema.Array(VoiceIntakeSegment).check(Schema.isMaxLength(24)),
  intents: Schema.Array(KnownIntent).check(Schema.isMaxLength(24)),
});
export type VoiceIntakeSnapshot = typeof VoiceIntakeSnapshot.Type;

const DecisionSources = Schema.Array(
  Schema.Struct({
    segmentId: Id,
    revision: Revision,
    quote: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(8));
export const VoiceIntakeDecision = Schema.Struct({
  requestId: Id,
  actions: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("new"),
        sources: DecisionSources,
        request: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
        readOnly: Schema.Boolean,
        projectId: Schema.NullOr(Id),
      }),
      Schema.Struct({
        type: Schema.Literal("refine"),
        intentId: Id,
        sources: DecisionSources,
        message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
        readOnly: Schema.Boolean,
      }),
      Schema.Struct({ type: Schema.Literal("confirm"), intentId: Id, sources: DecisionSources }),
      Schema.Struct({ type: Schema.Literal("reference"), intentId: Id }),
      Schema.Struct({ type: Schema.Literal("defer"), reason: Text }),
      Schema.Struct({ type: Schema.Literal("opt_out") }),
    ]),
  ).check(Schema.isMaxLength(8)),
});
export type VoiceIntakeDecision = typeof VoiceIntakeDecision.Type;
