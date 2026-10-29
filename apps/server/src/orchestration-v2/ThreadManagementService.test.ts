import { expect, it } from "@effect/vitest";
import {
  CommandId,
  RunAttemptId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    // A client cannot claim a linked environment's origin, or a parent there.
    linkOrigin: { sessionId: "forged", label: "Somewhere else" },
    delegatedFrom: {
      environmentId: EnvironmentId.make("environment:elsewhere"),
      threadId: ThreadId.make("thread:elsewhere"),
      title: "Somewhere else",
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).not.toHaveProperty("linkOrigin");
  expect(stamped).not.toHaveProperty("delegatedFrom");
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect("replays a successful steer after its target run has completed", () => {
  const projectId = ProjectId.make("project:steer-retry");
  const threadId = ThreadId.make("thread:steer-retry");
  const commandId = CommandId.make("command:steer-retry");
  const messageId = MessageId.make("message:steer-retry");
  const runId = RunId.make("run:steer-retry");
  const attemptId = RunAttemptId.make("attempt:steer-retry");
  const instanceId = ProviderInstanceId.make("codex_work");
  let finished = false;
  const dispatchModes: Array<string> = [];
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () =>
          Effect.sync(
            () =>
              ({
                thread: {
                  id: threadId,
                  projectId,
                  deletedAt: null,
                  archivedAt: null,
                  modelSelection: { instanceId, model: "test" },
                },
                runs: [
                  {
                    id: runId,
                    ordinal: 1,
                    status: finished ? "completed" : "running",
                    activeAttemptId: attemptId,
                  },
                ],
                providerTurns: finished ? [] : [{ runAttemptId: attemptId, status: "running" }],
                messages: [{ id: messageId, runId }],
                turnItems: [{ type: "user_message", messageId, inputIntent: "steer" }],
              }) as unknown as OrchestrationV2ThreadProjection,
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "message.dispatch") dispatchModes.push(command.dispatchMode.type);
            return { sequence: 1, storedEvents: [], replayed: finished } as never;
          }),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
      }),
    ),
    Layer.provideMerge(layerReceiptsTest),
  );
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const request = {
      projectId,
      threadId,
      commandId,
      messageId,
      text: "fixture steer",
      attachments: [],
      mode: "steer",
      createdBy: "agent",
      creationSource: "mcp",
    } as const;
    const first = yield* threads.sendToThread(request);
    expect(first.delivery).toBe("steered");
    yield* receipts.insertIfAbsent({
      commandId,
      threadId,
      commandType: "message.dispatch",
      acceptedAt: yield* DateTime.now,
      resultSequence: 1,
      status: "accepted",
      error: null,
    });
    finished = true;
    const replay = yield* threads.sendToThread(request);
    expect(replay.dispatch.replayed).toBe(true);
    expect(replay.message.id).toBe(messageId);
    expect(dispatchModes).toEqual(["steer_active", "start_immediately"]);
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("refuses a delegated child on a destination-project-disabled provider", () => {
  const destinationId = ProjectId.make("project:delegation:disabled-destination");
  const instanceId = ProviderInstanceId.make("codex_work");
  const dispatched: Array<string> = [];
  const layerTest = layerDispatchChokepointTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
      projectSettingsOverrides: {
        [destinationId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    }),
  )(dispatched);
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(
      threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegation:disabled-destination"),
        threadId: ThreadId.make("thread:thread-management:chokepoint"),
        messageId: MessageId.make("message:delegation:disabled-destination"),
        text: "Independent task",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "mcp",
        delegation: { projectId: destinationId, modelSelection: { instanceId, model: "test" } },
      }),
    );
    expect(error).toBeInstanceOf(
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
    );
    expect(error).toMatchObject({ projectId: destinationId, instanceId });
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("preserves failed legacy materialization when reading checkpoint context", () => {
  const threadId = ThreadId.make("thread:thread-management:checkpoint-import-failure");
  const importError = new LegacyV1ThreadImporter.LegacyV1ThreadImportError({
    threadId,
    operation: "hydrate transcript for",
    cause: new Error("checkpoint import failed"),
  });
  const layerTest = ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getCheckpointContext: () =>
            Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
        }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          ensureTranscript: () => Effect.fail(importError),
        }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* service.getCheckpointContext(threadId).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Orchestrator.OrchestratorProjectionError);
    expect(error).toMatchObject({ threadId, cause: importError });
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([
  { finalStatus: "completed" as const, timedOut: false },
  { finalStatus: "failed" as const, timedOut: false },
  { finalStatus: "cancelled" as const, timedOut: false },
  { finalStatus: "interrupted" as const, timedOut: false },
  { finalStatus: "rolled_back" as const, timedOut: false },
  { finalStatus: "running" as const, timedOut: true },
  { finalStatus: "missing" as const },
])("waitForThread timeout final read when selected run is $finalStatus", (scenario) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-timeout");
    const threadId = ThreadId.make("thread:thread-management:wait-timeout");
    const runId = RunId.make("run:thread-management:wait-timeout");
    const subscribed = yield* Deferred.make<void>();
    let reads = 0;
    const projection = (status: OrchestrationV2Run["status"] | "missing") =>
      ({
        thread: { id: threadId, projectId, deletedAt: null },
        runs: status === "missing" ? [] : [{ id: runId, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          // No run update arrives, so the timeout path runs while a final
          // projection read can still observe a terminal run.
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          getThreadRecords: () =>
            Effect.sync(() => {
              reads += 1;
              return projection(reads === 1 ? "running" : scenario.finalStatus);
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 1,
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(fiber);

    if (scenario.finalStatus === "missing") {
      expect(result._tag).toBe("Failure");
      expect(result).toMatchObject({
        failure: expect.any(ThreadManagementService.ThreadManagementRunNotFoundError),
      });
      expect(result).toMatchObject({
        failure: { threadId, runId },
      });
    } else {
      expect(result._tag).toBe("Success");
      expect(result).toMatchObject({
        success: {
          threadId,
          timedOut: scenario.timedOut,
          run: { id: runId, status: scenario.finalStatus },
        },
      });
    }
  }),
);

it.effect(
  "waitForThread skips newer admissions and reads the work run again only when it updates",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:thread-management:wait-event");
      const threadId = ThreadId.make("thread:thread-management:wait-event");
      const runId = RunId.make("run:thread-management:wait-event");
      const subscribed = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let status: OrchestrationV2Run["status"] = "running";
      let reads = 0;
      const stored = (sequence: number, event: object) =>
        ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            restartContinuationPending: () => Effect.succeed(false),
            // Only the run.updated stream carries events in this test.
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(() => {
                reads += 1;
                return {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: [
                    {
                      id: RunId.make("newer-delegation-admission"),
                      ordinal: 2,
                      status: "completed",
                      delegationAdmission: {
                        modelSelection: {
                          instanceId: ProviderInstanceId.make("codex"),
                          model: "test",
                        },
                      },
                    },
                    { id: runId, ordinal: 1, status },
                  ],
                } as unknown as OrchestrationV2ThreadProjection;
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const fiber = yield* service
        .waitForThread({ projectId, threadId, timeoutMs: 60 * 60 * 1_000 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      status = "completed";
      yield* Queue.offer(events, stored(1, { type: "run.updated", payload: { id: "other-run" } }));
      yield* Queue.offer(
        events,
        stored(2, { type: "run.updated", payload: { id: runId, status } }),
      );
      const result = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "completed" } });
      // Initial read, this run's update, and the terminal chain refresh after
      // observing its effect nonpending. The unrelated run caused no read.
      expect(reads).toBe(3);
    }),
);

it.effect.each(["initial", "stream", "timeout"] as const)(
  "waitForThread refreshes a continuation admitted between projection and effect reads (%s)",
  (path) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(`project:split-read:${path}`);
      const threadId = ThreadId.make(`thread:split-read:${path}`);
      const runId = RunId.make(`run:split-read:${path}`);
      const continuationId = RunId.make(`run:split-read:${path}:continued`);
      const subscribed = yield* Deferred.make<void>();
      const pendingRead = yield* Deferred.make<void>();
      const releasePendingRead = yield* Deferred.make<void>();
      const refreshedChain = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let admissionOccurred = false;
      let interleaved = false;
      let runs: Array<{
        id: RunId;
        status: OrchestrationV2Run["status"];
        restartContinuationOfRunId?: RunId;
      }> = [{ id: runId, status: path === "initial" ? "cancelled" : "running" }];
      const stored = (id: RunId, status: OrchestrationV2Run["status"]) =>
        ({
          sequence: id === runId ? 1 : 2,
          event: {
            type: "run.updated",
            threadId,
            payload: {
              id,
              status,
              ...(id === continuationId ? { restartContinuationOfRunId: runId } : {}),
            },
          },
        }) as unknown as OrchestrationV2StoredEvent;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            restartContinuationPending: () =>
              Effect.gen(function* () {
                if (!interleaved) {
                  interleaved = true;
                  yield* Deferred.succeed(pendingRead, undefined);
                  yield* Deferred.await(releasePendingRead);
                }
                return false;
              }),
            awaitRestartContinuation: () => Effect.never,
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () =>
              Effect.gen(function* () {
                const snapshot = runs;
                if (admissionOccurred && snapshot.some((run) => run.id === continuationId))
                  yield* Deferred.succeed(refreshedChain, undefined);
                return {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: snapshot,
                } as unknown as OrchestrationV2ThreadProjection;
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const waiter = yield* service
        .waitForThread({
          projectId,
          threadId,
          runId,
          timeoutMs: path === "timeout" ? 1 : 60 * 60 * 1_000,
        })
        .pipe(Effect.forkChild);
      if (path !== "initial") {
        yield* Deferred.await(subscribed);
        runs = [{ id: runId, status: "cancelled" }];
        if (path === "stream") yield* Queue.offer(events, stored(runId, "cancelled"));
        else yield* TestClock.adjust(Duration.millis(1));
      }
      yield* Deferred.await(pendingRead);
      // Model the worker's durable admission of C, followed by settling R's
      // continuation effect, while the waiter still owns the old R-only snapshot.
      const continuation = { id: continuationId, restartContinuationOfRunId: runId };
      runs = [
        { id: runId, status: "cancelled" },
        { ...continuation, status: "running" },
      ];
      admissionOccurred = true;
      yield* Deferred.succeed(releasePendingRead, undefined);
      if (path === "timeout") {
        expect(yield* Fiber.join(waiter)).toMatchObject({
          timedOut: true,
          run: { id: continuationId, status: "running" },
        });
      } else {
        yield* Deferred.await(refreshedChain);
        yield* Deferred.await(subscribed);
        expect(waiter.pollUnsafe()).toBeUndefined();
        runs = [runs[0]!, { ...continuation, status: "completed" }];
        yield* Queue.offer(events, stored(continuationId, "completed"));
        expect(yield* Fiber.join(waiter)).toMatchObject({
          timedOut: false,
          run: { id: continuationId, status: "completed" },
        });
      }
    }),
);

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    // The restart cut the run; its continuation effect has not started yet.
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "subagent.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                  messages: [],
                  subagents,
                  providerThreads: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect("waitForThread settles delegated work on a thread rolled back past its only run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-rolled-back");
    const threadId = ThreadId.make("thread:thread-management:wait-rolled-back");
    const runId = RunId.make("run:thread-management:wait-rolled-back");
    const rolledBack = {
      id: runId,
      ordinal: 1,
      status: "rolled_back",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () => Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [rolledBack],
              messages: [],
              subagents: [],
              providerThreads: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // Nothing will ever run there again, so a wait still open runs out here.
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "rolled_back" },
      resultRun: { id: runId, status: "rolled_back" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          // Declining records no thread event.
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each([false, true])(
  "waitForThread observes a declined continuation after waiting began (earlier cut: %s)",
  (earlierCut) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(`project:wait-later-cut:${earlierCut}`);
      const threadId = ThreadId.make(`thread:wait-later-cut:${earlierCut}`);
      const runId = RunId.make(`run:wait-later-cut:${earlierCut}`);
      const continuationId = RunId.make(`run:wait-later-cut:${earlierCut}:2`);
      const targetId = earlierCut ? continuationId : runId;
      const subscribed = yield* Deferred.make<void>();
      const firstSettled = yield* Deferred.make<void>();
      const declined = yield* Deferred.make<void>();
      const watchingDecline = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let pendingId: RunId | undefined = earlierCut ? runId : undefined;
      let runs: Array<{
        id: RunId;
        status: OrchestrationV2Run["status"];
        restartContinuationOfRunId?: RunId;
      }> = [{ id: runId, status: earlierCut ? "cancelled" : "running" }];
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            restartContinuationPending: (run) => Effect.sync(() => run.id === pendingId),
            awaitRestartContinuation: (run) =>
              run.id === targetId
                ? Deferred.succeed(watchingDecline, undefined).pipe(
                    Effect.andThen(Deferred.await(declined)),
                  )
                : Deferred.await(firstSettled),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { id: threadId, projectId, deletedAt: null },
                    runs,
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const waiter = yield* service
        .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      const cut = {
        id: targetId,
        status: "cancelled" as const,
        ...(earlierCut ? { restartContinuationOfRunId: runId } : {}),
      };
      runs = earlierCut ? [runs[0]!, cut] : [cut];
      pendingId = targetId;
      yield* Queue.offer(events, {
        sequence: 1,
        event: {
          type: "run.updated",
          threadId,
          payload: cut,
        },
      } as unknown as OrchestrationV2StoredEvent);
      if (earlierCut) yield* Deferred.succeed(firstSettled, undefined);
      yield* Deferred.await(watchingDecline);
      pendingId = undefined;
      // No thread event is produced by declining this later continuation.
      yield* Deferred.succeed(declined, undefined);
      expect(yield* Fiber.join(waiter)).toMatchObject({
        timedOut: false,
        run: { id: targetId, status: "cancelled" },
      });
    }),
);

it.effect.each(["live", "no-session", "unsupported-runtime"] as const)(
  "marks background work awaited on the thread's active provider thread with state %s",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait");
      const providerThreadId = ProviderThreadId.make("provider-thread:background-wait");
      const providerSessionId = ProviderSessionId.make("provider-session:background-wait");
      const driver = ProviderDriverKind.make("claudeAgent");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "tests", kind: "command" }],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: now,
        updatedAt: now,
      };
      const calls: Array<{ providerThreadId: ProviderThreadId; awaited: boolean }> = [];
      const runtime = {
        driver,
        providerSessionId,
        ...(state === "unsupported-runtime"
          ? {}
          : {
              awaitBackgroundTasks: (input: {
                readonly providerThread: OrchestrationV2ProviderThread;
                readonly taskIds: ReadonlyArray<string>;
                readonly awaited: boolean;
              }) =>
                Effect.sync(() => {
                  calls.push({
                    providerThreadId: input.providerThread.id,
                    awaited: input.awaited,
                  });
                  return { matched: input.taskIds.filter((taskId) => taskId === "tests") };
                }),
            }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime)),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        return yield* service
          .awaitBackgroundTasks({ threadId, taskIds: ["tests", "finished"], awaited: true })
          .pipe(Effect.result);
      }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));

      if (state === "live") {
        expect(result).toMatchObject({
          success: { matched: ["tests"], unmatched: ["finished"] },
        });
        expect(calls).toEqual([{ providerThreadId, awaited: true }]);
      } else {
        expect(result).toMatchObject({
          failure: {
            _tag: "ThreadManagementBackgroundWaitError",
            reason: state === "no-session" ? "unavailable" : "unsupported",
          },
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);
