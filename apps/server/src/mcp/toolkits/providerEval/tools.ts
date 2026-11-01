import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ProviderEvalSession from "../../../provider/ProviderEvalSession.ts";
import * as ProviderEvalBoat from "../../../provider/ProviderEvalBoat.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

export const ProviderEvalToolkit = Toolkit.make(
  Tool.make("provider_eval", {
    description:
      "Run an isolated provider evaluation using Crew's existing provider sign-in. Start supplies modelSelection, instructions, input and JSON tools; reuse clientRequestId after an uncertain start. Returns one tool_call or complete text. Respond with its evaluationId and exact callId, contentItems and success, then await the next event. Cancel closes the native session before returning. Sessions belong to this calling thread and provider session, expire after ten minutes, and have no project access. The caller runs tools and supplies their results.",
    parameters: Schema.Struct({ request: ProviderEvalSession.ProviderEvalRequest }),
    success: ProviderEvalSession.ProviderEvalResponse,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ProviderEvalSession.ProviderEvalSession,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  }),
  Tool.make("provider_eval_boat", {
    description:
      "Run selected provider-eval cases on an existing Boat host using Crew's provider sign-in. Supply projectId, hostId, modelSelection, caseIds, samples and a stable requestId. Tool calls run in Boat; model calls stay on the provider host. Credentials are not copied to Boat. Returns local report paths and counts after the runner finishes; token usage remains unknown.",
    parameters: ProviderEvalBoat.ProviderEvalBoatInput,
    success: ProviderEvalBoat.ProviderEvalBoatResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ProviderEvalBoat.ProviderEvalBoat,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  }),
);
