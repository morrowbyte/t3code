import {
  ApprovalReviewAgentPropose,
  ApprovalReviewHostOrder,
  ApprovalReviewResult,
  ApprovalReviewError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Agent from "./ApprovalReviewOrderAgent.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  Agent.ApprovalReviewOrderAgent,
];
const failure = Schema.Union([ApprovalReviewError, OrchestratorMcpFailure]);
export const toolkit = Toolkit.make(
  Tool.make("approval_review_order", {
    description:
      "Read the Host order assigned to this authenticated VM thread's active run. No caller-supplied order or origin IDs. The host registry supplies the original and request channel; this does not prove safety of a proposal.",
    parameters: Tool.EmptyParams,
    success: ApprovalReviewHostOrder,
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("approval_review_propose", {
    description:
      "Submit a separate frozen proposal for the Host order assigned to this authenticated VM thread's active run. Use a distinct submissionId for each separate package; retry that ID only for identical inputs. Supply an exact UTF-16 excerpt and separate agentRationale. Host supplies all origin, VM, thread and run fields. Submission neither approves nor executes anything.",
    parameters: ApprovalReviewAgentPropose,
    success: ApprovalReviewResult,
    failure,
    failureMode: "return",
    dependencies,
  }),
);
export const handlers = McpToolAccess.toLayer(toolkit, {
  approval_review_order: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const agent = yield* Agent.ApprovalReviewOrderAgent;
      return yield* agent.current(yield* McpInvocationContext.McpInvocationContext);
    }),
  ),
  approval_review_propose: McpToolAccess.actsAsCaller((input: ApprovalReviewAgentPropose) =>
    Effect.gen(function* () {
      const agent = yield* Agent.ApprovalReviewOrderAgent;
      return yield* agent.propose(yield* McpInvocationContext.McpInvocationContext, input);
    }),
  ),
});
