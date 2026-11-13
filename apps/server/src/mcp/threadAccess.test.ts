import { expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { dispatchFailure, readThread } from "./threadAccess.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
it("explains a known handoff budget rejection without exposing arbitrary causes", () => {
  const error = new ContextHandoffBudgetError();
  const rejected = (cause: unknown) =>
    new OrchestratorDispatchError({
      commandId: CommandId.make("handoff-budget"),
      commandType: "message.dispatch",
      cause,
    });
  expect(dispatchFailure(rejected(error)).message).toBe(error.message);
  expect(dispatchFailure(rejected(new Error("private diagnostic"))).message).toBe(
    "The operation could not be completed.",
  );
});
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);
