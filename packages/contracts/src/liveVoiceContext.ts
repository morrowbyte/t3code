import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { LiveVoiceGeneration, LiveVoiceLeaseId } from "./liveVoice.ts";

/** Replaces selected context for one call without creating a spoken turn. */
export const LiveVoiceContextInput = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  revision: LiveVoiceGeneration,
  context: Schema.NullOr(Schema.String.check(Schema.isMaxLength(24_000))),
});
export type LiveVoiceContextInput = typeof LiveVoiceContextInput.Type;

export const LiveVoiceContextDeliveredInput = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  deliveryId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  accepted: Schema.Boolean,
  client: Schema.optionalKey(
    Schema.Struct({
      sourceTimestamp: Schema.Number,
      frameCount: Schema.Number,
      bytes: Schema.Number,
      clientPhase: Schema.String.check(Schema.isMaxLength(40)),
      playbackEligible: Schema.Boolean,
      playbackMuted: Schema.Boolean,
      dataChannelState: Schema.String.check(Schema.isMaxLength(20)),
    }),
  ),
});
export type LiveVoiceContextDeliveredInput = typeof LiveVoiceContextDeliveredInput.Type;
