import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as StoragePressure from "../storagePressure.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-mode-limit" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ).pipe(Layer.provide(StoragePressure.layerTest)),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:dispatch-mode-limit"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("DispatchModeLimit", (it) => {
  it.effect(
    "does not admit a message whose deadline passes after planning; retry stays idempotent",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:late-planning-fixture");
        yield* createThread(threadId);
        const command = {
          type: "message.dispatch",
          commandId: CommandId.make("late-planning-retry"),
          messageId: MessageId.make("late-planning-message"),
          threadId,
          text: "Late fixture",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        } as const;
        const clock = vi.spyOn(performance, "now").mockReturnValue(0);
        const commit = sink.commitCommand;
        const spy = vi.spyOn(sink, "commitCommand").mockImplementation((input) => {
          if (input.commandId === command.commandId) clock.mockReturnValue(20);
          return commit(input);
        });
        yield* Effect.gen(function* () {
          const limit = { ...supervised, expiresAtMonotonicMs: 10 };
          const refused = yield* Effect.result(
            orchestrator.dispatch(command).pipe(Effect.provideService(DispatchModeLimit, limit)),
          );
          assert.equal(refused._tag, "Failure");
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).messages.filter(
              (message) => message.id === command.messageId,
            ).length,
            0,
          );
          spy.mockRestore();
          clock.mockReturnValue(0);
          yield* orchestrator
            .dispatch(command)
            .pipe(Effect.provideService(DispatchModeLimit, limit));
          const replay = yield* orchestrator
            .dispatch(command)
            .pipe(Effect.provideService(DispatchModeLimit, limit));
          assert.isTrue(replay.replayed);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).messages.filter(
              (message) => message.id === command.messageId,
            ).length,
            1,
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              spy.mockRestore();
              clock.mockRestore();
            }),
          ),
        );
      }),
  );

  it.effect("rejects changed send inputs for an already accepted retry key", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:retry-conflict-fixture");
      yield* createThread(threadId);
      const command = {
        type: "message.dispatch",
        commandId: CommandId.make("retry-conflict-key"),
        messageId: MessageId.make("retry-conflict-message"),
        threadId,
        text: "original",
        sendRequest: { text: "original", mode: "queue" },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
        remoteSender: {
          environmentId: EnvironmentId.make("source-env"),
          threadId: ThreadId.make("source-thread"),
        },
      } as const;
      yield* orchestrator.dispatch(command);
      for (const changed of [
        { ...command, text: "changed", sendRequest: { ...command.sendRequest, text: "changed" } },
        { ...command, sendRequest: { ...command.sendRequest, mode: "auto" as const } },
        {
          ...command,
          remoteSender: { ...command.remoteSender, threadId: ThreadId.make("other-source") },
        },
      ]) {
        const error = yield* Effect.flip(orchestrator.dispatch(changed));
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.include(String(error.cause), "conflict");
      }
      const replay = yield* orchestrator.dispatch(command);
      assert.isTrue(replay.replayed);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.messages.filter((m) => m.id === command.messageId).length, 1);
    }),
  );
  it.effect("replays a fixture agent message once with the same durable command ID", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:connected-qa-fixture");
      yield* createThread(threadId);
      const command = {
        type: "message.dispatch",
        commandId: CommandId.make("connected-qa-retry-key"),
        messageId: MessageId.make("connected-qa-message"),
        threadId,
        text: "QA fixture: connected environment relay",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const limit = { ...supervised, expiresAtMonotonicMs: Number.MAX_SAFE_INTEGER };
      yield* orchestrator.dispatch(command).pipe(Effect.provideService(DispatchModeLimit, limit));
      const replay = yield* orchestrator
        .dispatch(command)
        .pipe(Effect.provideService(DispatchModeLimit, limit));
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const messages = projection.messages.filter((message) => message.id === command.messageId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.createdBy, "agent");
      assert.equal(messages[0]?.creationSource, "mcp");
      assert.isTrue(replay.replayed);
    }),
  );
  it.effect(
    "rejects an expired connected admission under the thread lock without recording a receipt",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:expired-connected-admission");
        yield* createThread(threadId);
        const rename = {
          type: "thread.metadata.update",
          commandId: CommandId.make("connected-admission-retry"),
          threadId,
          title: "After",
        } as const;
        const refused = yield* orchestrator.dispatch(rename).pipe(
          Effect.provideService(DispatchModeLimit, {
            ...supervised,
            expiresAtMonotonicMs: 0,
          }),
          Effect.flip,
        );
        assert.equal(refused._tag, "OrchestratorDispatchError");
        assert.equal((yield* projections.getThreadShell(threadId))?.title, "Before");
        yield* orchestrator.dispatch(rename).pipe(
          Effect.provideService(DispatchModeLimit, {
            ...supervised,
            expiresAtMonotonicMs: Number.MAX_SAFE_INTEGER,
          }),
        );
        assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
      }),
  );
  it.effect("refuses a limited command on a thread its user raised, and records nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:limit-raised");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise"),
        threadId,
        runtimeMode: "full-access",
      });
      const rename = {
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "After",
      } as const;
      const refused = yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "Before");

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised));
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("refuses to fork a source thread its user raised", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = ThreadId.make("thread:limit-fork-source");
      const targetThreadId = ThreadId.make("thread:limit-fork-target");
      yield* createThread(sourceThreadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-source"),
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      const fork = {
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const refused = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.ok(refused._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refused.threadId, sourceThreadId);
      assert.isNull(yield* projections.getThreadShell(targetThreadId));

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower-source"),
        threadId: sourceThreadId,
        runtimeMode: "approval-required",
      });
      const retried = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(retried._tag, "OrchestratorDispatchError");
    }),
  );
});
