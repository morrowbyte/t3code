import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect.each([
  {
    name: "publishes a delegated chart in its conversation once while sibling work continues",
    outcome: "completed",
    streaming: false,
    hasResult: true,
    publishes: true,
  },
  {
    name: "does not publish failed delegated work as a completed conversation result",
    outcome: "failed",
    streaming: false,
    hasResult: true,
    publishes: false,
  },
  {
    name: "does not publish an unfinished delegated assistant item as a conversation result",
    outcome: "completed",
    streaming: true,
    hasResult: true,
    publishes: false,
  },
  {
    name: "does not publish the missing-result fallback as a conversation result",
    outcome: "completed",
    streaming: false,
    hasResult: false,
    publishes: false,
  },
] as const)("$name", (scenario) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:voice-public-result");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-voice-public-result"),
      threadId,
      projectId: ProjectId.make("project:voice-public-result"),
      title: "Voice conversation",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const command = {
      type: "message.dispatch" as const,
      commandId: CommandId.make("voice-public-result"),
      threadId,
      messageId: MessageId.make("message:voice-public-result"),
      text: "Show an example build-time chart while the other task keeps working.",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
      delegation: { modelSelection },
      createdBy: "user" as const,
      creationSource: "voice" as const,
    };
    const accepted = yield* orchestrator.dispatch(command);
    yield* orchestrator.dispatch({
      ...command,
      commandId: CommandId.make("voice-public-result-sibling"),
      messageId: MessageId.make("message:voice-public-result-sibling"),
      text: "Keep researching the independent question.",
    });
    const parent = yield* projections.getThreadProjection(threadId);
    const task = parent.subagents.find((candidate) => candidate.prompt === command.text)!;
    const child = yield* projections.getThreadProjection(task.childThreadId!);
    const childRun = child.runs[0]!;
    const now = yield* DateTime.now;
    const chart = [
      "**Example data, invented; no measurements.**",
      "",
      "```t3-ui",
      '{"type":"chart","id":"build-example","title":"Example build times","kind":"bar"}',
      '{"type":"point","id":"build-example","label":"Laptop","value":8}',
      '{"type":"point","id":"build-example","label":"Server","value":3}',
      '{"type":"point","id":"build-example","label":"Cloud","value":2}',
      "```",
    ].join("\n");
    const childMessageId = MessageId.make("message:child-public-chart");
    const childItemId = TurnItemId.make("item:child-public-chart");
    yield* sink.write({
      events: [
        ...(scenario.hasResult
          ? ([
              {
                id: EventId.make("event:child-public-chart-message"),
                type: "message.updated",
                threadId: child.thread.id,
                runId: childRun.id,
                occurredAt: now,
                payload: {
                  id: childMessageId,
                  threadId: child.thread.id,
                  runId: childRun.id,
                  nodeId: childRun.rootNodeId,
                  role: "assistant",
                  text: chart,
                  attachments: [],
                  streaming: scenario.streaming,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make("event:child-public-chart-item"),
                type: "turn-item.updated",
                threadId: child.thread.id,
                runId: childRun.id,
                occurredAt: now,
                payload: {
                  id: childItemId,
                  type: "assistant_message",
                  messageId: childMessageId,
                  threadId: child.thread.id,
                  runId: childRun.id,
                  nodeId: childRun.rootNodeId,
                  providerThreadId: childRun.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: scenario.streaming ? "running" : "completed",
                  title: null,
                  text: chart,
                  streaming: scenario.streaming,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ] satisfies OrchestrationV2DomainEvent[])
          : []),
        {
          id: EventId.make("event:child-public-chart-completed"),
          type: "run.updated",
          threadId: child.thread.id,
          runId: childRun.id,
          occurredAt: now,
          payload: { ...childRun, status: scenario.outcome, startedAt: now, completedAt: now },
        },
      ],
    });
    yield* orchestrator.recoverDelegatedTasks;
    const published = yield* projections.getThreadProjection(threadId);
    assert.equal(
      published.subagents.find((candidate) => candidate.id === task.id)?.status,
      scenario.outcome,
    );
    if (scenario.hasResult)
      assert.equal(
        published.subagents.find((candidate) => candidate.id === task.id)?.result,
        chart,
      );
    const message = published.messages.find((candidate) => candidate.role === "assistant");
    if (scenario.publishes) {
      assert.equal(message?.text, chart, "the complete public chart reaches the parent chat");
      assert.equal(message?.senderThreadId, child.thread.id);
      assert.isNull(message?.runId);
      assert.isNull(message?.nodeId);
      const item = published.turnItems.find((candidate) => candidate.type === "assistant_message");
      assert.ok(item?.type === "assistant_message");
      assert.equal(item.text, chart);
      assert.isAbove(item.ordinal, Math.max(...parent.turnItems.map((row) => row.ordinal)));
      assert.equal(item.messageId, message?.id);
      assert.notEqual(item.id, childItemId);
      assert.isNull(item.runId);
      assert.isNull(item.nodeId);
      assert.isNull(item.providerThreadId);
      assert.isNull(item.providerTurnId);
      assert.isNull(item.nativeItemRef);
    } else {
      assert.isUndefined(message);
      assert.isFalse(
        published.turnItems.some((candidate) => candidate.type === "assistant_message"),
      );
    }
    assert.equal(
      published.subagents.find((candidate) => candidate.id !== task.id)?.status,
      "running",
    );
    const transfer = published.contextTransfers.find(
      (candidate) => candidate.type === "subagent_result",
    );
    assert.equal(transfer?.sourcePoint.runId, childRun.id);
    if (scenario.hasResult) assert.equal(transfer?.sourcePoint.turnItemId, childItemId);
    assert.equal((yield* orchestrator.dispatch(command)).sequence, accepted.sequence);
    yield* orchestrator.recoverDelegatedTasks;
    const retried = yield* projections.getThreadProjection(threadId);
    assert.equal(
      retried.messages.filter((candidate) => candidate.role === "assistant").length,
      Number(scenario.publishes),
    );
    assert.equal(
      retried.turnItems.filter((candidate) => candidate.type === "assistant_message").length,
      Number(scenario.publishes),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "admits three independent conversation tasks while ordinary provider work remains active",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const destinationProject = ProjectId.make("project:independent-destination");
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("create-independent-destination"),
        aggregateKind: "project",
        aggregateId: destinationProject,
        occurredAt: "2026-10-23T18:00:00Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: destinationProject,
          title: "Destination",
          workspaceRoot: "/destination-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-23T18:00:00Z",
          updatedAt: "2026-10-23T18:00:00Z",
        },
      });
      const threadId = ThreadId.make("thread:parallel-conversation-work");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parallel-conversation-work"),
        threadId,
        projectId: ProjectId.make("project:parallel-conversation-work"),
        title: "Conversation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ordinary-work-before-delegations"),
        threadId,
        messageId: MessageId.make("message:ordinary-work"),
        text: "Keep the existing expert task running.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const original = (yield* projections.getThreadProjection(threadId)).runs[0]!;
      for (const [index, text] of [
        "Research the requested releases.",
        "Inspect the unrelated project issue.",
        "Check today's requested posts.",
      ].entries()) {
        const command = {
          type: "message.dispatch" as const,
          commandId: CommandId.make(`independent-conversation-task-${index}`),
          threadId,
          messageId: MessageId.make(`message:independent-conversation-task-${index}`),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
          delegation: {
            modelSelection,
            ...(index === 2 ? { projectId: destinationProject } : {}),
            voiceIntake: {
              stopId: null,
              leaseId: "intake-lease",
              generation: 1,
              intentId: `intake-${index}`,
              provisional: true,
              sources: [
                {
                  segmentId: `segment-${index}`,
                  stopId: null,
                  revision: 3,
                  start: 0,
                  end: text.length,
                  quote: text,
                },
              ],
            },
          },
          createdBy: "user" as const,
          creationSource: "voice" as const,
        };
        const accepted = yield* orchestrator.dispatch(command);
        const parent = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          parent.runs.find((run) => run.id === original.id),
          original,
        );
        const task = parent.subagents.find((child) => child.prompt === text);
        assert.ok(task?.childThreadId);
        assert.equal(task.status, "running");
        const admission = parent.runs.find((run) => run.id === task.runId)!;
        assert.equal(admission.status, "completed");
        assert.isNull(admission.providerThreadId);
        assert.isNull(admission.activeAttemptId);
        assert.ok(parent.nodes.some((node) => node.id === admission.rootNodeId));
        const child = yield* projections.getThreadProjection(task.childThreadId);
        if (index === 2) {
          assert.equal(child.thread.projectId, destinationProject);
          assert.isNull(child.thread.worktreePath);
          assert.isNull(child.thread.branch);
        }
        assert.deepEqual(child.thread.voiceIntake, command.delegation.voiceIntake);
        assert.deepEqual(
          admission.delegationAdmission?.voiceIntake,
          command.delegation.voiceIntake,
        );
        assert.equal(child.runs[0]!.status, "starting");
        assert.equal(child.messages[0]!.text, text);
        assert.equal(child.messages.length, 1, "only the concrete brief reaches a fresh child");
        const effects = yield* outbox.listByCommandId(command.commandId);
        const starts = effects.filter((effect) => effect.request.type === "provider-turn.start");
        assert.equal(starts.length, 1);
        assert.equal(starts[0]!.threadId, child.thread.id);
        const replay = yield* orchestrator.dispatch(command);
        assert.equal(replay.sequence, accepted.sequence);
        const changed = yield* orchestrator
          .dispatch({ ...command, text: "A different task." })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(changed), "a reused logical request cannot change its task");
        assert.isTrue(
          Result.isFailure(
            yield* orchestrator
              .dispatch({ ...command, dispatchMode: { type: "queue_after_active" } })
              .pipe(Effect.result),
          ),
          "a retry cannot change delegation into a queued send",
        );
        const { delegation: _delegation, ...ordinaryRetry } = command;
        assert.isTrue(
          Result.isFailure(yield* orchestrator.dispatch(ordinaryRetry).pipe(Effect.result)),
          "a retry must retain the explicit delegation intent",
        );
      }
      const parent = yield* projections.getThreadProjection(threadId);
      assert.equal(parent.subagents.length, 3);
      assert.equal(parent.runs.filter((run) => run.status === "queued").length, 0);
      assert.equal(parent.runs.filter((run) => run.status === "starting").length, 1);
      const firstTask = parent.subagents[0]!;
      const provisional = yield* projections.getThreadProjection(firstTask.childThreadId!);
      const beforeRunIds = provisional.runs.map((run) => run.id);
      const confirm = {
        type: "thread.runtime-mode.set" as const,
        commandId: CommandId.make("confirm-voice-intake"),
        threadId: provisional.thread.id,
        runtimeMode: provisional.thread.runtimeMode,
        voiceIntakeConfirmation: { ...provisional.thread.voiceIntake!, provisional: false },
      };
      const confirmedReceipt = yield* orchestrator.dispatch(confirm);
      const confirmed = yield* projections.getThreadProjection(provisional.thread.id);
      assert.isFalse(confirmed.thread.voiceIntake!.provisional);
      assert.deepEqual(
        confirmed.runs.map((run) => run.id),
        beforeRunIds,
      );
      assert.equal((yield* orchestrator.dispatch(confirm)).sequence, confirmedReceipt.sequence);
      assert.equal((yield* projections.getThreadProjection(threadId)).subagents.length, 3);

      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("finish-original-task-for-nested-admission"),
            type: "subagent.updated",
            threadId,
            runId: firstTask.runId!,
            occurredAt: yield* DateTime.now,
            payload: { ...firstTask, status: "completed", result: "Original result" },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("nested-conversation-admission"),
        threadId: firstTask.childThreadId!,
        messageId: MessageId.make("nested-conversation-admission"),
        text: "A separate nested task",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        delegation: { modelSelection },
        createdBy: "user",
        creationSource: "voice",
      });
      const nested = yield* projections.getThreadProjection(firstTask.childThreadId!);
      assert.equal(
        nested.subagents.length,
        1,
        "the task remains owned by the destination conversation",
      );
      assert.notEqual(nested.subagents[0]!.childThreadId, nested.thread.id);
      assert.equal(
        (yield* projections.getThreadProjection(threadId)).subagents.length,
        3,
        "no follow-up overwrites the new task identity",
      );
      const otherId = ThreadId.make("thread:z-other-conversation");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-opposite-conversation"),
        threadId: otherId,
        projectId: parent.thread.projectId,
        title: "Other conversation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-opposite-conversation"),
        threadId: otherId,
        messageId: MessageId.make("start-opposite-conversation"),
        text: "Existing direct work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const otherRun = (yield* projections.getThreadProjection(otherId)).runs[0]!;
      const cross = (source: ThreadId, sourceRun: RunId, destination: ThreadId, key: string) => ({
        type: "message.dispatch" as const,
        commandId: CommandId.make(key),
        threadId: destination,
        senderThreadId: source,
        messageId: MessageId.make(key),
        text: key,
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        delegation: {
          modelSelection,
          caller: { threadId: source, runId: sourceRun, providerInstanceId: instanceId },
        },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      });
      yield* Effect.all(
        [
          orchestrator.dispatch(cross(threadId, original.id, otherId, "cross-a-to-b")),
          orchestrator.dispatch(cross(otherId, otherRun.id, threadId, "cross-b-to-a")),
        ],
        { concurrency: "unbounded" },
      );
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holding = yield* locks
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(held);
      const stopping = yield* orchestrator
        .dispatch({
          type: "thread.stop",
          threadId,
          commandId: CommandId.make("stop-before-cross-admission"),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const late = yield* orchestrator
        .dispatch(cross(threadId, original.id, otherId, "late-cross-after-source-stop"))
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holding);
      yield* Fiber.join(stopping);
      assert.isTrue(
        Result.isFailure(yield* Fiber.join(late)),
        "source Stop wins even when the destination is still live",
      );
      assert.equal(
        (yield* projections.getThreadProjection(otherId)).subagents.length,
        1,
        "the stopped caller adds no destination task",
      );
      yield* orchestrator.dispatch({
        type: "thread.stop",
        threadId,
        commandId: CommandId.make("stop-before-late-conversation-admission"),
      });
      const afterStop = {
        type: "message.dispatch" as const,
        threadId,
        commandId: CommandId.make("late-conversation-admission"),
        messageId: MessageId.make("late-conversation-admission"),
        text: "Late provider tool",
        senderThreadId: threadId,
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        delegation: {
          modelSelection,
          caller: { threadId, runId: original.id, providerInstanceId: instanceId },
        },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      assert.isTrue(
        Result.isFailure(yield* orchestrator.dispatch(afterStop).pipe(Effect.result)),
        "a fresh MCP admission cannot escape a committed Stop",
      );
      yield* orchestrator.dispatch({
        ...afterStop,
        commandId: CommandId.make("fresh-user-after-stop"),
        messageId: MessageId.make("fresh-user-after-stop"),
        createdBy: "user",
        creationSource: "voice",
        delegation: { modelSelection },
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("fences a held voice decision against committed Stop and preserves accepted replay", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const threadId = ThreadId.make("thread:voice-intake-stop");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-intake-stop"),
      threadId,
      projectId: ProjectId.make("project:intake-stop"),
      title: "Voice Stop",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const command = (key: string, stopId: string | null) => ({
      type: "message.dispatch" as const,
      commandId: CommandId.make(key),
      threadId,
      messageId: MessageId.make(key),
      text: "Research a read-only concept.",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
      delegation: {
        modelSelection,
        voiceIntake: {
          leaseId: "lease",
          generation: 1,
          intentId: key,
          provisional: true,
          stopId,
          sources: [{ segmentId: key, revision: 1, start: 0, end: 8, quote: "Research", stopId }],
        },
      },
      createdBy: "user" as const,
      creationSource: "voice" as const,
    });
    const acceptedCommand = command("accepted-before-stop", null);
    const accepted = yield* orchestrator.dispatch(acceptedCommand);
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holding = yield* locks
      .withLock(
        threadId,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(held);
    const stopId = CommandId.make("stop-during-voice-decision");
    const stopping = yield* orchestrator
      .dispatch({ type: "thread.stop", commandId: stopId, threadId })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const late = yield* orchestrator
      .dispatch(command("decision-from-before-stop", null))
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holding);
    yield* Fiber.join(stopping);
    assert.isTrue(
      Result.isFailure(yield* Fiber.join(late)),
      "a held decision cannot start after Stop commits",
    );
    const stopped = yield* projections.getThreadProjection(threadId);
    assert.equal(stopped.thread.voiceIntakeStopId, stopId);
    assert.equal(stopped.subagents.length, 1);
    assert.equal((yield* orchestrator.dispatch(acceptedCommand)).sequence, accepted.sequence);
    assert.isTrue(
      Result.isFailure(
        yield* orchestrator.dispatch(command("late-final", null)).pipe(Effect.result),
      ),
    );
    const fresh = command("new-speech-after-stop", stopId);
    const freshReceipt = yield* orchestrator.dispatch(fresh);
    assert.equal((yield* projections.getThreadProjection(threadId)).subagents.length, 2);
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("second-stop"),
      threadId,
    });
    assert.equal((yield* orchestrator.dispatch(fresh)).sequence, freshReceipt.sequence);
    const owner = yield* projections.getThreadProjection(threadId);
    const work = owner.subagents.at(-1)!;
    const child = yield* projections.getThreadProjection(work.childThreadId!);
    const beforeMessages = child.messages.length;
    const continuation = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("stale-confirmed-continuation"),
        threadId: child.thread.id,
        messageId: MessageId.make("stale-confirmed-continuation"),
        text: "Continue the authorized work.",
        attachments: [],
        createdBy: "user",
        creationSource: "voice",
        dispatchMode: { type: "restart_active", targetRunId: child.runs[0]!.id },
        voiceIntakeSource: fresh.delegation.voiceIntake,
      })
      .pipe(Effect.result);
    assert.isTrue(
      Result.isFailure(continuation),
      "the Parent Stop fence also protects an exact child continuation",
    );
    if (Result.isFailure(continuation)) {
      assert.equal(continuation.failure._tag, "OrchestratorDispatchError");
      if (continuation.failure._tag === "OrchestratorDispatchError")
        assert.include(String(continuation.failure.cause), "captured voice source");
    }
    assert.equal(
      (yield* projections.getThreadProjection(child.thread.id)).messages.length,
      beforeMessages,
    );

    assert.isTrue(
      Result.isFailure(
        yield* orchestrator.dispatch(command("new-key-old-speech", stopId)).pipe(Effect.result),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "records approval feedback and targets only its runtime request without dispatching a parent turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:approval-feedback");
      const sessionId = ProviderSessionId.make("session:approval-feedback");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-approval-feedback"),
        threadId,
        projectId: ProjectId.make("project:approval-feedback"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make("session:approval-feedback"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const name of ["child", "other"]) {
        yield* projections.apply({
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(name),
            nodeId: NodeId.make(`node:${name}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: sessionId,
              supportsFeedback: name === "child",
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      const commandId = CommandId.make("respond:approval-feedback");
      const feedback = "Run it in a safer manner.";
      for (const [index, invalid] of [
        { requestId: RuntimeRequestId.make("other"), decision: "decline" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "accept" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "decline" as const, feedback: "  " },
      ].entries()) {
        const rejectedId = CommandId.make(`invalid-feedback:${index}`);
        const rejected = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: rejectedId,
            threadId,
            ...invalid,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rejected));
        assert.deepEqual(yield* outbox.listByCommandId(rejectedId), []);
      }
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId: RuntimeRequestId.make("child"),
        decision: "decline",
        feedback,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "child")?.feedback,
        feedback,
      );
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "other")?.status,
        "pending",
      );
      assert.equal(projection.messages.at(-1)?.text, feedback);
      const feedbackMessageId = MessageId.make("approval-feedback:child");
      assert.ok(
        projection.visibleTurnItems.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      const history = yield* projections.getTimelinePage(threadId, { limit: 20, view: "messages" });
      assert.ok(
        history.items.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      assert.equal(projection.runs.length, 0);
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request),
        [
          {
            type: "runtime-request.respond",
            providerSessionId: sessionId,
            requestId: RuntimeRequestId.make("child"),
            decision: "decline",
            feedback,
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("marks a never-visited thread's first completion unread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:completion-watermark");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-completion-watermark"),
      threadId,
      projectId: ProjectId.make("project:completion-watermark"),
      title: "Background task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    assert.isNull((yield* projections.getThreadShell(threadId))?.lastVisitedAt);
    const dispatch = (id: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: "Run in the background",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* TestClock.adjust("1 second");
    const dispatchedAt = yield* DateTime.now;
    yield* dispatch("first-completion-watermark");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt-completion-watermark"),
      threadId,
      runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
    });
    // The run ends in the dispatch's millisecond and must still be unread.
    const ended = yield* projections.getThreadShell(threadId);
    assert.ok(ended?.lastVisitedAt && ended.latestRunCompletedAt);
    assert.equal(
      DateTime.toEpochMillis(ended.lastVisitedAt),
      DateTime.toEpochMillis(dispatchedAt) - 1,
    );
    assert.isAbove(
      DateTime.toEpochMillis(ended.latestRunCompletedAt),
      DateTime.toEpochMillis(ended.lastVisitedAt),
    );

    yield* TestClock.adjust("1 second");
    yield* dispatch("second-completion-watermark");
    assert.deepEqual(
      (yield* projections.getThreadShell(threadId))?.lastVisitedAt,
      ended.lastVisitedAt,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        const answers = { text: "Blue", list: ["Red"], codex: { answers: ["Green"] } };
        const normalizedAnswers = { ...answers, codex: ["Green"] };
        if (mode === "live") {
          const pending = yield* projections.getRuntimeResponseContext(threadId, requestId);
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          for (const [index, value] of [
            null,
            42,
            { choice: "Blue" },
            ["Blue", 42],
            { answers: [42] },
          ].entries()) {
            const commandId = CommandId.make(`invalid-answer:${index}`);
            const result = yield* orchestrator
              .dispatch({
                type: "runtime-request.respond",
                commandId,
                threadId,
                requestId,
                answers: { ...answers, invalid: value },
              })
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(result));
            assert.deepEqual(
              yield* projections.getRuntimeResponseContext(threadId, requestId),
              pending,
            );
            assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
            assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          }
        }
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                answers,
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
        if (mode === "live") {
          assert.deepEqual(response.request?.answers, normalizedAnswers);
          assert.equal(response.item?.type, "user_input_request");
          if (response.item?.type === "user_input_request") {
            assert.deepEqual(response.item.questionAnswer?.answers, normalizedAnswers);
          }
          const effects = yield* outbox.listByCommandId(CommandId.make(`respond:${mode}`));
          assert.deepEqual(
            effects.map((effect) => effect.request),
            [
              {
                type: "runtime-request.respond",
                providerSessionId: sessionId,
                requestId,
                answers: normalizedAnswers,
              },
            ],
          );
        }
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records delegation communication once while retaining the complete child prompt", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:delegation-communication");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-delegation-communication"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:delegation-communication"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-delegation-communication"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:delegation-communication"),
      text: "Delegate work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    const firstParagraph = `Kurz: Prüfe diese Aufgabe vollständig. ${"Kein Wort abschneiden. ".repeat(40)}\nAuch diese Zeile gehört dazu.`;
    const task = `${firstParagraph}\n\nTechnik:\nVollständiger ausführlicher Auftrag.\n\nWeitere Details.`;
    const now = yield* DateTime.now;
    for (const roleWrapped of [false, true]) {
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make(`delegate-communication-${roleWrapped}`),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: roleWrapped ? `Act as the implementation sub-agent for this task.\n\n${task}` : task,
        ...(roleWrapped ? { taskFirstParagraph: firstParagraph } : {}),
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        createdAt: now,
      };
      const accepted = yield* orchestrator.dispatch(command);
      const updatedParent = yield* projections.getThreadProjection(parentThreadId);
      const item = updatedParent.turnItems.find(
        (row) => row.type === "subagent" && row.prompt === command.task,
      );
      assert.ok(item?.type === "subagent" && item.delegationMessage !== undefined);
      assert.equal(item.delegationMessage.firstParagraph, firstParagraph);
      assert.deepEqual(item.startedAt, now);
      const child = yield* projections.getThreadProjection(item.childThreadId!);
      assert.lengthOf(child.messages, 1);
      assert.equal(child.messages[0]!.id, item.delegationMessage.messageId);
      assert.equal(child.messages[0]!.text, command.task);
      assert.equal(child.messages[0]!.senderThreadId, parentThreadId);
      assert.equal(item.prompt, command.task);
      const replayed = yield* orchestrator.dispatch({
        ...command,
        task: "A retry must not replace the original.",
      });
      assert.equal(replayed.sequence, accepted.sequence);
      assert.deepEqual(
        replayed.storedEvents.map(({ event }) => event.id),
        accepted.storedEvents.map(({ event }) => event.id),
      );
      assert.deepEqual(yield* projections.getThreadProjection(parentThreadId), updatedParent);
      assert.deepEqual(yield* projections.getThreadProjection(item.childThreadId!), child);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("promotes child presentation without changing execution ownership", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "pingdotgg/t3code",
      number: 123,
      url: "https://github.com/pingdotgg/t3code/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/pingdotgg/t3code/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);

    const childRun = linkedChild.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-nested-presentation"),
      parentThreadId: childThreadId,
      parentRunId: childRun.id,
      parentNodeId: childRun.rootNodeId!,
      task: "Nested work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childWithNested = yield* projections.getThreadProjection(childThreadId);
    const nestedThreadId = childWithNested.subagents[0]!.childThreadId!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("child-presentation-followup"),
      threadId: childThreadId,
      messageId: MessageId.make("message:child-presentation-followup"),
      text: "Continue in this same child thread",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: [
        {
          type: "run.updated",
          id: EventId.make("complete-presentation-parent"),
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle-presentation-parent"),
      threadId: parentThreadId,
    });
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("snooze-presentation-parent"),
      threadId: parentThreadId,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const parentBeforePromotion = yield* projections.getThreadProjection(parentThreadId);
    const sql = yield* SqlClient.SqlClient;
    const outboxBefore = yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`;
    for (const targetId of [childThreadId, nestedThreadId]) {
      const before = yield* projections.getThreadProjection(targetId);
      const promote = {
        type: "thread.metadata.update" as const,
        commandId: CommandId.make(`promote:${targetId}`),
        threadId: targetId,
        presentation: "top_level" as const,
      };
      const receipt = yield* orchestrator.dispatch(promote);
      assert.deepEqual(
        receipt.storedEvents.map(({ event }) => event.type),
        ["thread.metadata-updated"],
      );
      const replay = yield* orchestrator.dispatch(promote);
      assert.equal(replay.sequence, receipt.sequence);
      const promoted = yield* projections.getThreadProjection(targetId);
      assert.equal(promoted.thread.presentation, "top_level");
      assert.deepEqual(
        {
          ...promoted,
          thread: {
            ...promoted.thread,
            presentation: undefined,
            updatedAt: before.thread.updatedAt,
          },
          updatedAt: before.updatedAt,
        },
        { ...before, thread: { ...before.thread, presentation: undefined } },
      );
      assert.equal((yield* projections.getThreadShell(targetId))?.presentation, "top_level");
      assert.equal(
        (yield* projections.getShellSnapshot()).threads.find((thread) => thread.id === targetId)
          ?.presentation,
        "top_level",
      );
      yield* orchestrator.dispatch({
        ...promote,
        commandId: CommandId.make(`unpromote:${targetId}`),
        presentation: "default",
      });
      const restored = yield* projections.getThreadProjection(targetId);
      assert.equal(restored.thread.presentation, "default");
      assert.deepEqual(restored.thread.lineage, before.thread.lineage);
    }
    assert.deepEqual(yield* projections.getThreadProjection(parentThreadId), parentBeforePromotion);
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`,
      outboxBefore,
    );
    const nativeThreadId = ThreadId.make("thread:native-presentation");
    yield* eventSink.write({
      events: [
        {
          type: "thread.created",
          id: EventId.make("create-native-presentation"),
          threadId: nativeThreadId,
          occurredAt: now,
          payload: { ...child.thread, id: nativeThreadId, creationSource: "provider" },
        },
      ],
    });
    const nativeError = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("promote-native-rejected"),
        threadId: nativeThreadId,
        presentation: "top_level",
      })
      .pipe(Effect.flip);
    assert.equal(nativeError._tag, "OrchestratorSubagentThreadReadOnlyError");
    assert.isUndefined((yield* projections.getThreadShell(nativeThreadId))?.presentation);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes the parent once when its delegated task asks a question", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const parentThreadId = ThreadId.make("thread:question-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-question-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:question"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-question-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:question-parent"),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-question-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research the sources",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
    const childRun = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    const requestEvent = (
      eventId: string,
      requestId: string,
      responseCapability: "live" | "message" = "message",
      kind: "user_input" | "command" = "user_input",
      run = childRun,
    ) =>
      ({
        id: EventId.make(eventId),
        type: "runtime-request.updated",
        threadId: task.childThreadId!,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(requestId),
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability:
            responseCapability === "live"
              ? { type: "live", providerSessionId: ProviderSessionId.make("session:question") }
              : { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const question = requestEvent("event:question", "request:question", "live");
    const asyncQuestion = requestEvent("event:async-question", "request:async-question");
    const answered = requestEvent("event:answered", "request:answered", "live");
    const approval = requestEvent("event:approval", "request:approval", "message", "command");
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: [question, asyncQuestion, answered, approval],
    });

    yield* reactor.handle(question);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some(
        (message) => message.notification !== undefined,
      ),
    );
    yield* reactor.handle(asyncQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      1,
    );
    yield* reactor.handle(asyncQuestion);
    yield* reactor.handle(answered);
    yield* eventSink.write({
      events: [
        {
          ...answered,
          id: EventId.make("event:answered-resolved"),
          payload: { ...answered.payload, status: "resolved", resolvedAt: now },
        },
      ],
    });
    yield* reactor.handle(answered);
    yield* reactor.handle(approval);

    const wakes = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.include(wakes[0]?.text, "asked a question and is still working");
    assert.deepEqual(
      wakes.map((message) => message.notification),
      [
        {
          source: {
            kind: "delegated_task",
            taskIds: [task.id],
            childThreadId: task.childThreadId!,
          },
          outcome: "updated",
          summary: 'Delegated task "Research the sources" has a question',
        },
      ],
    );

    const wakeRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
      (run) => run.userMessageId === wakes[0]!.id,
    )!;
    assert.equal(wakeRun.status, "queued");
    const resolved = {
      ...asyncQuestion,
      id: EventId.make("event:question-resolved"),
      payload: { ...asyncQuestion.payload, status: "resolved" as const, resolvedAt: now },
    };
    yield* eventSink.write({ events: [resolved] });
    yield* reactor.handle(resolved);
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
        (run) => run.id === wakeRun.id,
      )?.status,
      "cancelled",
    );
    const parentCompleted = {
      id: EventId.make("event:question-parent-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: parentRun.id,
      occurredAt: now,
      payload: { ...parentRun, status: "completed", completedAt: now },
    } satisfies OrchestrationV2DomainEvent;
    for (const status of [
      "preparing",
      "starting",
      "running",
      "queued",
      "cancelled",
      "rolled_back",
      "interrupted",
    ] as const) {
      yield* reactor.handle({ ...parentCompleted, payload: { ...parentRun, status } });
    }
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
      2,
    );
    yield* eventSink.write({ events: [parentCompleted] });
    for (const state of ["disposed", "pending"] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:question-task-${state}`),
            type: "subagent.updated",
            threadId: parentThreadId,
            occurredAt: now,
            payload: { ...task, completionDelivery: { state, observedByRunId: null } },
          },
        ],
      });
      yield* reactor.handle(parentCompleted);
      if (state === "disposed") {
        assert.equal(
          (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
          2,
        );
      }
    }
    yield* reactor.handle(parentCompleted);
    const caughtUp = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.equal(caughtUp.length, 2);
    assert.equal(
      caughtUp.filter((message) => message.text.includes(`requestId ${question.payload.id}.`))
        .length,
      1,
    );
    assert.include(caughtUp[1]?.text, "is blocked on a question");
    assert.isFalse(
      caughtUp.some((message) => message.text.includes(`requestId ${answered.payload.id}.`)),
    );
    yield* reactor.handle(question);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      2,
    );
    const terminalQuestion = requestEvent(
      "event:terminal-question",
      "request:terminal-question",
      "live",
    );
    yield* eventSink.write({ events: [terminalQuestion] });
    yield* reactor.handle(terminalQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      3,
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:question-parent-running-again"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "running", completedAt: null },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("terminal-question-wait-ended"),
      parentThreadId,
      taskId: task.id,
      completionWake: "always",
    });
    const upgradedQuestion = requestEvent(
      "event:upgraded-question",
      "request:upgraded-question",
      "live",
    );
    yield* eventSink.write({ events: [upgradedQuestion] });
    yield* reactor.handle(upgradedQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      4,
    );
    const waitDelivered = requestEvent("event:wait-delivered", "request:wait-delivered", "live");
    const waitDeliveredParentCompleted = {
      ...parentCompleted,
      id: EventId.make("event:wait-delivered-parent-completed"),
    };
    yield* eventSink.write({ events: [waitDelivered, waitDeliveredParentCompleted] });
    yield* reactor.handle(waitDeliveredParentCompleted);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some((message) =>
        message.text.includes(`requestId ${waitDelivered.payload.id}.`),
      ),
    );
    yield* eventSink.write({
      commandId: CommandId.make("command:runtime-reconcile:question-followup"),
      events: [
        {
          id: EventId.make("event:question-child-completed"),
          type: "run.updated",
          threadId: task.childThreadId!,
          occurredAt: now,
          payload: { ...childRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("event:question-task-completed"),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "Sources researched.",
            completedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("question-followup"),
      threadId: task.childThreadId!,
      messageId: MessageId.make("message:question-followup"),
      text: "Check the sources again",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const followup = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs.find(
      (run) => run.userMessageId === "message:question-followup",
    )!;
    assert.isDefined(followup.delegatedTaskId);
    assert.notEqual(followup.delegatedTaskId, task.id);
    const followupQuestion = requestEvent(
      "event:followup-question",
      "request:followup-question",
      "live",
      "user_input",
      followup,
    );
    yield* eventSink.write({ events: [followupQuestion] });
    yield* reactor.handle(followupQuestion);
    const followupWake = (yield* projections.getThreadRecords(parentThreadId, [
      "messages",
    ])).messages.find((message) =>
      message.text.includes(`requestId ${followupQuestion.payload.id}`),
    )!;
    assert.deepEqual(followupWake.notification?.source, {
      kind: "delegated_task",
      taskIds: [followup.delegatedTaskId],
      childThreadId: task.childThreadId!,
    });
  }).pipe(Effect.provide(DelegatedTaskQuestionReactor.layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect.each([false, true])("rejects thread.create for an existing id (deleted: %s)", (deleted) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:duplicate-create:${deleted}`);
    const create = {
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      importedNativeThread: {
        ref: { driver: adapter.driver, nativeId: "native-original", strength: "strong" },
      },
    } as const;
    yield* orchestrator.dispatch(create);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`fork-source:${threadId}`),
      threadId,
      messageId: MessageId.make(`fork-source:${threadId}`),
      text: "Completed fork source",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const sourceRun = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make(`complete-fork-source:${threadId}`),
      type: "run.updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: { ...sourceRun, status: "completed", completedAt: yield* DateTime.now },
    });
    if (deleted) {
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`delete:${threadId}`),
        threadId,
      });
    }
    const before = yield* projections.getThread(threadId);
    assert.isNotNull(before.activeProviderThreadId);
    assert.equal(before.deletedAt !== null, deleted);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* TestClock.adjust("1 second");
    const duplicate = {
      ...create,
      commandId: CommandId.make(`duplicate:${threadId}`),
      title: "Replacement",
      importedNativeThread: undefined,
    };
    const outcome = yield* orchestrator.dispatch(duplicate).pipe(Effect.result);
    assert.ok(Result.isFailure(outcome), "duplicate create must be rejected");
    const refused = outcome.failure;
    assert.equal(refused._tag, "OrchestratorThreadAlreadyExistsError");
    assert.equal(refused.message, `Thread ${threadId} already exists. Use a new thread id.`);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
    const retried = yield* orchestrator.dispatch(duplicate).pipe(Effect.flip);
    assert.equal(retried._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.include(retried.message, refused.message);
    const duplicateFork = yield* orchestrator
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`duplicate-fork:${threadId}`),
        sourceThreadId: threadId,
        targetThreadId: threadId,
        sourcePoint: { type: "run", runId: sourceRun.id },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.result);
    assert.ok(
      Result.isFailure(duplicateFork),
      "fork cannot overwrite a live or tombstoned identity",
    );
    assert.equal(duplicateFork.failure._tag, "OrchestratorThreadAlreadyExistsError");
    assert.deepEqual(yield* projections.getThread(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays a thread.create receipt without changing the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:create-receipt-replay");
    const create = {
      type: "thread.create",
      commandId: CommandId.make("create:receipt-replay"),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const original = yield* orchestrator.dispatch(create);
    const before = yield* projections.getThread(threadId);
    const replayed = yield* orchestrator.dispatch(create);
    assert.equal(replayed.sequence, original.sequence);
    assert.equal(original.replayed, false);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.storedEvents, original.storedEvents);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), original.sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("explicit settle clears snooze atomically and stays idempotent after re-snoozing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:settle-snoozed");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-snoozed"),
      threadId,
      projectId: ProjectId.make("project:settle-snoozed"),
      title: "Snoozed thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const settledAt = DateTime.add(now, { seconds: 1 });
    const snoozedUntil = DateTime.add(now, { hours: 1 });
    for (const round of [1, 2]) {
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze-before-settle-${round}`),
        threadId,
        snoozedUntil: DateTime.formatIso(snoozedUntil),
      });
      assert.deepInclude(yield* projections.getThread(threadId), {
        snoozedUntil,
        snoozedAt: yield* DateTime.now,
      });
      yield* TestClock.adjust("1 second");
      const commandId = CommandId.make(`settle-snoozed-${round}`);
      yield* orchestrator.dispatch({ type: "thread.settle", commandId, threadId });
      const expected = {
        settledOverride: "settled",
        settledAt,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: yield* DateTime.now,
      } as const;
      const committed = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.lengthOf(committed, 1);
      assert.equal(committed[0]?.event.type, "thread.settled");
      assert.deepInclude(committed[0]?.event.payload, expected);
      const settled = yield* projections.getThreadShell(threadId);
      assert.deepInclude(settled, expected);
      assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, expected);

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle-again-${round}`),
        threadId,
      });
      assert.deepEqual(yield* projections.getThreadShell(threadId), settled);
    }
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle-after-snooze"),
      threadId,
      reason: "user",
    });
    const active = {
      settledOverride: "active",
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
    } as const;
    assert.deepInclude(yield* projections.getThreadShell(threadId), active);
    assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, active);
  }).pipe(Effect.provide(layerTest)),
);
