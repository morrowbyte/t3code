import { expect, it } from "@effect/vitest";
import {
  ApprovalReviewError,
  EnvironmentId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PrivilegedCommandService from "../../../orchestration-v2/PrivilegedCommandService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { PrivilegedCommandToolkit } from "./tools.ts";

it.effect(
  "derives the proposal identity from the live invocation and offers no approval tool",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const identity = {
        environmentId: EnvironmentId.make("caller-host"),
        threadId: ThreadId.make("caller-thread"),
        providerSessionId: "caller-session",
      };
      const input = {
        purpose: "Inspect temporary artifacts",
        script: "printf 'reviewed bytes\\n'\n",
        shell: "sh" as const,
        cwd: "/tmp",
        timeoutMs: 1000,
      };
      const requestId = RuntimeRequestId.make("privileged-command:test");
      const dependencies = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: identity.environmentId,
          thread: {
            threadId: identity.threadId,
            providerSessionId: identity.providerSessionId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"] as const),
          requestNamespace: "caller-session",
          issuedAt: 0,
        }),
        Layer.mock(PrivilegedCommandService.PrivilegedCommandService)({
          request: (value) => {
            calls.push(value);
            return Effect.fail(new ApprovalReviewError({ reason: "disabled" }));
          },
          wait: (value) => {
            calls.push(value);
            return Effect.fail(new ApprovalReviewError({ reason: "disabled" }));
          },
        }),
      );
      const toolkit = yield* PrivilegedCommandToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const spoofed = {
        ...input,
        environmentId: "other-host",
        threadId: "other-thread",
        providerSessionId: "other-session",
      };
      yield* toolkit
        .handle("privileged_command_request", spoofed)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      yield* toolkit
        .handle("privileged_command_wait", { requestId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(calls).toEqual([
        { ...input, ...identity },
        { requestId, ...identity },
      ]);
      expect(Object.keys(PrivilegedCommandToolkit.tools)).toEqual([
        "privileged_command_request",
        "privileged_command_wait",
      ]);
    }),
);
