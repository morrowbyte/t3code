import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
} from "./orchestratorMcp.ts";

/** The source server constructs this from its authenticated, live MCP caller. */
export const ConnectedEnvironmentCaller = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type ConnectedEnvironmentCaller = typeof ConnectedEnvironmentCaller.Type;

export const ConnectedEnvironmentRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("projects"),
    input: Schema.Struct({ cursor: Schema.optional(NonNegativeInt) }),
  }),
  Schema.Struct({ type: Schema.Literal("list"), input: OrchestratorMcpThreadListInput }),
  Schema.Struct({ type: Schema.Literal("read"), input: OrchestratorMcpThreadReadInput }),
  Schema.Struct({
    type: Schema.Literal("send"),
    input: Schema.Struct({
      threadId: ThreadId,
      message: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
      mode: Schema.Literals(["auto", "queue", "steer"]),
      clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
  }),
]);
export type ConnectedEnvironmentRequest = typeof ConnectedEnvironmentRequest.Type;

export const ConnectedEnvironmentResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("projects"),
    result: Schema.Struct({
      projects: Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })),
      nextCursor: Schema.NullOr(NonNegativeInt),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("list"), result: OrchestratorMcpThreadListResult }),
  Schema.Struct({ type: Schema.Literal("read"), result: OrchestratorMcpThreadReadResult }),
  Schema.Struct({ type: Schema.Literal("send"), result: OrchestratorMcpThreadSendResult }),
]);
export type ConnectedEnvironmentResult = typeof ConnectedEnvironmentResult.Type;

export const ConnectedEnvironmentRelayRequest = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  caller: ConnectedEnvironmentCaller,
  request: ConnectedEnvironmentRequest,
  admissionId: Schema.optional(Schema.String),
});
export type ConnectedEnvironmentRelayRequest = typeof ConnectedEnvironmentRelayRequest.Type;

export const ConnectedEnvironmentReadRelayRequest = Schema.Struct({
  ...ConnectedEnvironmentRelayRequest.fields,
  request: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("projects"),
      input: Schema.Struct({ cursor: Schema.optional(NonNegativeInt) }),
    }),
    Schema.Struct({ type: Schema.Literal("list"), input: OrchestratorMcpThreadListInput }),
    Schema.Struct({ type: Schema.Literal("read"), input: OrchestratorMcpThreadReadInput }),
  ]),
});
export const ConnectedEnvironmentSendRelayRequest = Schema.Struct({
  ...ConnectedEnvironmentRelayRequest.fields,
  admissionId: Schema.String,
  request: Schema.Struct({
    type: Schema.Literal("send"),
    input: Schema.Struct({
      threadId: ThreadId,
      message: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
      mode: Schema.Literals(["auto", "queue", "steer"]),
      clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
  }),
});

export const ConnectedEnvironmentBridgeRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("environments") }),
  Schema.Struct({ type: Schema.Literal("prepare"), targetEnvironmentId: EnvironmentId }),
  Schema.Struct({ type: Schema.Literal("relay"), envelope: ConnectedEnvironmentRelayRequest }),
]);
export type ConnectedEnvironmentBridgeRequest = typeof ConnectedEnvironmentBridgeRequest.Type;

export const ConnectedEnvironmentBridgeResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("prepare"), admissionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("environments"),
    environments: Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("relay"), result: ConnectedEnvironmentResult }),
]);
export type ConnectedEnvironmentBridgeResult = typeof ConnectedEnvironmentBridgeResult.Type;

export const ConnectedEnvironmentBridgeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: Schema.String,
    requestId: Schema.String,
    request: ConnectedEnvironmentBridgeRequest,
  }),
]);
export type ConnectedEnvironmentBridgeEvent = typeof ConnectedEnvironmentBridgeEvent.Type;

export const ConnectedEnvironmentBridgeResponse = Schema.Struct({
  connectionId: Schema.String,
  requestId: Schema.String,
  result: Schema.optional(ConnectedEnvironmentBridgeResult),
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
});
export type ConnectedEnvironmentBridgeResponse = typeof ConnectedEnvironmentBridgeResponse.Type;
