import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { LiveVoiceGeneration, LiveVoiceLeaseId, LiveVoiceStatus } from "./liveVoice.ts";

export const LiveVoiceCallSummary = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  threadId: ThreadId,
  firstEventId: Schema.Number,
  lastEventId: Schema.Number,
  startedAt: Schema.String,
  activeAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  status: LiveVoiceStatus,
});
export type LiveVoiceCallSummary = typeof LiveVoiceCallSummary.Type;

export const LiveVoiceCallHistory = Schema.Struct({
  calls: Schema.Array(LiveVoiceCallSummary),
  nextBefore: Schema.NullOr(Schema.String),
  persistenceAvailable: Schema.Boolean,
});
export type LiveVoiceCallHistory = typeof LiveVoiceCallHistory.Type;

export const LiveVoiceHistoryEntry = Schema.Struct({
  id: Schema.String,
  speaker: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  final: Schema.Boolean,
  // Receipt times of transcript events, never audio onset times.
  occurredAt: Schema.String,
  updatedAt: Schema.String,
});
export type LiveVoiceHistoryEntry = typeof LiveVoiceHistoryEntry.Type;

export const LiveVoiceCallTranscript = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  threadId: ThreadId,
  entries: Schema.Array(LiveVoiceHistoryEntry),
  incomplete: Schema.Boolean,
});
export type LiveVoiceCallTranscript = typeof LiveVoiceCallTranscript.Type;
