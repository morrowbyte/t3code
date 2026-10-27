import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as Broker from "./Broker.ts";
import { ConnectedEnvironmentToolkit } from "../toolkits/connectedEnvironment/tools.ts";

const threadId = ThreadId.make("source-thread");
const environmentId = EnvironmentId.make("source");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "fixture-session",
  issuedAt: 1,
  capabilities: new Set(["orchestration"]),
  thread: { threadId, providerInstanceId, providerSessionId: "fixture" },
  client: undefined,
};
const threads = {
  getThreadShell: () =>
    Effect.succeed({
      deletedAt: null,
      archivedAt: null,
      activeRunId: "run",
      providerInstanceId,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    }),
} as unknown as ThreadManagement.ThreadManagementService["Service"];

it("exposes the bounded connected-environment tool names", () => {
  expect(Object.keys(ConnectedEnvironmentToolkit.tools)).toEqual([
    "t3_connected_environments",
    "t3_connected_project_list",
    "t3_connected_thread_list",
    "t3_connected_thread_read",
    "t3_connected_thread_send",
  ]);
});

it.effect("forwards source-derived limits and accepts only the registered relay session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ThreadCommandExecutor.layer,
            Layer.succeed(ThreadManagement.ThreadManagementService, threads),
          ),
        ),
      );
      const stream = yield* broker.connect("app-session");
      let attemptedWrongSession = false;
      yield* Stream.runForEach(stream, (event) => {
        if (event.type !== "request") return Effect.void;
        if (event.request.type === "prepare")
          return broker.respond("app-session", {
            connectionId: event.connectionId,
            requestId: event.requestId,
            result: { type: "prepare", admissionId: "fixture-admission" },
          });
        expect(event.request.type).toBe("relay");
        if (event.request.type === "relay")
          expect(event.request.envelope.caller).toMatchObject({
            environmentId,
            threadId,
            runtimeMode: "approval-required",
            interactionMode: "plan",
          });
        const response = {
          connectionId: event.connectionId,
          requestId: event.requestId,
          result: {
            type: "relay" as const,
            result: {
              type: "send" as const,
              result: {
                threadId: ThreadId.make("remote"),
                messageId: "message" as never,
                runId: "run" as never,
                status: "queued" as const,
                delivery: "queued" as const,
              },
            },
          },
        };
        return broker.respond("wrong-session", response).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.sync(() => {
                attemptedWrongSession = true;
              }),
            onSuccess: () => Effect.die("wrong session accepted"),
          }),
          Effect.andThen(broker.respond("app-session", response)),
        );
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const result = yield* broker
        .invoke(EnvironmentId.make("remote"), {
          type: "send",
          input: {
            threadId: ThreadId.make("remote"),
            message: "fixture",
            mode: "queue",
            clientRequestId: "retry",
          },
        })
        .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));
      expect(attemptedWrongSession).toBe(true);
      expect(result.type).toBe("relay");
    }),
  ),
);
