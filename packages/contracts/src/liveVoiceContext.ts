import * as Schema from "effect/Schema";
import { LiveVoiceGeneration, LiveVoiceLeaseId } from "./liveVoice.ts";

/** Replaces selected context for one call without creating a spoken turn. */
export const LiveVoiceContextInput = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  revision: LiveVoiceGeneration,
  context: Schema.NullOr(Schema.String.check(Schema.isMaxLength(24_000))),
});
export type LiveVoiceContextInput = typeof LiveVoiceContextInput.Type;
