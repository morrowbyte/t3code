import { assert, it, vi } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
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
  type OrchestrationV2ThreadProjection,
  type ApprovalReviewAuthority,
  type AuthEnvironmentScope,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import { hashTelemetryId as hash } from "@t3tools/shared/telemetryId";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
import * as ApprovalReviewCommands from "./ApprovalReviewCommands.ts";
import * as ApprovalReviewOrderPolicy from "./ApprovalReviewOrderPolicy.ts";
import * as ApprovalReviewService from "./ApprovalReviewService.ts";
import * as HostOrders from "./ApprovalReviewHostOrders.ts";
import { frozenReview } from "./ApprovalReviewPackage.ts";
import { privilegedCommandHash } from "./PrivilegedCommandPackage.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as PrivilegedCommandService from "./PrivilegedCommandService.ts";
import * as PrivilegedCommandCommands from "./PrivilegedCommandCommands.ts";
import * as PrivilegedCommandExecutor from "../privilegedCommands/PrivilegedCommandExecutor.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const recoverySource = "def execute(request):\n    raise RuntimeError('inert recovery test')\n";
const recoveryTarget = {
  verifiedTargetId: "recovery-fixture",
  requesterSubject: "recovery-requester",
  workerSubject: "recovery-worker",
  approverSessionId: AuthSessionId.make("recovery-human-fixture"),
  approverSubject: "recovery-human",
  allowedPath: "/tmp/recovery-fixture-never-created.txt",
  implementationVersion: "recovery-test-v1",
  implementationSource: recoverySource,
};
const recoveryDatabase = Sqlite.layerMemory;
const layerExternalRecovery = Layer.mergeAll(
  ProviderRuntimeRecovery.layer,
  ApprovalReviewService.layer,
).pipe(
  Layer.provide(Layer.mock(HostOrders.ApprovalReviewHostOrders)({})),
  Layer.provideMerge(
    Layer.mergeAll(
      recoveryDatabase,
      ProjectionStore.layer.pipe(Layer.provide(recoveryDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(recoveryDatabase)),
      IdAllocator.layer,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
      ProviderReplayHarness.layerWithRegistry(
        { name: "external-approval-recovery" },
        ProviderAdapterRegistry.layerFromAdapters([]),
        {
          databaseLayer: recoveryDatabase,
          runEffectWorker: false,
        },
      ),
    ),
  ),
  Layer.provide(Layer.succeed(ApprovalReviewService.ApprovalReviewTargets, [recoveryTarget])),
  Layer.provide(
    Layer.succeed(ApprovalReviewOrderPolicy.ApprovalReviewOrderPolicy, {
      enabled: true,
      humans: [],
      channels: [],
    }),
  ),
);

it.effect("commits a confirmed result and its cleanup receipt atomically", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:confirmed-cleanup"),
      runId = RunId.make("run:confirmed-cleanup");
    const requestId = RuntimeRequestId.make("privileged-command:confirmed-cleanup"),
      instanceId = ProviderInstanceId.make("unconfigured");
    const modelSelection = { instanceId, model: "unused" },
      claimId = "claim-confirmed-cleanup";
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:confirmed-cleanup"),
      threadId,
      projectId: ProjectId.make("project:confirmed-cleanup"),
      title: "Cleanup",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const bundle = {
      environmentId: EnvironmentId.make("env"),
      threadId,
      runId,
      providerSessionId: "session",
      purpose: "Repair",
      script: "inert",
      shell: "sh" as const,
      cwd: "/tmp",
      timeoutMs: 1000,
    };
    const packageHash = privilegedCommandHash(requestId, bundle);
    yield* events.write({
      events: [
        {
          id: EventId.make("event:confirmed-run"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:confirmed"),
            rootNodeId: NodeId.make("node:confirmed-root"),
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("event:confirmed-request"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make("node:confirmed"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "resolved",
            decision: "accept",
            responseCapability: { type: "external" },
            createdAt: now,
            resolvedAt: now,
            privilegedCommand: { bundle, packageHash, state: "approved" },
          },
        },
      ],
    });
    const claimCommandId = CommandId.make(`privileged-command-claim:${claimId}`);
    yield* orchestrator.dispatch({
      type: "privileged-command.claim",
      commandId: claimCommandId,
      threadId,
      requestId,
      packageHash,
      claimId,
      recoveryIdentity: {
        platform: "linux",
        bootId: "boot-fixture",
        processId: 123,
        processStart: "start-fixture",
      },
    });
    const [cleanup] = yield* outbox.listByCommandId(claimCommandId);
    assert.equal(cleanup?.request.type, "privileged-command.cleanup");
    if (cleanup?.request.type !== "privileged-command.cleanup")
      return assert.fail("missing cleanup");
    assert.equal(cleanup.request.identity.bootId, "boot-fixture");
    assert.equal(cleanup.request.identity.processId, 123);
    assert.equal(cleanup.request.identity.processStart, "start-fixture");
    assert.deepEqual(
      (yield* store.getRuntimeRequest(threadId, requestId))?.privilegedCommand?.recoveryIdentity,
      cleanup.request.identity,
    );
    yield* orchestrator.dispatch({
      type: "privileged-command.result",
      commandId: CommandId.make("command:confirmed-result"),
      threadId,
      requestId,
      packageHash,
      claimId,
      cleanupConfirmed: true,
      result: { status: "succeeded", exitCode: 0, stdout: "", stderr: "" },
    });
    assert.equal(
      (yield* store.getRuntimeRequest(threadId, requestId))?.privilegedCommand?.state,
      "completed",
    );
    assert.equal(Option.getOrUndefined(yield* outbox.get(cleanup.id))?.status, "succeeded");
  }).pipe(Effect.provide(layerExternalRecovery)),
);

it.effect.each(["process-loss", "interrupted", "other-request"] as const)(
  "keeps later work blocked until cleanup is confirmed after %s",
  (mode) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:cleanup-recovery");
      const requestId = RuntimeRequestId.make("privileged-command:cleanup-recovery");
      const laterId = RuntimeRequestId.make("privileged-command:later");
      yield* outbox.enqueue([
        {
          id: "effect:cleanup-old",
          commandId: CommandId.make("command:cleanup-old"),
          threadId,
          request: { type: "privileged-command.execute", requestId, packageHash: "a".repeat(64) },
        },
      ]);
      assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "before-crash" })));
      yield* outbox.enqueue([
        {
          id: "effect:cleanup-barrier",
          commandId: CommandId.make("command:cleanup-barrier"),
          threadId,
          request: {
            type: "privileged-command.cleanup",
            requestId:
              mode === "other-request"
                ? RuntimeRequestId.make("privileged-command:other")
                : requestId,
            shell: "sh",
            identity: {
              platform: "linux",
              bootId: "test-boot",
            },
          },
        },
      ]);
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "before-stop" })));
      if (mode === "process-loss") {
        yield* outbox.reconcileAfterProcessLoss;
      } else {
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["privileged-command.execute"],
          privilegedRequestIds: [requestId],
          reason: "Thread was stopped.",
        });
      }
      assert.equal(
        Option.getOrUndefined(yield* outbox.get("effect:cleanup-old"))?.status,
        mode === "process-loss" ? "cancelled" : "running",
      );
      yield* outbox.enqueue([
        {
          id: "effect:cleanup-later",
          commandId: CommandId.make("command:cleanup-later"),
          threadId,
          request: {
            type: "privileged-command.execute",
            requestId: laterId,
            packageHash: "b".repeat(64),
          },
        },
      ]);
      let confirmed = false;
      let cleanupAttempts = 0;
      const workerLayer = EffectWorker.layerWithOptions({
        workerId: "cleanup-recovery",
        maxAttempts: 1,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
            Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
              execute: (effect) => {
                assert.equal(effect.request.type, "privileged-command.cleanup");
                cleanupAttempts += 1;
                return confirmed
                  ? Effect.void
                  : Effect.fail(
                      new EffectWorker.OrchestrationEffectExecutionError({
                        effectId: effect.id,
                        effectType: effect.request.type,
                      }),
                    );
              },
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.runOnce;
        assert.equal(
          Option.getOrUndefined(yield* outbox.get("effect:cleanup-barrier"))?.status,
          "pending",
        );
        assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "blocked" })));
        if (mode === "other-request") {
          assert.equal(cleanupAttempts, 0);
          return;
        }
        yield* TestClock.adjust(100);
        confirmed = true;
        yield* worker.runOnce;
      }).pipe(Effect.provide(workerLayer));
      if (mode === "other-request") return;
      assert.equal(cleanupAttempts, 2);
      if (mode === "interrupted") {
        assert.isTrue(
          Option.isNone(yield* outbox.claimNext({ workerId: "before-execution-exit" })),
        );
        assert.isTrue(
          yield* outbox.finishCancellation({
            effectId: "effect:cleanup-old",
            workerId: "before-crash",
          }),
        );
      }
      assert.equal(
        Option.getOrUndefined(yield* outbox.claimNext({ workerId: "after-cleanup" }))?.id,
        "effect:cleanup-later",
      );
      const priorityThread = ThreadId.make("thread:cleanup-priority");
      yield* outbox.enqueue([
        {
          id: "effect:older-pending",
          commandId: CommandId.make("command:older-pending"),
          threadId: priorityThread,
          request: {
            type: "privileged-command.execute",
            requestId: laterId,
            packageHash: "b".repeat(64),
          },
        },
        {
          id: "effect:newer-cleanup",
          commandId: CommandId.make("command:newer-cleanup"),
          threadId: priorityThread,
          request: {
            type: "privileged-command.cleanup",
            requestId,
            shell: "sh",
            identity: {
              platform: "linux",
              bootId: "test-boot",
              processId: 123,
              processStart: "start-fixture",
            },
          },
        },
      ]);
      assert.equal(
        Option.getOrUndefined(yield* outbox.claimNext({ workerId: "priority" }))?.id,
        "effect:newer-cleanup",
      );
    }).pipe(Effect.provide(layerExternalRecovery)),
);

