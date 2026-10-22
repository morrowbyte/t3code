import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentAvatarKey = Schema.Struct({
  threadId: ThreadId,
  theme: Schema.Literals(["neutral", "weasel"]),
});
export type AgentAvatarKey = typeof AgentAvatarKey.Type;

export const AgentAvatarGenerateInput = Schema.Struct({
  ...AgentAvatarKey.fields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  regenerate: Schema.optional(Schema.Boolean),
});
export type AgentAvatarGenerateInput = typeof AgentAvatarGenerateInput.Type;

export const AgentAvatarState = Schema.Struct({
  ...AgentAvatarKey.fields,
  status: Schema.Literals(["missing", "generating", "ready", "failed", "cancelled"]),
  attachmentId: Schema.NullOr(Schema.String),
  mimeType: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type AgentAvatarState = typeof AgentAvatarState.Type;

export class AgentAvatarError extends Schema.TaggedError<AgentAvatarError>()("AgentAvatarError", {
  message: Schema.String,
}) {}
