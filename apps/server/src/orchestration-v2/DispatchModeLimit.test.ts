import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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

const layerPolicyDatabase = SqlitePersistence.layerMemory;
const layerWithCeiling = Layer.mergeAll(
  layerPolicyDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerPolicyDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runtime-mode-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerPolicyDatabase,
      runEffectWorker: false,
      managedPolicy: {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { maxRuntimeMode: "auto-accept-edits" },
      },
    },
  ),
);

const sendMessage = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** A thread that ran in full access before the policy arrived, as an import or an older build leaves it. */
const raiseBehindPolicy = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* createThread(threadId);
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:raise-behind-policy:${threadId}`),
          type: "thread.runtime-mode-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...thread, runtimeMode: "full-access" },
        },
      ],
    });
  });

it.layer(layerWithCeiling)("runtime mode ceiling", (it) => {
  it.effect("refuses the user's own thread and mode changes above the ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-user");
      const create = {
        type: "thread.create",
        commandId: CommandId.make("create:ceiling-user:full"),
        threadId,
        projectId: ProjectId.make("project:dispatch-mode-limit"),
        title: "Full",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      } as const;
      const refusedCreate = yield* orchestrator.dispatch(create).pipe(Effect.flip);
      assert.ok(refusedCreate._tag === "OrchestratorRuntimeModeAboveCeilingError");
      assert.equal(refusedCreate.refused, "mode");
      assert.equal(refusedCreate.message, "Example Corp limits threads to Auto-accept edits.");
      assert.isNull(yield* projections.getThreadShell(threadId));

      yield* createThread(threadId);
      const raise = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-user"),
          threadId,
          runtimeMode: "auto",
        })
        .pipe(Effect.flip);
      assert.equal(raise._tag, "OrchestratorRuntimeModeAboveCeilingError");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-to-ceiling:ceiling-user"),
        threadId,
        runtimeMode: "auto-accept-edits",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.runtimeMode, "auto-accept-edits");
    }),
  );

  it.effect("narrows an MCP caller's limit to the ceiling inside the lock", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-mcp");
      yield* createThread(threadId);
      const fullAccessCaller = { runtimeMode: "full-access", interactionMode: "default" } as const;
      const raise = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-mcp"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller), Effect.flip);
      assert.equal(raise._tag, "OrchestratorRuntimeModeAboveCeilingError");

      const raisedThreadId = ThreadId.make("thread:ceiling-mcp-raised");
      yield* raiseBehindPolicy(raisedThreadId);
      const rename = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename:ceiling-mcp"),
          threadId: raisedThreadId,
          title: "After",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller), Effect.flip);
      assert.equal(rename._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(raisedThreadId))?.title, "Before");
    }),
  );

  it.effect("refuses turns on a thread above the ceiling until its mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-raised");
      yield* raiseBehindPolicy(threadId);

      const refused = yield* orchestrator
        .dispatch(sendMessage(threadId, "first"))
        .pipe(Effect.flip);
      assert.ok(refused._tag === "OrchestratorRuntimeModeAboveCeilingError");
      assert.equal(refused.refused, "turn");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 0);

      // The user's own housekeeping and the way back down stay open.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename:ceiling-raised"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-raised"),
        threadId,
        runtimeMode: "approval-required",
      });
      // Refusals record no receipt, so the same command goes through once the mode is lowered.
      yield* orchestrator.dispatch(sendMessage(threadId, "first"));
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 1);
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("starts a queue that waited above the ceiling once the mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:ceiling-queue");
      yield* createThread(threadId);
      yield* orchestrator.dispatch(sendMessage(threadId, "running"));
      yield* orchestrator.dispatch({
        ...sendMessage(threadId, "waiting"),
        dispatchMode: { type: "queue_after_active" },
      });
      // The policy arrives with the thread above it and its first run ending.
      const { thread, runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const [running, waiting] = runs;
      const occurredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:ceiling-queue:raise"),
            type: "thread.runtime-mode-updated",
            threadId,
            occurredAt,
            payload: { ...thread, runtimeMode: "full-access" },
          },
          {
            id: EventId.make("event:ceiling-queue:complete"),
            type: "run.updated",
            threadId,
            runId: running!.id,
            providerInstanceId: running!.providerInstanceId,
            occurredAt,
            payload: { ...running!, status: "completed" },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-queue"),
        threadId,
        runtimeMode: "approval-required",
      });
      const started = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id === waiting!.id,
      );
      assert.notEqual(started?.status, "queued");
    }),
  );
});
