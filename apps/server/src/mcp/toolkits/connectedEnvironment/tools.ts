import {
  EnvironmentId,
  ProjectId,
  NonNegativeInt,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import { ConnectedEnvironmentSendRelayRequest } from "@t3tools/contracts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Broker from "../../connectedEnvironment/Broker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  Broker.ConnectedEnvironmentBroker,
];
const common = { failure: OrchestratorMcpFailure, failureMode: "return" as const, dependencies };
const environments = Tool.make("t3_connected_environments", {
  ...common,
  description: "List already connected environments available through the authenticated app.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    environments: Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
    ),
  }),
}).annotate(Tool.Readonly, true);
const list = Tool.make("t3_connected_thread_list", {
  ...common,
  description: "List threads in an already connected environment and project.",
  parameters: Schema.Struct({
    ...OrchestratorMcpThreadListInput.fields,
    environmentId: EnvironmentId,
  }),
  success: OrchestratorMcpThreadListResult,
}).annotate(Tool.Readonly, true);
const projects = Tool.make("t3_connected_project_list", {
  ...common,
  description: "List project IDs in an already connected environment, for selecting threads.",
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    cursor: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
}).annotate(Tool.Readonly, true);
const read = Tool.make("t3_connected_thread_read", {
  ...common,
  description: "Read an existing thread in an already connected environment.",
  parameters: Schema.Struct({
    ...OrchestratorMcpThreadReadInput.fields,
    environmentId: EnvironmentId,
  }),
  success: OrchestratorMcpThreadReadResult,
}).annotate(Tool.Readonly, true);
const send = Tool.make("t3_connected_thread_send", {
  ...common,
  description:
    "Send or steer an existing remote thread. Reuse clientRequestId after an uncertain result. Never use a new key to retry an uncertain send.",
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    ...ConnectedEnvironmentSendRelayRequest.fields.request.fields.input.fields,
  }),
  success: OrchestratorMcpThreadSendResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const ConnectedEnvironmentToolkit = Toolkit.make(environments, projects, list, read, send);