it.effect("stopping an old run cancels only its privileged outbox request", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:stop-old-run"),
      oldRun = RunId.make("run:old"),
      newRun = RunId.make("run:new");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:stop-old-run"),
      threadId,
      projectId: ProjectId.make("project:stop-old-run"),
      title: "Stop",
      modelSelection: { instanceId: ProviderInstanceId.make("unconfigured"), model: "unused" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const ids = [
      RuntimeRequestId.make("privileged-command:old"),
      RuntimeRequestId.make("privileged-command:new"),
    ];
    const bundles = [oldRun, newRun].map((runId) => ({
      environmentId: EnvironmentId.make("env"),
      threadId,
      runId,
      providerSessionId: "session",
      purpose: "Repair",
      script: "inert",
      shell: "sh" as const,
      cwd: "/tmp",
      timeoutMs: 1000,
    }));
    yield* events.write({
      events: ids.map((id, index) => ({
        id: EventId.make(`event:stop-old:${index}`),
        type: "runtime-request.updated" as const,
        threadId,
        occurredAt: now,
        payload: {
          id,
          nodeId: NodeId.make(`node:stop-old:${index}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "resolved" as const,
          decision: "accept" as const,
          responseCapability: { type: "external" as const },
          createdAt: now,
          resolvedAt: now,
          privilegedCommand: {
            bundle: bundles[index]!,
            packageHash: privilegedCommandHash(id, bundles[index]!),
            state: "approved" as const,
          },
        },
      })),
    });
    yield* outbox.enqueue(
      ids.map((id, index) => ({
        id: `effect:stop-old:${index}`,
        commandId: CommandId.make(`command:stop-old:${index}`),
        threadId,
        request: {
          type: "privileged-command.execute" as const,
          requestId: id,
          packageHash: privilegedCommandHash(id, bundles[index]!),
        },
      })),
    );
    const planned = yield* PrivilegedCommandCommands.stop({ threadId, runId: oldRun }).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
    );
    const requestIds = planned.flatMap((event) =>
      event.type === "runtime-request.updated"
        ? [(event.payload as import("@t3tools/contracts").OrchestrationV2RuntimeRequest).id]
        : [],
    );
    yield* events.commitCommand({
      commandId: CommandId.make("command:stop-old"),
      commandType: "run.interrupt",
      threadId,
      acceptedAt: now,
      events: planned.map((event, index) => ({
        ...event,
        id: EventId.make(`event:stop-old-result:${index}`),
      })) as import("@t3tools/contracts").OrchestrationV2DomainEvent[],
      effects: [],
      cancelUnsettledEffects: {
        effectTypes: ["privileged-command.execute"],
        privilegedRequestIds: requestIds,
        reason: "stopped",
      },
    });
    assert.equal(
      (yield* store.getRuntimeRequest(threadId, ids[0]!))?.privilegedCommand?.state,
      "unknown",
    );
    assert.equal(
      (yield* store.getRuntimeRequest(threadId, ids[1]!))?.privilegedCommand?.state,
      "approved",
    );
    assert.equal(
      Option.getOrUndefined(yield* outbox.get("effect:stop-old:0"))?.status,
      "cancelled",
    );
    assert.equal(Option.getOrUndefined(yield* outbox.get("effect:stop-old:1"))?.status, "pending");
  }).pipe(Effect.provide(layerExternalRecovery)),
);

it.effect.each(["approved", "claimed"] as const)(
  "marks a %s privileged command unknown after restart without re-executing it",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const threadId = ThreadId.make("thread:privileged-recovery");
      const requestId = RuntimeRequestId.make("privileged-command:recovery");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:privileged-recovery"),
        threadId,
        projectId: ProjectId.make("project:privileged-recovery"),
        title: "Recovery",
        modelSelection: { instanceId: ProviderInstanceId.make("unconfigured"), model: "unused" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const now = yield* DateTime.now;
      const bundle = {
        environmentId: EnvironmentId.make("env"),
        threadId,
        runId: RunId.make("run:lost"),
        providerSessionId: "session",
        purpose: "Repair",
        script: "inert fixture",
        shell: "sh" as const,
        cwd: "/tmp",
        timeoutMs: 1000,
      };
      yield* events.write({
        events: [
          {
            id: EventId.make("event:privileged-recovery"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: NodeId.make("node:privileged-recovery"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "resolved",
              decision: "accept",
              responseCapability: { type: "external" },
              createdAt: now,
              resolvedAt: now,
              privilegedCommand: {
                bundle,
                packageHash: privilegedCommandHash(requestId, bundle),
                state,
              },
            },
          },
          {
            id: EventId.make("event:privileged-recovery-item"),
            type: "turn-item.updated",
            threadId,
            nodeId: NodeId.make("node:privileged-recovery"),
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:privileged-recovery"),
              threadId,
              runId: bundle.runId,
              nodeId: NodeId.make("node:privileged-recovery"),
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "waiting",
              title: "Run one privileged script",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "approval_request",
              requestId,
              requestKind: "command",
              prompt: "Repair",
              privilegedCommand: {
                bundle,
                packageHash: privilegedCommandHash(requestId, bundle),
                state,
              },
            },
          },
        ],
      });
      yield* recovery.reconcile("startup");
      const request = yield* projections.getRuntimeRequest(threadId, requestId);
      assert.equal(request?.privilegedCommand?.state, "unknown");
      assert.equal(request?.privilegedCommand?.result?.status, "unknown");
      const item = (yield* projections.getRuntimeResponseContext(threadId, requestId)).item;
      assert.equal(item?.status, state === "claimed" ? "waiting" : "cancelled");
      if (state === "claimed") assert.isNull(item?.completedAt);
      yield* recovery.reconcile("startup");
      assert.equal(
        (yield* projections.getRuntimeRequest(threadId, requestId))?.privilegedCommand?.state,
        "unknown",
      );
    }).pipe(Effect.provide(layerExternalRecovery)),
);

it.effect(
  "serializes competing privileged claims and never replays a claimed execution after recovery",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:privileged-claim-race");
      const runId = RunId.make("run:privileged-claim-race");
      const requestId = RuntimeRequestId.make("privileged-command:race");
      const environmentId = EnvironmentId.make("race-environment");
      const instanceId = ProviderInstanceId.make("unconfigured");
      const modelSelection = { instanceId, model: "unused" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:privileged-race"),
        threadId,
        projectId: ProjectId.make("project:privileged-race"),
        title: "Race",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const now = yield* DateTime.now;
      const bundle = {
        environmentId,
        threadId,
        runId,
        providerSessionId: "session",
        purpose: "Repair",
        script: "inert fixture",
        shell: "sh" as const,
        cwd: "/tmp",
        timeoutMs: 1000,
      };
      const packageHash = privilegedCommandHash(requestId, bundle);
      yield* events.write({
        events: [
          {
            id: EventId.make("event:privileged-race-run"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:race"),
              rootNodeId: NodeId.make("node:root-race"),
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("event:privileged-race-request"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: NodeId.make("node:privileged-race"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "external" },
              createdAt: now,
              resolvedAt: null,
              privilegedCommand: { bundle, packageHash, state: "pending" },
            },
          },
        ],
      });
      yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("decision:privileged-race"),
          threadId,
          requestId,
          decision: "accept",
          packageHash,
        })
        .pipe(
          Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
            sessionId: AuthSessionId.make("human"),
            subject: "owner",
            method: "browser-session-cookie",
          }),
        );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const startedAgain = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupRelease = yield* Deferred.make<void>();
      let starts = 0;
      const serviceLayer = PrivilegedCommandService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              ownsMcpCredential: () => Effect.succeed(true),
            }),
            Layer.succeed(EventSink.EventSinkV2, events),
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Layer.succeed(PrivilegedCommandExecutor.PrivilegedCommandExecutor, {
              captureRecoveryIdentity: () =>
                Effect.succeed({
                  platform: "linux" as const,
                  bootId: "test-boot",
                  processId: 123,
                  processStart: "start-fixture",
                }),
              cleanup: () => Effect.succeed({ status: "confirmed" as const }),
              validate: () => Effect.void,
              execute: () =>
                Effect.gen(function* () {
                  starts += 1;
                  yield* Deferred.succeed(started, undefined);
                  if (starts > 1) yield* Deferred.succeed(startedAgain, undefined);
                  yield* Deferred.await(release).pipe(
                    Effect.onInterrupt(() =>
                      starts > 1
                        ? Deferred.succeed(cleanupStarted, undefined).pipe(
                            Effect.andThen(Deferred.await(cleanupRelease)),
                          )
                        : Effect.die(new Error("cleanup finalizer failed")),
                    ),
                  );
                  return { status: "succeeded" as const, exitCode: 0, stdout: "", stderr: "" };
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* PrivilegedCommandService.PrivilegedCommandService;
        const input = { threadId, requestId, packageHash };
        const finished =
          yield* Deferred.make<Exit.Exit<void, import("@t3tools/contracts").ApprovalReviewError>>();
        const attempt = service.executeApproved(input).pipe(
          Effect.exit,
          Effect.tap((result) => Deferred.succeed(finished, result)),
        );
        const first = yield* attempt.pipe(Effect.forkScoped);
        const second = yield* attempt.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        assert.isTrue(Exit.isFailure(yield* Deferred.await(finished)));
        assert.equal(starts, 1);
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.privilegedCommand?.state,
          "claimed",
        );
        yield* recovery.reconcile("startup");
        const recoveredClaim = (yield* projections.getRuntimeRequest(threadId, requestId))
          ?.privilegedCommand?.claimId;
        const recoveredCleanup = (yield* outbox.listByCommandId(
          CommandId.make(`privileged-command-claim:${recoveredClaim}`),
        ))[0];
        assert.equal(recoveredCleanup?.status, "pending");
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.privilegedCommand?.state,
          "unknown",
        );
        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        if (recoveredCleanup === undefined) return assert.fail("cleanup barrier missing");
        assert.equal(
          Option.getOrUndefined(yield* outbox.get(recoveredCleanup.id))?.status,
          "pending",
        );
        const cleanupClaim = yield* outbox.claimNext({
          workerId: "recovery-cleanup-test",
        });
        assert.isTrue(Option.isSome(cleanupClaim));
        if (Option.isNone(cleanupClaim)) return assert.fail("cleanup barrier missing");
        yield* outbox.succeed({
          effectId: cleanupClaim.value.id,
          workerId: "recovery-cleanup-test",
        });
        yield* service.executeApproved(input);
        assert.equal(starts, 1);
        const staleId = RuntimeRequestId.make("privileged-command:stale");
        const staleHash = privilegedCommandHash(staleId, bundle);
        yield* events.write({
          events: [
            {
              id: EventId.make("event:privileged-stale"),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: staleId,
                nodeId: NodeId.make("node:privileged-stale"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: { type: "external" },
                createdAt: now,
                resolvedAt: null,
                privilegedCommand: { bundle, packageHash: staleHash, state: "pending" },
              },
            },
          ],
        });
        const stale = yield* Effect.exit(
          orchestrator
            .dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("decision:stale"),
              threadId,
              requestId: staleId,
              decision: "accept",
              packageHash: staleHash,
            })
            .pipe(
              Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
                sessionId: AuthSessionId.make("human"),
                subject: "owner",
                method: "browser-session-cookie",
              }),
            ),
        );
        assert.isTrue(Exit.isFailure(stale));
        // A new active job runs through the real outbox worker. Stop must interrupt it,
        // but retain its thread slot until the executor's cleanup has actually finished.
        const priorRun = (yield* projections.getThreadRecords(threadId, ["runs"])).runs.find(
          (run) => run.id === runId,
        );
        if (priorRun === undefined) return assert.fail("missing run");
        const stopId = RuntimeRequestId.make("privileged-command:stop");
        const stopHash = privilegedCommandHash(stopId, bundle);
        const stopProviderThreadId = ProviderThreadId.make("provider-thread:storage-stop");
        const stopProviderTurnId = ProviderTurnId.make("provider-turn:storage-stop");
        const stopRootId = NodeId.make("node:root-race");
        yield* events.write({
          events: [
            {
              id: EventId.make("event:privileged-stop-run"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                ...priorRun,
                status: "running",
                completedAt: null,
                providerThreadId: stopProviderThreadId,
              },
            },
            {
              id: EventId.make("event:storage-stop-root"),
              type: "node.updated",
              threadId,
              runId,
              nodeId: stopRootId,
              occurredAt: now,
              payload: {
                id: stopRootId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId: stopRootId,
                kind: "root_turn",
                status: "running",
                countsForRun: true,
                providerThreadId: stopProviderThreadId,
                providerTurnId: stopProviderTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("event:storage-stop-provider-thread"),
              type: "provider-thread.updated",
              threadId,
              nodeId: stopRootId,
              occurredAt: now,
              payload: {
                id: stopProviderThreadId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: stopRootId,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("event:storage-stop-provider-turn"),
              type: "provider-turn.updated",
              threadId,
              nodeId: stopRootId,
              occurredAt: now,
              payload: {
                id: stopProviderTurnId,
                providerThreadId: stopProviderThreadId,
                nodeId: stopRootId,
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("event:privileged-stop-request"),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: stopId,
                nodeId: NodeId.make("node:privileged-stop"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: { type: "external" },
                createdAt: now,
                resolvedAt: null,
                privilegedCommand: { bundle, packageHash: stopHash, state: "pending" },
              },
            },
          ],
        });
        const decisionId = CommandId.make("decision:privileged-stop");
        yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: decisionId,
            threadId,
            requestId: stopId,
            decision: "accept",
            packageHash: stopHash,
          })
          .pipe(
            Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
              sessionId: AuthSessionId.make("human"),
              subject: "owner",
              method: "browser-session-cookie",
            }),
          );
        const rows = yield* outbox.listByCommandId(decisionId);
        const queued = rows.find((row) => row.request.type === "privileged-command.execute");
        if (queued === undefined) return assert.fail("missing outbox effect");
        const workerLayer = EffectWorker.layerWithOptions({
          workerId: "privileged-stop-test",
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
                execute: (effect) =>
                  effect.request.type === "privileged-command.execute"
                    ? service
                        .executeApproved({
                          threadId: effect.threadId,
                          requestId: effect.request.requestId,
                          packageHash: effect.request.packageHash,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new EffectWorker.OrchestrationEffectExecutionError({
                                effectId: effect.id,
                                effectType: effect.request.type,
                                cause,
                              }),
                          ),
                        )
                    : Effect.void,
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const executing = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(startedAgain);
          yield* ProviderTurnStartService.storageRunInterrupt(orchestrator)({
            threadId,
            runId,
            reason: "Storage pressure fixture",
          });
          assert.equal(
            (yield* projections.getRuntimeRequest(threadId, stopId))?.privilegedCommand?.state,
            "unknown",
          );
          yield* Deferred.await(cleanupStarted);
          assert.equal(Option.getOrUndefined(yield* outbox.get(queued.id))?.status, "running");
          assert.equal(
            (yield* projections.getRuntimeRequest(threadId, stopId))?.privilegedCommand?.state,
            "unknown",
          );
          const stopClaim = (yield* projections.getRuntimeRequest(threadId, stopId))
            ?.privilegedCommand?.claimId;
          const stopCleanup = (yield* outbox.listByCommandId(
            CommandId.make(`privileged-command-claim:${stopClaim}`),
          ))[0];
          if (stopCleanup === undefined) return assert.fail("stop cleanup barrier missing");
          assert.equal(stopCleanup.status, "pending");
          yield* Deferred.succeed(cleanupRelease, undefined);
          yield* Fiber.join(executing);
          assert.equal(Option.getOrUndefined(yield* outbox.get(queued.id))?.status, "cancelled");
          assert.equal(
            Option.getOrUndefined(yield* outbox.get(stopCleanup.id))?.status,
            "succeeded",
          );
          assert.equal(
            (yield* projections.getRuntimeRequest(threadId, stopId))?.privilegedCommand?.state,
            "unknown",
          );
          assert.equal(starts, 2);
        }).pipe(Effect.provide(workerLayer));
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(layerExternalRecovery)),
);

it.effect.each([false, true] as const)(
  "preserves external approval through shutdown and startup with SQLite/EventSink (expired=%s)",
  (expired) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const service = yield* ApprovalReviewService.ApprovalReviewService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const threadId = ThreadId.make("thread:external-approval-recovery");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:external-approval-recovery"),
        threadId,
        projectId: ProjectId.make("project:external-approval-recovery"),
        title: "External approval recovery",
        modelSelection: { instanceId: ProviderInstanceId.make("unconfigured"), model: "unused" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const createdAt = yield* DateTime.now;
      // Existing external requests must survive recovery even when their legacy source
      // cannot enter the current host-bound submission endpoint.
      const requestId = RuntimeRequestId.make("approval-review:legacy-recovery-one");
      const input = {
        threadId,
        requestId,
        expiresAt: DateTime.toEpochMillis(createdAt) + 60_000,
        action: {
          kind: "create_file_once",
          verifiedTargetId: recoveryTarget.verifiedTargetId,
          path: recoveryTarget.allowedPath,
          content: "inert fixture",
          mode: 384,
          expectedAbsent: true,
          implementationVersion: recoveryTarget.implementationVersion,
          implementationHash: hash(recoverySource),
        } satisfies ApprovalReviewAuthority["action"],
      };
      const review = frozenReview(input, recoveryTarget);
      const authority = {
        packageHash: review.packageHash,
        verifiedTargetId: recoveryTarget.verifiedTargetId,
        expiresAt: input.expiresAt,
        state: "pending",
        approverSessionId: recoveryTarget.approverSessionId,
        approverSubject: recoveryTarget.approverSubject,
        requesterSubject: recoveryTarget.requesterSubject,
        workerSubject: recoveryTarget.workerSubject,
        action: input.action,
        implementationSource: recoverySource,
        provenance: { status: "unverified", reason: "missing-original" },
      } satisfies ApprovalReviewAuthority;
      yield* orchestrator.dispatch({
        type: "approval-review.submit",
        commandId: CommandId.make("submit:legacy-recovery-one"),
        threadId,
        requestId,
        nodeId: NodeId.make("node:legacy-recovery-one"),
        turnItemId: TurnItemId.make("item:legacy-recovery-one"),
        authority,
        prompt: review.prompt,
      });
      const submitted = { threadId, requestId, authority };
      const requester: EnvironmentSessionPrincipalShape = {
        sessionId: AuthSessionId.make("legacy-recovery-reader"),
        subject: recoveryTarget.requesterSubject,
        method: "dpop-access-token",
        proofKeyThumbprint: "r".repeat(43),
        scopes: new Set<AuthEnvironmentScope>(["approval-review:request"]),
      };
      const nativeId = RuntimeRequestId.make("native-request:lost-callback");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:native-request:lost-callback"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: createdAt,
            payload: {
              id: nativeId,
              nodeId: NodeId.make("node:native-request"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make("lost-session"),
              },
              createdAt,
              resolvedAt: null,
            },
          },
        ],
      });
      if (expired) yield* TestClock.adjust(60_001);
      yield* recovery.prepareForShutdown;
      assert.equal((yield* recovery.reconcile("shutdown")).closedRequests, 1);
      assert.equal((yield* recovery.recover).closedRequests, 0);
      const request = yield* projections.getRuntimeRequest(threadId, submitted.requestId);
      assert.isDefined(request);
      if (request === undefined)
        return assert.fail("Persisted external request must survive restart");
      assert.equal(request.status, "pending");
      assert.equal(request.responseCapability.type, "external");
      assert.isNull(request.resolvedAt);
      assert.deepEqual(yield* service.read(submitted, requester), submitted.authority);
      const context = yield* projections.getRuntimeResponseContext(threadId, submitted.requestId);
      assert.equal(context.node?.status, "waiting");
      assert.equal(context.item?.status, "waiting");
      assert.equal(
        context.item?.type === "approval_request" && context.item.approvalReview?.packageHash,
        submitted.authority.packageHash,
      );
      const native = yield* projections.getRuntimeRequest(threadId, nativeId);
      assert.equal(native?.status, "cancelled");
      assert.equal(native?.responseCapability.type, "not_resumable");
      if (expired) {
        const error = yield* ApprovalReviewCommands.resolve(
          request,
          {
            type: "runtime-request.respond",
            commandId: CommandId.make("expired-recovery-attempt"),
            threadId,
            requestId: submitted.requestId,
            packageHash: submitted.authority.packageHash,
            decision: "accept",
          },
          yield* DateTime.now,
        ).pipe(
          Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
            sessionId: recoveryTarget.approverSessionId,
            subject: recoveryTarget.approverSubject,
          }),
          Effect.flip,
        );
        assert.equal(error.reason, "expired");
        assert.equal(
          (yield* service
            .claim(
              {
                threadId,
                requestId: submitted.requestId,
                packageHash: submitted.authority.packageHash,
                verifiedTargetId: recoveryTarget.verifiedTargetId,
                claimId: "expired-claim-attempt",
              },
              recoveryTarget.workerSubject,
            )
            .pipe(Effect.flip)).reason,
          "expired",
        );
      }
      assert.equal(
        (yield* projections.getRuntimeRequest(threadId, submitted.requestId))?.status,
        "pending",
      );
    }).pipe(Effect.provide(layerExternalRecovery)),
);

it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
    },
  );
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_orphaned"),
        nodeId: NodeId.make("node_orphaned"),
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "old process" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    assert.equal(command?.events[0]?.type, "runtime-request.updated");
    if (command?.events[0]?.type === "runtime-request.updated") {
      assert.equal(command.events[0].payload.status, "expired");
      assert.equal(command.events[0].payload.responseCapability.type, "not_resumable");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("preserves async questions across startup and shutdown", () => {
  const threadId = ThreadId.make("async-recovery-thread");
  const nodeId = NodeId.make("async-recovery-node");
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("async-recovery-request"),
        nodeId,
        status: "pending",
        responseCapability: { type: "message" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const commitCommand = vi.fn(() => Effect.die("an async question needs no process-loss write"));
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    assert.equal((yield* recovery.reconcile("startup")).closedRequests, 0);
    assert.equal((yield* recovery.reconcile("startup")).closedRequests, 0);
    assert.isFalse(commitCommand.mock.calls.length > 0);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "preserves a replayable waiting run while cancelling its process-bound background work",
  () => {
    const threadId = ThreadId.make("thread_waiting_checkpoint");
    const runId = RunId.make("run_waiting_checkpoint");
    const providerThreadId = ProviderThreadId.make("provider_thread_waiting_checkpoint");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const backgroundItemId = TurnItemId.make("turn_item_waiting_checkpoint");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId,
          status: "idle",
          pendingBackgroundTasks: [
            { taskId: String(backgroundItemId), description: "Finish background task" },
          ],
        },
      ],
      runs: [{ id: runId, status: "waiting", providerInstanceId, providerThreadId }],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: backgroundItemId,
          runId,
          nodeId: null,
          providerThreadId,
          type: "command_execution",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({
                committed: true,
                cancelledEffectCount: 0,
              } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () =>
              Effect.succeed([
                {
                  request: { type: "checkpoint.capture", runId },
                  status: "running",
                },
              ] as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.requeuedEffects, 1);

      const command = committedInput;
      assert.isNotNull(command);
      if (command === null) return;

      assert.isFalse(command.events.some((event) => event.type === "run.updated"));
      const recorded = command.events.flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );

      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId, kinds: ["shell"] }],
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === backgroundItemId &&
            event.payload.status === "cancelled",
        ),
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.id === providerThreadId &&
            event.payload.pendingBackgroundTasks?.length === 0,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "records cancelled work on the provider thread that lost it after a provider switch",
  () => {
    const threadId = ThreadId.make("thread_switch_note");
    const claudeRunId = RunId.make("run_switch_note_claude");
    const codexRunId = RunId.make("run_switch_note_codex");
    const claudeThreadId = ProviderThreadId.make("provider_thread_switch_note_claude");
    const codexThreadId = ProviderThreadId.make("provider_thread_switch_note_codex");
    const claude = ProviderInstanceId.make("claude");
    const codex = ProviderInstanceId.make("codex");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;

    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: claudeThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claude,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "task-claude", description: "Watch the build" }],
        },
        {
          id: codexThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codex,
          status: "idle",
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: claudeRunId,
          ordinal: 1,
          status: "completed",
          providerInstanceId: claude,
          providerThreadId: claudeThreadId,
        },
        {
          id: codexRunId,
          ordinal: 2,
          status: "completed",
          providerInstanceId: codex,
          providerThreadId: codexThreadId,
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_switch_note_subagent"),
          runId: claudeRunId,
          nodeId: null,
          providerThreadId: claudeThreadId,
          nativeItemRef: null,
          type: "subagent",
          title: "Background subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const recorded = (committedInput?.events ?? []).flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );

      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId: claudeRunId, kinds: ["subagent", "task"] }],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("cancels a stale waiting run when no checkpoint capture can finish it", () => {
  const threadId = ThreadId.make("thread_stale_waiting");
  const runId = RunId.make("run_stale_waiting");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "waiting",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const runEvent = committedInput?.events.find((event) => event.type === "run.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("recovery closes a secret card's form but leaves a link card open", () => {
  const threadId = ThreadId.make("thread_secret_recovery");
  const runId = RunId.make("run_secret_recovery");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "running", providerInstanceId: ProviderInstanceId.make("codex") }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: "turn-item:secret-request:recovery",
        threadId,
        runId,
        nodeId: null,
        type: "secret_request",
        status: "waiting",
        secretStatus: "pending",
        label: "GitHub token",
        reason: "Used as GH_TOKEN.",
      },
      {
        id: "turn-item:link-request:recovery",
        threadId,
        runId,
        nodeId: null,
        type: "link_request",
        status: "waiting",
        linkStatus: "pending",
        url: "https://box.example.ts.net",
        reason: "Run the suite there.",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const cards = (committedInput?.events ?? []).flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload] : [],
    );
    const secret = cards.find((card) => card.type === "secret_request");
    assert.equal(secret?.status, "cancelled");
    assert.equal(secret?.type === "secret_request" ? secret.secretStatus : null, "cancelled");
    // Nothing in memory waits on a link card; the user can still answer it.
    assert.equal(
      cards.some((card) => card.type === "link_request"),
      false,
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each(["queued", "preparing"] as const)("recovers $0 work after restart", (status) => {
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status,
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        ...(status === "preparing"
          ? {
              workspacePreparation: {
                type: "worktree",
                baseRef: "parent-local-commit",
                startFromOrigin: false,
              },
            }
          : {}),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, status === "preparing" ? 1 : 0);
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(
      runEvent?.type === "run.updated" ? runEvent.payload.status : null,
      status === "preparing" ? "cancelled" : "queued",
    );
    assert.isEmpty(command.effects);
    if (status === "preparing") {
      assert.equal(
        attemptEvent?.type === "run-attempt.updated" ? attemptEvent.payload.status : null,
        "cancelled",
      );
      assert.equal(
        nodeEvent?.type === "node.updated" ? nodeEvent.payload.status : null,
        "cancelled",
      );
    } else {
      assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : null, 1);
      assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queueHeld : false, true);
      assert.isUndefined(attemptEvent);
      assert.isUndefined(nodeEvent);
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "cancels the complete in-flight subtree and stops its persisted session without reopening it",
  () => {
    const threadId = ThreadId.make("thread_recovery_cancel");
    const runId = RunId.make("run_recovery_cancel");
    const attemptId = RunAttemptId.make("attempt_recovery_cancel");
    const rootNodeId = NodeId.make("node_recovery_cancel");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_cancel");
    const providerTurnId = ProviderTurnId.make("provider_turn_recovery_cancel");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_cancel");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "active",
        },
      ],
      providerTurns: [
        {
          id: providerTurnId,
          runAttemptId: attemptId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
      runs: [
        {
          id: runId,
          status: "starting",
          providerThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          rootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: rootNodeId, runId, status: "running" }],
      subagents: [],
      messages: [{ id: MessageId.make("message_recovery_cancel"), runId, streaming: true }],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_recovery_cancel"),
          runId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 2 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
        .recover;
      assert.equal(summary.terminalizedRuns, 1);
      assert.equal(summary.stoppedSessions, 1);
      assert.equal(summary.retiredEffects, 2);
      assert.deepEqual(committedInput?.cancelUnsettledEffects?.effectTypes, [
        "privileged-command.execute",
        "provider-turn.start",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "runtime-request.respond",
      ]);
      const events = committedInput?.events ?? [];
      assert.deepEqual(
        events.map((event) => [
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
        [
          ["run.updated", "cancelled"],
          ["run-attempt.updated", "cancelled"],
          ["node.updated", "cancelled"],
          ["provider-turn.updated", "cancelled"],
          ["message.updated", null],
          ["turn-item.updated", "cancelled"],
          ["provider-thread.updated", "idle"],
          ["provider-session.updated", "stopped"],
        ],
      );
      const messageEvent = events.find((event) => event.type === "message.updated");
      assert.isFalse(messageEvent?.type === "message.updated" && messageEvent.payload.streaming);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("cancels workflow members and child roots without run ids after restart", () => {
  const parentThreadId = ThreadId.make("thread_recovery_workflow_members");
  const childThreadId = ThreadId.make("thread_recovery_workflow_member_child");
  const memberId = NodeId.make("node_recovery_workflow_member");
  const childRootId = NodeId.make("node_recovery_workflow_member_root");
  const providerInstanceId = ProviderInstanceId.make("claudeAgent");
  const driver = ProviderDriverKind.make("claudeAgent");
  const member = {
    id: memberId,
    threadId: parentThreadId,
    runId: null,
    origin: "provider_native",
    status: "running",
    driver,
    providerInstanceId,
  };
  const parentProjection = {
    thread: { id: parentThreadId, providerInstanceId },
    runs: [],
    attempts: [],
    nodes: [
      { id: memberId, threadId: parentThreadId, runId: null, kind: "subagent", status: "running" },
    ],
    subagents: [member],
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const childProjection = {
    ...parentProjection,
    thread: { id: childThreadId, providerInstanceId },
    nodes: [
      {
        id: childRootId,
        threadId: childThreadId,
        runId: null,
        kind: "root_turn",
        status: "running",
      },
    ],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const committed: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([parentThreadId, childThreadId]),
          getRuntimeRecoveryProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committed.push(input);
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.deepEqual(
      committed.flatMap((command) =>
        command.events.map((event) => [
          command.threadId,
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
      ),
      [
        [parentThreadId, "subagent.updated", "cancelled"],
        [parentThreadId, "node.updated", "cancelled"],
        [childThreadId, "node.updated", "cancelled"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "clears persisted pendingBackgroundTasks and terminalizes stale background items on settled runs",
  () => {
    const threadId = ThreadId.make("thread_recovery_background");
    const settledRunId = RunId.make("run_recovery_background_settled");
    const activeRunId = RunId.make("run_recovery_background_active");
    const activeAttemptId = RunAttemptId.make("attempt_recovery_background_active");
    const activeRootNodeId = NodeId.make("node_recovery_background_active");
    const idleProviderThreadId = ProviderThreadId.make("provider_thread_recovery_background_idle");
    const activeProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_active",
    );
    const secondaryProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_secondary",
    );
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_background");
    const settledStaleItemId = TurnItemId.make("turn_item_recovery_background_stale");
    const activeRunItemId = TurnItemId.make("turn_item_recovery_background_active");
    const nullRunCommandItemId = TurnItemId.make("turn_item_recovery_background_null_run");
    const nullRunSubagentItemId = TurnItemId.make("turn_item_recovery_background_null_subagent");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    const secondaryInstanceId = ProviderInstanceId.make("claude-secondary");
    const subagentInstanceId = ProviderInstanceId.make("claude-subagent");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: idleProviderThreadId,
          driver: ProviderDriverKind.make("claude"),

          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "bg-settled", description: "sleep 30" }],
        },
        {
          id: activeProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "active",
          pendingBackgroundTasks: [{ taskId: "bg-active", description: "npm test" }],
        },
        {
          id: secondaryProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: secondaryInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: settledRunId,
          status: "completed",
          providerInstanceId: claudeInstanceId,
        },
        {
          id: activeRunId,
          status: "running",
          providerInstanceId: claudeInstanceId,
        },
      ],
      attempts: [
        {
          id: activeAttemptId,
          runId: activeRunId,
          rootNodeId: activeRootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: activeRootNodeId, runId: activeRunId, status: "running" }],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: settledStaleItemId,
          runId: settledRunId,
          nodeId: null,
          providerThreadId: idleProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          id: activeRunItemId,
          runId: activeRunId,
          nodeId: activeRootNodeId,
          providerThreadId: activeProviderThreadId,
          type: "dynamic_tool",
          status: "running",
        },
        {
          id: nullRunCommandItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          id: nullRunSubagentItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "subagent",
          status: "running",
          providerInstanceId: subagentInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 1);
      const events = committedInput?.events ?? [];

      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );

      assert.equal(turnItemCancels.length, 4);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [activeRunItemId, nullRunCommandItemId, nullRunSubagentItemId, settledStaleItemId].sort(),
      );

      const cancelById = (id: TurnItemId) =>
        turnItemCancels.find(
          (event) => event.type === "turn-item.updated" && event.payload.id === id,
        );
      assert.equal(cancelById(nullRunCommandItemId)?.providerInstanceId, secondaryInstanceId);

      assert.notEqual(subagentInstanceId, secondaryInstanceId);
      assert.equal(cancelById(nullRunSubagentItemId)?.providerInstanceId, subagentInstanceId);

      assert.equal(cancelById(settledStaleItemId)?.providerInstanceId, claudeInstanceId);

      const providerThreadEvents = events.filter(
        (event) => event.type === "provider-thread.updated",
      );

      assert.equal(providerThreadEvents.length, 2);
      for (const event of providerThreadEvents) {
        if (event.type !== "provider-thread.updated") continue;
        assert.deepEqual(event.payload.pendingBackgroundTasks ?? [], []);
      }
      const idleThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === idleProviderThreadId,
      );
      assert.equal(
        idleThreadEvent?.type === "provider-thread.updated" ? idleThreadEvent.payload.status : null,
        "idle",
      );
      const activeThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === activeProviderThreadId,
      );
      assert.equal(
        activeThreadEvent?.type === "provider-thread.updated"
          ? activeThreadEvent.payload.status
          : null,
        "idle",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "terminalizes a leftover nonpersistent dynamic_tool on a settled run after process loss",
  () => {
    const threadId = ThreadId.make("thread_recovery_orphan_wait");
    const settledRunId = RunId.make("run_recovery_orphan_wait_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_orphan_wait");
    const orphanWaitItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-4669f3bb-78c9-4af1-b44e-daa340d2c538",
    );
    const persistentMonitorItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-persistent-monitor",
    );
    const orphanWaitNodeId = NodeId.make("node_recovery_orphan_wait");
    const persistentMonitorNodeId = NodeId.make("node_recovery_persistent_monitor");
    const codexInstanceId = ProviderInstanceId.make("codex");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId, providerInstanceId: codexInstanceId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [{ id: settledRunId, status: "completed", providerInstanceId: codexInstanceId }],
      attempts: [],
      nodes: [
        { id: orphanWaitNodeId, runId: settledRunId, status: "running", kind: "tool_call" },
        {
          id: persistentMonitorNodeId,
          runId: settledRunId,
          status: "running",
          kind: "tool_call",
        },
      ],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: orphanWaitItemId,
          runId: settledRunId,
          nodeId: orphanWaitNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "t3-code.t3_thread_wait",
          input: {
            threadId:
              "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
            timeoutMs: 30000,
          },
        },
        {
          id: persistentMonitorItemId,
          runId: settledRunId,
          nodeId: persistentMonitorNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "grok.monitor",
          input: { persistent: true, command: "tail -f" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      const turnItemCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );

      assert.equal(turnItemCancels.length, 2);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [orphanWaitItemId, persistentMonitorItemId].sort(),
      );
      const nodeCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "node.updated" && event.payload.status === "cancelled",
      );
      assert.equal(nodeCancels.length, 2);
      assert.deepEqual(
        nodeCancels.map((event) => event.type === "node.updated" && event.payload.id).sort(),
        [orphanWaitNodeId, persistentMonitorNodeId].sort(),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "terminalizes the linked subagent and node for a stale subagent item on a settled run",
  () => {
    const threadId = ThreadId.make("thread_recovery_subagent");
    const settledRunId = RunId.make("run_recovery_subagent_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_subagent");
    const staleSubagentNodeId = NodeId.make("node_recovery_subagent_stale");
    const doneSubagentNodeId = NodeId.make("node_recovery_subagent_done");
    const staleItemId = TurnItemId.make("turn_item_recovery_subagent_stale");
    const doneItemId = TurnItemId.make("turn_item_recovery_subagent_done");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],

      runs: [{ id: settledRunId, status: "completed", providerInstanceId: claudeInstanceId }],
      attempts: [],
      nodes: [
        { id: staleSubagentNodeId, runId: settledRunId, status: "running" },
        { id: doneSubagentNodeId, runId: settledRunId, status: "completed" },
      ],
      subagents: [
        {
          id: staleSubagentNodeId,
          runId: settledRunId,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "running",
        },
        {
          id: doneSubagentNodeId,
          runId: settledRunId,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "completed",
          result: "done",
        },
      ],
      messages: [],
      turnItems: [
        {
          id: staleItemId,
          runId: settledRunId,
          nodeId: staleSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "running",
          subagentId: staleSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
        {
          id: doneItemId,
          runId: settledRunId,
          nodeId: doneSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "completed",
          subagentId: doneSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const events = committedInput?.events ?? [];

      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      assert.equal(turnItemCancels.length, 1);

      const subagentCancels = events.filter((event) => event.type === "subagent.updated");
      assert.equal(subagentCancels.length, 1);
      const subagentCancel = subagentCancels[0];
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.id : null,
        staleSubagentNodeId,
      );
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.status : null,
        "cancelled",
      );

      const nodeCancels = events.filter((event) => event.type === "node.updated");
      assert.equal(nodeCancels.length, 1);
      const nodeCancel = nodeCancels[0];
      assert.equal(
        nodeCancel?.type === "node.updated" ? nodeCancel.payload.id : null,
        staleSubagentNodeId,
      );

      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("leaves delegated tasks to their own child threads after process loss", () => {
  const threadId = ThreadId.make("thread_recovery_delegation");
  const settledRunId = RunId.make("run_recovery_delegation_settled");
  const runningRunId = RunId.make("run_recovery_delegation_running");
  const providerThreadId = ProviderThreadId.make("provider_thread_recovery_delegation");
  const claudeInstanceId = ProviderInstanceId.make("claude");
  const driver = ProviderDriverKind.make("claude");
  const settledTaskId = NodeId.make("node_recovery_delegation_settled");
  const runningTaskId = NodeId.make("node_recovery_delegation_running");
  const nativeSubagentId = NodeId.make("node_recovery_native_subagent");
  const delegatedTask = (id: NodeId, runId: RunId) => ({
    id,
    runId,
    origin: "app_owned",
    childThreadId: ThreadId.make(`thread:delegated-task:${id}`),
    driver,
    providerInstanceId: claudeInstanceId,
    status: "running",
  });
  const subagentItem = (subagentId: NodeId, runId: RunId, origin: string) => ({
    id: TurnItemId.make(`turn_item:${subagentId}`),
    runId,
    nodeId: subagentId,
    providerThreadId,
    type: "subagent",
    status: "running",
    subagentId,
    origin,
    childThreadId:
      origin === "app_owned" ? ThreadId.make(`thread:delegated-task:${subagentId}`) : null,
    providerInstanceId: claudeInstanceId,
    title: `subagent ${subagentId}`,
  });
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId: claudeInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: claudeInstanceId,
        ownerNodeId: null,
        status: "idle",
        pendingBackgroundTasks: [],
      },
    ],
    providerTurns: [],
    runs: [
      {
        id: settledRunId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
      {
        id: runningRunId,
        ordinal: 2,
        status: "running",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
    ],
    attempts: [],
    nodes: [
      { id: settledTaskId, runId: settledRunId, status: "running", kind: "subagent" },
      { id: runningTaskId, runId: runningRunId, status: "running", kind: "subagent" },
      { id: nativeSubagentId, runId: settledRunId, status: "running", kind: "subagent" },
    ],
    subagents: [
      delegatedTask(settledTaskId, settledRunId),
      delegatedTask(runningTaskId, runningRunId),
      {
        ...delegatedTask(nativeSubagentId, settledRunId),
        origin: "provider_native",
        childThreadId: null,
      },
    ],
    messages: [],
    turnItems: [
      subagentItem(settledTaskId, settledRunId, "app_owned"),
      subagentItem(runningTaskId, runningRunId, "app_owned"),
      subagentItem(nativeSubagentId, settledRunId, "provider_native"),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const events = committedInput?.events ?? [];
    const touched = events.flatMap((event) =>
      event.type === "turn-item.updated"
        ? event.payload.type === "subagent"
          ? [event.payload.subagentId]
          : []
        : event.type === "subagent.updated" || event.type === "node.updated"
          ? [event.payload.id]
          : [],
    );

    assert.isTrue(
      events.some(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runningRunId &&
          event.payload.status === "cancelled",
      ),
    );
    assert.notInclude(touched, settledTaskId);
    assert.notInclude(touched, runningTaskId);
    assert.include(touched, nativeSubagentId);

    const noted = events.flatMap((event) =>
      event.type === "run.background-work-cancelled"
        ? event.payload.restartCancelledBackgroundWork.map((work) => work.label)
        : [],
    );
    assert.deepEqual(noted, [`subagent ${nativeSubagentId}`]);
  }).pipe(Effect.provide(layer));
});
