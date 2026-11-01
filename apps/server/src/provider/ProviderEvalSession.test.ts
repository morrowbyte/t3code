import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderEvalSession from "./ProviderEvalSession.ts";

const owner: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("eval-environment"),
  requestNamespace: "eval-request",
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make("eval-thread"),
    providerSessionId: "eval-provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};

const start: ProviderEvalSession.ProviderEvalRequest = {
  action: "start",
  clientRequestId: "request-1",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  instructions: "Use the supplied tool.",
  input: "Read the fixture.",
  tools: [{ name: "read_fixture", description: "Read a fixture", inputSchema: { type: "object" } }],
};

type Evaluate = NonNullable<ProviderAdapter.ProviderAdapterV2["Service"]["evaluate"]>;

const layer = (
  evaluate?: Evaluate,
  threadAccess: Partial<
    Pick<
      ThreadManagement.ThreadManagementServiceShape,
      "getThreadShell" | "isProviderInstanceEnabledForProject"
    >
  > = {},
) =>
  ProviderEvalSession.layer.pipe(
    Layer.provide(
      ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.die("unused"),
          planSelectionTransition: () => Effect.die("unused"),
          openSession: () => Effect.die("unused"),
          ...(evaluate === undefined ? {} : { evaluate }),
        },
      ]),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        ...threadAccess,
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );

const call = { callId: "call-1", name: "read_fixture", arguments: { path: "fixture.txt" } };
const reply = {
  contentItems: [{ type: "inputText" as const, text: "fixture content" }],
  success: true,
};

