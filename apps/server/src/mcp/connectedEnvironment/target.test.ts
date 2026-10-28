import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorMcp from "../OrchestratorMcpService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { executeConnectedEnvironmentRequest } from "./target.ts";
import type { ConnectedEnvironmentRelayRequest } from "../../../../../packages/contracts/src/connectedEnvironmentMcp.ts";

const source = EnvironmentId.make("source");
const target = EnvironmentId.make("target");
const threadId = ThreadId.make("target-thread");
const request: ConnectedEnvironmentRelayRequest = {
  targetEnvironmentId: target,
  caller: {
    environmentId: source,
    threadId: ThreadId.make("source-thread"),
    runtimeMode: "approval-required",
    interactionMode: "plan",
  },
  request: {
    type: "send",
    input: { threadId, message: "fixture", mode: "queue", clientRequestId: "retry-1" },
  },
};

describe("connected environment target", () => {
  it.effect("rejects an environment mismatch before touching the target", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        executeConnectedEnvironmentRequest(source, request).pipe(
          Effect.provideService(
            OrchestratorMcp.OrchestratorMcpService,
            {} as OrchestratorMcp.OrchestratorMcpService["Service"],
          ),
          Effect.provideService(
            ThreadManagement.ThreadManagementService,
            {} as ThreadManagement.ThreadManagementService["Service"],
          ),
          Effect.provideService(
            ProjectService.ProjectService,
            {} as ProjectService.ProjectService["Service"],
          ),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("does not dispatch a target above the source limit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = {
        sendToThread: () => {
          calls++;
          return Effect.die("unexpected");
        },
      } as unknown as OrchestratorMcp.OrchestratorMcpService["Service"];
      const threads = {
        getThreadShell: () =>
          Effect.succeed({
            deletedAt: null,
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const result = yield* Effect.result(
        executeConnectedEnvironmentRequest(target, request, Number.MAX_SAFE_INTEGER).pipe(
          Effect.provideService(OrchestratorMcp.OrchestratorMcpService, service),
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          Effect.provideService(
            ProjectService.ProjectService,
            {} as ProjectService.ProjectService["Service"],
          ),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it.effect("retains the retry key and applies the source limits at dispatch", () =>
    Effect.gen(function* () {
      let seen: unknown;
      const service = {
        sendToThread: (scope: unknown, input: unknown) =>
          Effect.gen(function* () {
            seen = { scope, input, limit: yield* DispatchModeLimit };
            return {
              threadId,
              messageId: "message-1",
              runId: "run-1",
              status: "queued",
              delivery: "queued",
            };
          }),
      } as unknown as OrchestratorMcp.OrchestratorMcpService["Service"];
      const threads = {
        getThreadShell: () =>
          Effect.succeed({
            deletedAt: null,
            runtimeMode: "approval-required",
            interactionMode: "plan",
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      yield* executeConnectedEnvironmentRequest(target, request, Number.MAX_SAFE_INTEGER).pipe(
        Effect.provideService(OrchestratorMcp.OrchestratorMcpService, service),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
      );
      expect(seen).toMatchObject({
        input: { clientRequestId: "retry-1", mode: "queue" },
        limit: { runtimeMode: "approval-required", interactionMode: "plan" },
        scope: { thread: undefined, requestNamespace: "connected:source:source-thread" },
      });
    }),
  );
});
