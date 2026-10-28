import {
  ApprovalReviewError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PrivilegedCommandAuthority,
  PrivilegedCommandBundle,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PrivilegedCommandService from "../../../orchestration-v2/PrivilegedCommandService.ts";
import { PrivilegedCommandExecutionError } from "../../../privilegedCommands/PrivilegedCommandExecutor.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  PrivilegedCommandService.PrivilegedCommandService,
];
const failure = Schema.Union([
  ApprovalReviewError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  PrivilegedCommandExecutionError,
]);
const fields = PrivilegedCommandBundle.fields;

export const PrivilegedCommandToolkit = Toolkit.make(
  Tool.make("privileged_command_request", {
    description:
      "Request one human-reviewed privileged script on this thread's own host. Supply readable native shell source with a clear purpose and finite timeout. T3 binds host/thread/run to your authenticated caller, shows the exact script for a clicked in-app decision, and executes it once only after approval (with native UAC on Windows). This call waits for rejection or the execution result; keep it running. No session-wide grants. Do not use this to bypass a provider policy denial. An unknown result must be reconciled, never automatically resubmitted.",
    parameters: Schema.Struct({
      purpose: fields.purpose,
      script: fields.script,
      shell: fields.shell,
      cwd: fields.cwd,
      timeoutMs: fields.timeoutMs,
    }),
    success: Schema.Struct({
      requestId: RuntimeRequestId,
      packageHash: PrivilegedCommandAuthority.fields.packageHash,
      authority: PrivilegedCommandAuthority,
    }),
    failure,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("privileged_command_wait", {
    description:
      "Wait for an existing privileged command from this same authenticated thread, provider session and active run. Reuse the returned requestId; this neither approves nor submits nor reruns a script.",
    parameters: Schema.Struct({ requestId: RuntimeRequestId }),
    success: PrivilegedCommandAuthority,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
);
