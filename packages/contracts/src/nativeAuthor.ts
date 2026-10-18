import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

export const NATIVE_AUTHOR_MAX_FRAME_BYTES = 65_536;

// Preserve strict UTF-16 validation in clients whose TypeScript library target predates ES2024.
const isWellFormed = (value: string): boolean => {
  for (const character of value) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff) return false;
  }
  return true;
};

const SourceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => value.trim() === value && isWellFormed(value)),
);
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(24_000),
  Schema.makeFilter((value) => value.trim().length > 0 && isWellFormed(value)),
);

export const NativeAuthorSource = Schema.Struct({
  engineSessionId: SourceId,
  conversationId: SourceId,
  turnId: SourceId,
});
export type NativeAuthorSource = typeof NativeAuthorSource.Type;
export const NativeAuthorCursor = Schema.Struct({
  sequence: NonNegativeInt,
  textOffset: NonNegativeInt,
});
export type NativeAuthorCursor = typeof NativeAuthorCursor.Type;

const RequestFields = {
  version: Schema.Literal(1),
  type: Schema.Literal("native-author"),
  requestId: SourceId,
  source: NativeAuthorSource,
};
export const NativeAuthorSubmit = Schema.Struct({
  ...RequestFields,
  operation: Schema.Literal("submit"),
  text: Text,
});
export const NativeAuthorRead = Schema.Struct({
  ...RequestFields,
  operation: Schema.Literal("read"),
  after: Schema.optional(NativeAuthorCursor),
});
export const NativeAuthorSteer = Schema.Struct({
  ...RequestFields,
  operation: Schema.Literal("steer"),
  expectedRunId: RunId,
  text: Text,
});
export const NativeAuthorCancel = Schema.Struct({
  ...RequestFields,
  operation: Schema.Literal("cancel"),
  expectedRunId: RunId,
});
export const NativeAuthorOpenResults = Schema.Struct({
  ...RequestFields,
  operation: Schema.Literal("open-results"),
});
export const NativeAuthorRequest = Schema.Union([
  NativeAuthorSubmit,
  NativeAuthorRead,
  NativeAuthorSteer,
  NativeAuthorCancel,
  NativeAuthorOpenResults,
]);
export type NativeAuthorRequest = typeof NativeAuthorRequest.Type;

// A real ordinary root conversation has no delegated-task or parent identity.
export const NativeAuthorRootLocator = Schema.Struct({
  kind: Schema.Literal("native-author-root"),
  source: NativeAuthorSource,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  rootNodeId: Schema.NullOr(NodeId),
});
export type NativeAuthorRootLocator = typeof NativeAuthorRootLocator.Type;

export const NativeAuthorOutput = Schema.Struct({
  sequence: NonNegativeInt,
  itemId: Schema.String,
  kind: Schema.Literals(["assistant-text", "phase"]),
  text: Schema.String.check(
    Schema.isMaxLength(8_192),
    Schema.makeFilter((value) => isWellFormed(value)),
  ),
  textOffset: NonNegativeInt,
  totalTextLength: NonNegativeInt,
  streaming: Schema.Boolean,
});
export type NativeAuthorOutput = typeof NativeAuthorOutput.Type;
export const NativeAuthorState = Schema.Struct({
  locator: NativeAuthorRootLocator,
  status: Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  canonicalStatus: OrchestrationV2RunStatus,
  output: Schema.Array(NativeAuthorOutput).check(Schema.isMaxLength(64)),
  cursor: NativeAuthorCursor,
  hasMore: Schema.Boolean,
  gap: Schema.NullOr(
    Schema.Literals(["cursor-ahead", "history-unavailable", "invalid-text-offset"]),
  ),
});
export type NativeAuthorState = typeof NativeAuthorState.Type;
export class NativeAuthorError extends Schema.TaggedError<NativeAuthorError>()(
  "NativeAuthorError",
  {
    code: Schema.Literals([
      "invalid-request",
      "not-submitted",
      "receipt-conflict",
      "stale-run",
      "model-unavailable",
      "backend-unavailable",
      "outcome-unknown",
      "result-window-unavailable",
      "response-too-large",
    ]),
  },
) {
  override get message(): string {
    return `Native author: ${this.code}.`;
  }
}
export const NativeAuthorResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    requestId: Schema.String,
    ok: Schema.Literal(true),
    state: NativeAuthorState,
    windowId: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    requestId: Schema.String,
    ok: Schema.Literal(false),
    code: NativeAuthorError.fields.code,
  }),
]);
export type NativeAuthorResponse = typeof NativeAuthorResponse.Type;
