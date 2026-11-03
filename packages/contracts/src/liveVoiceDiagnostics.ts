import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { LiveVoiceGeneration, LiveVoiceLeaseId } from "./liveVoice.ts";

export const LiveVoiceDiagnosticRecord = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(80)),
  details: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  sourceClock: Schema.optionalKey(Schema.Literals(["server-receipt", "client-monotonic"])),
  sourceTimestamp: Schema.optionalKey(Schema.Number),
});
export type LiveVoiceDiagnosticRecord = typeof LiveVoiceDiagnosticRecord.Type;
export const LiveVoiceDiagnosticEvent = Schema.Struct({
  sequence: Schema.Number,
  recordedAt: Schema.String,
  sourceClock: Schema.Literals(["server-receipt", "client-monotonic"]),
  sourceTimestamp: Schema.NullOr(Schema.Number),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  name: Schema.String,
  details: LiveVoiceDiagnosticRecord.fields.details,
});
export type LiveVoiceDiagnosticEvent = typeof LiveVoiceDiagnosticEvent.Type;
export const LiveVoiceDiagnostics = Schema.Struct({
  enabled: Schema.Boolean,
  retentionHours: Schema.Number,
  capacity: Schema.Number,
  events: Schema.Array(LiveVoiceDiagnosticEvent),
  nextAfter: Schema.NullOr(Schema.Number),
  truncated: Schema.Boolean,
  persistenceAvailable: Schema.Boolean,
  capabilities: Schema.Struct({
    nativeVad: Schema.Boolean,
    actualPlayout: Schema.Boolean,
    nativeCancel: Schema.Boolean,
    modelContextConsumption: Schema.Boolean,
  }),
});
export type LiveVoiceDiagnostics = typeof LiveVoiceDiagnostics.Type;
