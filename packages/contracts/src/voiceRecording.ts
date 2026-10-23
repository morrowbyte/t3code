import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { LiveVoiceGeneration, LiveVoiceLeaseId } from "./liveVoice.ts";

export const VOICE_RECORDING_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const VOICE_RECORDING_CHUNK_BYTES = 256 * 1024;
export const VoiceRecordingRole = Schema.Literals(["user", "assistant"]);
export const VoiceRecordingMime = Schema.Literals([
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
]);
const Counter = Schema.Number.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n >= 0));
export const VoiceRecordingId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const VoiceRecordingStart = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  mimeType: VoiceRecordingMime,
});
export const VoiceRecordingChunk = Schema.Struct({
  id: VoiceRecordingId,
  role: VoiceRecordingRole,
  sequence: Counter,
  offsetMs: Counter,
  trackStartedOffsetMs: Counter,
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(VOICE_RECORDING_CHUNK_BYTES / 3) * 4)),
});
export const VoiceRecordingEntry = Schema.Struct({
  ...VoiceRecordingStart.fields,
  id: VoiceRecordingId,
  startedAt: Counter,
  endedAt: Schema.NullOr(Counter),
  bytes: Counter,
});
export const VoiceRecordingSettings = Schema.Struct({
  enabled: Schema.Boolean,
  hostLabel: Schema.String,
  retentionDays: Schema.Number,
  directory: Schema.String,
});
export class VoiceRecordingError extends Schema.TaggedError<VoiceRecordingError>()(
  "VoiceRecordingError",
  {
    reason: Schema.Literals(["disabled", "session_mismatch", "invalid_chunk", "limit", "storage"]),
  },
) {
  override get message() {
    return "Call recording stopped. Check Voice settings and host storage.";
  }
}