describe("ProviderEvalSession", () => {
  it.effect("rejects new evaluations disabled in the caller's project", () => {
    const allowedThreadId = ThreadId.make("allowed-thread");
    const allowedProjectId = ProjectId.make("allowed-project");
    const disabledProjectId = ProjectId.make("disabled-project");
    let starts = 0;
    const evaluate: Evaluate = () =>
      Effect.sync(() => {
        starts++;
        return { text: "done" };
      });
    return Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      const denied = yield* service.run(start).pipe(Effect.flip);
      expect(denied.code).toBe("unavailable");
      expect(starts).toBe(0);
      const allowed = yield* service.run(start).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...owner,
          thread: { ...owner.thread!, threadId: allowedThreadId },
        }),
      );
      expect(allowed).toMatchObject({ type: "complete", text: "done" });
      expect(starts).toBe(1);
    }).pipe(
      Effect.provide(
        layer(evaluate, {
          getThreadShell: (threadId) =>
            Effect.succeed({
              ...liveThreadShell(threadId),
              projectId: threadId === allowedThreadId ? allowedProjectId : disabledProjectId,
            }),
          isProviderInstanceEnabledForProject: ({ projectId, instanceId }) =>
            Effect.succeed(
              projectId === allowedProjectId && instanceId === start.modelSelection.instanceId,
            ),
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  });

  it.effect("keeps receipts, replies and cancellation usable after a provider is disabled", () => {
    let enabled = true;
    let starts = 0;
    const evaluate: Evaluate = (input) =>
      Effect.gen(function* () {
        starts++;
        if (starts === 1) yield* input.onToolCall(call);
        return { text: "done" };
      });
    return Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      const event = yield* service.run(start);
      enabled = false;
      expect(yield* service.run(start)).toEqual(event);
      expect(
        yield* service.run({
          action: "respond",
          evaluationId: event.evaluationId,
          callId: call.callId,
          ...reply,
        }),
      ).toMatchObject({ type: "complete", text: "done" });
      const denied = yield* service
        .run({ ...start, clientRequestId: "new-request" })
        .pipe(Effect.flip);
      expect(denied.code).toBe("unavailable");
      expect(yield* service.run({ action: "cancel", evaluationId: event.evaluationId })).toEqual({
        type: "cancelled",
        evaluationId: event.evaluationId,
      });
    }).pipe(
      Effect.provide(
        layer(evaluate, {
          isProviderInstanceEnabledForProject: () => Effect.sync(() => enabled),
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  });

  it.effect("waits for the exact tool call reply and returns final text", () => {
    return Effect.gen(function* () {
      const replies =
        yield* Queue.unbounded<
          Effect.Success<ReturnType<ProviderAdapter.ProviderAdapterV2EvaluationInput["onToolCall"]>>
        >();
      const evaluate: Evaluate = (input) =>
        Effect.gen(function* () {
          const result = yield* input.onToolCall({ ...call, visibleText: "Reading the fixture." });
          yield* Queue.offer(replies, result);
          return {
            text: "Read fixture content.",
            visibleText: "Reading the fixture.\n\nRead fixture content.",
          };
        });
      return yield* Effect.gen(function* () {
        const service = yield* ProviderEvalSession.ProviderEvalSession;
        const event = yield* service.run(start);
        expect(event).toMatchObject({
          type: "tool_call",
          ...call,
          visibleText: "Reading the fixture.",
        });
        expect(yield* Queue.size(replies)).toBe(0);
        const mismatch = yield* service
          .run({
            action: "respond",
            evaluationId: event.evaluationId,
            callId: "wrong-call",
            ...reply,
          })
          .pipe(Effect.flip);
        expect(mismatch.code).toBe("call_mismatch");
        const complete = yield* service.run({
          action: "respond",
          evaluationId: event.evaluationId,
          callId: call.callId,
          ...reply,
        });
        expect(complete).toEqual({
          type: "complete",
          evaluationId: event.evaluationId,
          text: "Read fixture content.",
          visibleText: "Reading the fixture.\n\nRead fixture content.",
        });
        expect(yield* Queue.take(replies)).toEqual(reply);
      }).pipe(Effect.provide(layer(evaluate)));
    }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, owner));
  });

  it.effect("deduplicates concurrent starts by owner and clientRequestId", () => {
    let starts = 0;
    const evaluate: Evaluate = (input) =>
      Effect.gen(function* () {
        starts++;
        yield* input.onToolCall(call);
        return { text: "done" };
      });
    return Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      const events = yield* Effect.all([service.run(start), service.run(start)], {
        concurrency: "unbounded",
      });
      expect(events[0]).toEqual(events[1]);
      expect(starts).toBe(1);
      yield* service.run({ action: "cancel", evaluationId: events[0]!.evaluationId });
    }).pipe(
      Effect.provide(layer(evaluate)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  });

  it.effect(
    "bridges concurrent tool calls one event at a time without losing their namespace",
    () => {
      const calls = [call, { ...call, callId: "call-2", namespace: "fixture" }];
      const evaluate: Evaluate = (input) =>
        Effect.forEach(calls, (entry) => input.onToolCall(entry), {
          concurrency: "unbounded",
        }).pipe(Effect.as({ text: "both replied" }));
      return Effect.gen(function* () {
        const service = yield* ProviderEvalSession.ProviderEvalSession;
        const first = yield* service.run(start);
        if (first.type !== "tool_call") return yield* Effect.die("Expected first tool call");
        const second = yield* service.run({
          action: "respond",
          evaluationId: first.evaluationId,
          callId: first.callId,
          ...reply,
        });
        if (second.type !== "tool_call") return yield* Effect.die("Expected second tool call");
        expect(new Set([first.callId, second.callId])).toEqual(new Set(["call-1", "call-2"]));
        expect(first.callId === "call-2" ? first.namespace : second.namespace).toBe("fixture");
        expect(
          yield* service.run({
            action: "respond",
            evaluationId: second.evaluationId,
            callId: second.callId,
            ...reply,
          }),
        ).toMatchObject({ type: "complete", text: "both replied" });
      }).pipe(
        Effect.provide(layer(evaluate)),
        Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
      );
    },
  );

  it.effect("denies another owner access to replies, cancellation and start receipts", () => {
    const evaluate: Evaluate = (input) => input.onToolCall(call).pipe(Effect.as({ text: "done" }));
    return Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      const original = yield* service.run(start);
      const strangers: ReadonlyArray<McpInvocationContext.McpInvocationScope> = [
        { ...owner, environmentId: EnvironmentId.make("another-environment") },
        { ...owner, thread: { ...owner.thread!, threadId: ThreadId.make("another-thread") } },
        { ...owner, thread: { ...owner.thread!, providerSessionId: "another-session" } },
      ];
      for (const stranger of strangers) {
        for (const request of [
          { action: "respond", evaluationId: original.evaluationId, callId: call.callId, ...reply },
          { action: "cancel", evaluationId: original.evaluationId },
        ] as const) {
          const error = yield* service
            .run(request)
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, stranger),
              Effect.flip,
            );
          expect(error.code).toBe("unavailable");
        }
        const separate = yield* service
          .run(start)
          .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, stranger));
        expect(separate.evaluationId).not.toBe(original.evaluationId);
      }
      expect(
        yield* service.run({
          action: "respond",
          evaluationId: original.evaluationId,
          callId: call.callId,
          ...reply,
        }),
      ).toMatchObject({ type: "complete", text: "done" });
    }).pipe(
      Effect.provide(layer(evaluate)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  });

  it.effect("cancel waits for native cleanup and releases a waiting response", () => {
    return Effect.gen(function* () {
      const resumed = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const allowCleanup = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const cancelReturned = yield* Deferred.make<void>();
      const evaluate: Evaluate = (input) =>
        Effect.gen(function* () {
          yield* input.onToolCall(call);
          yield* Deferred.succeed(resumed, undefined);
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowCleanup)),
              Effect.andThen(Deferred.succeed(cleaned, undefined)),
            ),
          ),
        );
      return yield* Effect.gen(function* () {
        const service = yield* ProviderEvalSession.ProviderEvalSession;
        const event = yield* service.run(start);
        const response = yield* service
          .run({
            action: "respond",
            evaluationId: event.evaluationId,
            callId: call.callId,
            ...reply,
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(resumed);
        const cancel = yield* service
          .run({
            action: "cancel",
            evaluationId: event.evaluationId,
          })
          .pipe(
            Effect.tap(() => Deferred.succeed(cancelReturned, undefined)),
            Effect.forkChild,
          );
        yield* Deferred.await(cleanupStarted);
        expect(yield* Deferred.isDone(cleaned)).toBe(false);
        expect(yield* Deferred.isDone(cancelReturned)).toBe(false);
        yield* Deferred.succeed(allowCleanup, undefined);
        expect(yield* Fiber.join(cancel)).toEqual({
          type: "cancelled",
          evaluationId: event.evaluationId,
        });
        expect(yield* Deferred.isDone(cleaned)).toBe(true);
        expect((yield* Fiber.join(response)).code).toBe("cancelled");
      }).pipe(Effect.provide(layer(evaluate)));
    }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, owner));
  });

  it.effect("expires an abandoned evaluation and releases its native scope", () => {
    return Effect.gen(function* () {
      const cleaned = yield* Deferred.make<void>();
      const evaluate: Evaluate = (input) =>
        input
          .onToolCall(call)
          .pipe(Effect.as({ text: "done" }), Effect.ensuring(Deferred.succeed(cleaned, undefined)));
      return yield* Effect.gen(function* () {
        const service = yield* ProviderEvalSession.ProviderEvalSession;
        const event = yield* service.run(start);
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(cleaned);
        const error = yield* service
          .run({
            action: "respond",
            evaluationId: event.evaluationId,
            callId: call.callId,
            ...reply,
          })
          .pipe(Effect.flip);
        expect(error.code).toBe("unavailable");
      }).pipe(Effect.provide(layer(evaluate)));
    }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, owner));
  });

  it.effect("closes the native session when its caller is interrupted before the next event", () =>
    Effect.gen(function* () {
      for (const phase of ["start", "respond"] as const) {
        const entered = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        const evaluate: Evaluate = (input) =>
          Effect.gen(function* () {
            if (phase === "respond") yield* input.onToolCall(call);
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined)));
        yield* Effect.gen(function* () {
          const service = yield* ProviderEvalSession.ProviderEvalSession;
          const event = phase === "respond" ? yield* service.run(start) : undefined;
          const request =
            event === undefined
              ? start
              : {
                  action: "respond" as const,
                  evaluationId: event.evaluationId,
                  callId: call.callId,
                  ...reply,
                };
          const waiting = yield* service.run(request).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(waiting);
          expect(yield* Deferred.isDone(cleaned)).toBe(true);
        }).pipe(Effect.provide(layer(evaluate)));
      }
    }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, owner)),
  );

  it.effect("reports unsupported adapters without starting a native session", () =>
    Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      const error = yield* service.run(start).pipe(Effect.flip);
      expect(error.code).toBe("unsupported");
    }).pipe(
      Effect.provide(layer()),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    ),
  );

  it.effect("requires a trusted thread and the orchestration capability", () =>
    Effect.gen(function* () {
      const service = yield* ProviderEvalSession.ProviderEvalSession;
      for (const scope of [
        { ...owner, thread: undefined },
        { ...owner, capabilities: new Set<McpInvocationContext.McpCapability>() },
      ]) {
        const error = yield* service
          .run(start)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.flip,
          );
        expect(error.code).toBe("unavailable");
      }
    }).pipe(Effect.provide(layer())),
  );
});
