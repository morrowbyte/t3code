import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  NodeId,
  RunId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { DispatchRuntimeOptions } from "../orchestration-v2/DispatchRuntimeOptions.ts";
import type { LiveVoiceEvent, LiveVoiceSession } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as CodexLiveSessionService from "./CodexLiveSessionService.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWorkStatus = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.String,
      leaseId: Schema.String,
      generation: Schema.Number,
      tasks: Schema.Array(
        Schema.Struct({
          runId: Schema.String,
          status: Schema.String,
          resultReady: Schema.Boolean,
          commentary: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
);
const decodeCurrentWorkStatus = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      visibility: Schema.String,
      reason: Schema.optional(Schema.String),
      tasks: Schema.Array(
        Schema.Struct({
          status: Schema.String,
          resultReady: Schema.Boolean,
          currentStep: Schema.NullOr(Schema.String),
          visibility: Schema.String,
        }),
      ),
      delegatedTasks: Schema.Array(
        Schema.Struct({
          taskId: Schema.String,
          request: Schema.String,
          status: Schema.String,
          resultReady: Schema.Boolean,
          lastUpdate: Schema.NullOr(Schema.String),
          visibility: Schema.String,
        }),
      ),
    }),
  ),
);
const readbackState = (json: string) => {
  const decoded = decodeJson(json);
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const readback = (decoded as Record<string, unknown>).readback;
  if (typeof readback !== "object" || readback === null) return undefined;
  return (readback as Record<string, unknown>).state;
};

it.effect.each([false, true])(
  "uses the native planner, gates active, and queues durable work (reuse runtime: %s)",
  (reuseRuntime) =>
    Effect.gen(function* () {
      const nativeEvents =
        yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2LiveVoiceEvent>();
      const secondNativeEvents = reuseRuntime
        ? nativeEvents
        : yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2LiveVoiceEvent>();
      const secondProviderSessionId = ProviderSessionId.make(
        reuseRuntime ? "provider-session-test" : "provider-session-test-2",
      );
      let submitWork:
        | ((input: {
            plannerNativeThreadId: string;
            plannerTurnId: string;
            callId: string;
            message: string;
            requestId?: string;
            projectId?: string;
          }) => Effect.Effect<string, ProviderAdapter.ProviderAdapterV2Error>)
        | undefined;
      let plannerOptions:
        | { serviceTier?: string | null; reasoningEffort?: string | null }
        | undefined;
      let controlWork: Parameters<
        ProviderAdapter.ProviderAdapterV2LiveVoiceRuntime["preparePlanner"]
      >[0]["onWorkControl"];
      const workCompletion = yield* Deferred.make<void>();
      const workFinished = yield* Deferred.make<void>();
      let completedWork = 0;
      let steers = 0;
      let authorizedRestarts = 0;
      let rejectSteerAtAdmission = false;
      let beforeMainCommit: (() => void) | undefined;
      let quietSpeechSignal: Deferred.Deferred<void> | undefined;
      let sends = 0;
      let mainSend:
        | ThreadManagementService.ThreadManagementServiceShape["sendToThread"]
        | undefined;
      const mainRefinements: Array<
        Extract<
          Parameters<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>[0],
          { type: "message.dispatch" }
        >
      > = [];
      const warningMessages: unknown[] = [];
      const warningLogger = Logger.make(({ message }) => {
        warningMessages.push(message);
      });
      let beforeSourceCommit:
        | {
            started: Deferred.Deferred<
              NonNullable<DispatchRuntimeOptions["voiceIntakeCommitGuard"]>
            >;
            release: Deferred.Deferred<void>;
          }
        | undefined;
      const guarded = <A, E, R>(
        options: DispatchRuntimeOptions | undefined,
        commandId: Parameters<
          ThreadManagementService.ThreadManagementServiceShape["dispatch"]
        >[0]["commandId"],
        effect: Effect.Effect<A, E, R>,
      ) => {
        const guard = options?.voiceIntakeCommitGuard;
        return guard
          ? guard.semaphore.withPermits(1)(
              Effect.gen(function* () {
                if (!guard.isCurrent())
                  return yield* new Orchestrator.OrchestratorCommandRejectedError({
                    commandId,
                    commandType: "message.dispatch",
                    cause: "Source changed before commit.",
                  });
                return yield* effect;
              }),
            )
          : effect;
      };
      let stops = 0;
      const spoken: Array<{ plannerNativeThreadId: string; text: string }> = [];
      const contexts: Array<{ plannerNativeThreadId: string; text: string }> = [];
      const contextSignals = new Map<string, Deferred.Deferred<void>>();
      let contextAppendGate: Deferred.Deferred<void> | undefined;
      let previewContextGate: Deferred.Deferred<void> | undefined;
      const deliveryWaiters = new Map<string, () => void>();
      const waitForDelivery = (messageId: string) =>
        new Promise<void>((resolve) => deliveryWaiters.set(messageId, resolve));
      const deliveryTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            if (span.name === "VoiceIntake.processLatest") notifyIntakeProcessed?.();
            if (span.attributes.has("voice.output.delivery"))
              deliveryWaiters.get(String(span.attributes.get("voice.output.message_id")))?.();
          };
          return span;
        },
      });
      let appendAttempts = 0;
      let appendSpeechFails = false;
      let resolveAppendAttempt: (() => void) | undefined;
      let appendAttemptObserved = new Promise<void>((resolve) => {
        resolveAppendAttempt = resolve;
      });
      let resolveSpeech: (() => void) | undefined;
      let speechObserved = new Promise<void>((resolve) => {
        resolveSpeech = resolve;
      });
      let gateReadResolvers: Array<() => void> = [];
      let durableProjection: OrchestrationV2ThreadProjection;
      let childProjection: OrchestrationV2ThreadProjection | undefined;
      const independentJobs = new Map<string, OrchestrationV2ThreadProjection>();
      const independentQueues = new Map<
        string,
        Map<string, Queue.Queue<OrchestrationV2StoredEvent>>
      >();
      let admitIndependent:
        | ((
            command: Extract<
              Parameters<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>[0],
              { type: "message.dispatch" }
            >,
          ) => Effect.Effect<unknown>)
        | undefined;
      let projectionGate:
        | { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
        | undefined;
      let activePrincipalLookups = 0;
      let principalLookupGate:
        | {
            readonly callNumber: number;
            readonly started: Promise<void>;
            readonly release: () => void;
            readonly wait: Promise<void>;
            readonly markStarted: () => void;
          }
        | undefined;
      const holdDispatchPrincipalLookup = () => {
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        principalLookupGate = {
          callNumber: activePrincipalLookups + 2,
          started,
          release,
          wait,
          markStarted,
        };
        return principalLookupGate;
      };
      const t3EventQueues = new Map([
        ["run.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["subagent.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["checkpoint.captured", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["message.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["turn-item.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
      ]);
      let plannerCalls = 0;
      let plannerAttempts = 0;
      let plannerFailure: "managed_account_required" | "planner_restriction_failed" | undefined;
      let plannerGate:
        | { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
        | undefined;
      let lookupGate:
        | { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
        | undefined;
      let intakeDecision: ProviderAdapter.ProviderAdapterV2LiveVoiceRuntime["decideIntake"];
      let expectedNewTaskOwner: "intake" | undefined;
      let notifyIntakeProcessed: (() => void) | undefined;
      const runtime = {
        instanceId: ProviderInstanceId.make("codex-test"),
        providerSessionId: ProviderSessionId.make("provider-session-test"),
        driver: "codex",
        liveVoice: {
          events: Stream.fromQueue(nativeEvents),
          get decideIntake() {
            return intakeDecision;
          },
          canStartProvisionalWork: Effect.succeed(true),
          preparePlanner: (input: {
            newTaskAdmission?: "intake";
            serviceTier?: string | null;
            reasoningEffort?: string | null;
            onSubmitWork: (input: {
              plannerNativeThreadId: string;
              plannerTurnId: string;
              callId: string;
              message: string;
            }) => Effect.Effect<string>;
            onWorkControl: NonNullable<typeof controlWork>;
          }) =>
            Effect.gen(function* () {
              assert.equal(input.newTaskAdmission, expectedNewTaskOwner);
              plannerAttempts += 1;
              const gate = plannerGate;
              plannerGate = undefined;
              if (gate !== undefined) {
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              if (gate !== undefined || plannerFailure !== undefined) {
                return yield* Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: ProviderDriverKind.make("codex"),
                    detail:
                      plannerFailure === "managed_account_required"
                        ? "Managed ChatGPT account is required for Codex Live."
                        : "Codex Live planner settings were not confirmed.",
                  }),
                );
              }
              return yield* Effect.sync(() => {
                plannerCalls += 1;
                submitWork = input.onSubmitWork;
                controlWork = input.onWorkControl;
                plannerOptions = {
                  ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
                  ...(input.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: input.reasoningEffort }),
                };
                return { plannerNativeThreadId: `planner-native-${plannerCalls}` };
              });
            }),
          start: () => Effect.void,
          stop: () =>
            Effect.sync(() => {
              stops += 1;
            }),
          appendContext: (input: { plannerNativeThreadId: string; text: string }) =>
            Effect.gen(function* () {
              contexts.push(input);
              const gate = contextAppendGate;
              contextAppendGate = undefined;
              const signal = contextSignals.get(input.text);
              if (signal) yield* Deferred.succeed(signal, undefined);
              if (previewContextGate && input.text.startsWith("Selected preview context")) {
                const held = previewContextGate;
                previewContextGate = undefined;
                yield* Deferred.await(held);
              }
              if (gate) yield* Deferred.await(gate);
            }),
          appendSpeech: (input: { plannerNativeThreadId: string; text: string }) =>
            Effect.gen(function* () {
              appendAttempts += 1;
              resolveAppendAttempt?.();
              if (appendSpeechFails)
                return yield* Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: ProviderDriverKind.make("codex"),
                    detail: "Ambiguous native append acknowledgement.",
                  }),
                );
              spoken.push(input);
              if (input.text.startsWith("Die Arbeit läuft noch.") && quietSpeechSignal)
                yield* Deferred.succeed(quietSpeechSignal, undefined);
              resolveSpeech?.();
            }),
        },
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const secondRuntime = {
        ...runtime,
        providerSessionId: secondProviderSessionId,
        liveVoice: {
          ...runtime.liveVoice,
          get decideIntake() {
            return intakeDecision;
          },
          events: Stream.fromQueue(secondNativeEvents),
        },
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const sessionId = AuthSessionId.make("live-test-principal");
      const runtimes = new Map([
        [runtime.providerSessionId, runtime],
        [secondRuntime.providerSessionId, secondRuntime],
      ]);
      const runtimeEvents = new Map([
        [runtime.providerSessionId, nativeEvents],
        [secondRuntime.providerSessionId, secondNativeEvents],
      ]);
      const openedRuntimes: Array<
        Parameters<ProviderSessionManager.ProviderSessionManagerV2Shape["open"]>[0]
      > = [];
      let failNextLookup = false;
      const session = {
        sessionId,
        subject: "principal-subject",
        method: "browser-session-cookie" as const,
        scopes: [AuthOrchestrationOperateScope],
      };
      const previousClient = {
        ...session,
        sessionId: AuthSessionId.make("previous-browser-client"),
      };
      const threadId = "thread-live-test" as never;
      const projectId = "project-live-test" as never;
      const providerInstanceId = ProviderInstanceId.make("codex-test");
      const modelSelection = {
        instanceId: providerInstanceId,
        model: "codex-test-model",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      } as never;
      const projection = {
        thread: {
          id: threadId,
          projectId,
          providerInstanceId,
          activeProviderThreadId: null,
          modelSelection,
          archivedAt: null,
          deletedAt: null,
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreePath: "/private/test-worktree",
        },
        providerThreads: [],
        providerSessions: [
          { id: ProviderSessionId.make("provider-session-test"), providerInstanceId },
        ],
      };
      durableProjection = {
        ...projection,
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        checkpoints: [],
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/private/test-worktree",
      };
      let currentPolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = policy;
      const dependencies = Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        NodeCrypto.layer,
        Layer.succeed(SessionStore.SessionStore, {
          listActive: () => {
            activePrincipalLookups += 1;
            const gate = principalLookupGate;
            if (gate?.callNumber === activePrincipalLookups) {
              principalLookupGate = undefined;
              gate.markStarted();
              return Effect.promise(() => gate.wait).pipe(Effect.as([session, previousClient]));
            }
            return Effect.succeed([session, previousClient]);
          },
        } as unknown as SessionStore.SessionStore["Service"]),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed("env-live-test" as never),
        }),
        Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
          resolve: () => Effect.succeed(currentPolicy),
        }),
        Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, {
          get: (providerSessionId: ProviderSessionId) =>
            Effect.gen(function* () {
              const gate = lookupGate;
              lookupGate = undefined;
              if (gate !== undefined) {
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              if (failNextLookup) {
                failNextLookup = false;
                return yield* Effect.fail(
                  new ProviderSessionManager.ProviderSessionLookupError({
                    providerSessionId,
                  }),
                );
              }
              const existing = runtimes.get(providerSessionId);
              return existing === undefined ? Option.none() : Option.some(existing);
            }),
          open: (
            input: Parameters<ProviderSessionManager.ProviderSessionManagerV2Shape["open"]>[0],
          ) =>
            Effect.gen(function* () {
              const events =
                yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2LiveVoiceEvent>();
              const opened = {
                ...secondRuntime,
                providerSessionId: input.providerSessionId,
                liveVoice: {
                  ...secondRuntime.liveVoice!,
                  get decideIntake() {
                    return intakeDecision;
                  },
                  events: Stream.fromQueue(events),
                },
              };
              runtimes.set(
                input.providerSessionId,
                opened as ProviderAdapter.ProviderAdapterV2SessionRuntime,
              );
              runtimeEvents.set(input.providerSessionId, events);
              openedRuntimes.push(input);
              return opened as ProviderAdapter.ProviderAdapterV2SessionRuntime;
            }),
        } as unknown as ProviderSessionManager.ProviderSessionManagerV2Shape),
        Layer.succeed(ThreadManagementService.ThreadManagementService, {
          getThreadProjection: (id: typeof threadId) =>
            Effect.gen(function* () {
              if (independentJobs.has(id)) return independentJobs.get(id)!;
              if (childProjection?.thread.id === id) return childProjection;
              const gate = projectionGate;
              projectionGate = undefined;
              if (gate) {
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              return String(id).startsWith("fork-prepare-")
                ? { ...durableProjection, thread: { ...durableProjection.thread, id } }
                : durableProjection;
            }),
          getProjectThread: (input: { threadId: string }) =>
            Effect.sync(() => {
              if (independentJobs.has(input.threadId)) return independentJobs.get(input.threadId)!;
              if (childProjection?.thread.id === input.threadId) return childProjection;
              const resolve = gateReadResolvers.shift();
              resolve?.();
              return durableProjection;
            }),
          getThreadEventSequence: () => Effect.succeed(0),
          streamStoredEventsFrom: (input: { threadId: string; eventType?: string }) =>
            Stream.fromQueue(
              (independentQueues.get(input.threadId) ?? t3EventQueues).get(input.eventType ?? "")!,
            ),
          sendToThread: (
            input: Parameters<
              ThreadManagementService.ThreadManagementServiceShape["sendToThread"]
            >[0],
            options?: DispatchRuntimeOptions,
          ) =>
            mainSend
              ? mainSend(input, options)
              : Effect.gen(function* () {
                  sends += 1;
                  if (sends === 1)
                    yield* Deferred.await(workCompletion).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          completedWork += 1;
                        }),
                      ),
                      Effect.tap(() => Deferred.succeed(workFinished, undefined)),
                      Effect.forkChild,
                    );
                  return { delivery: "queued", run: { id: `durable-run-${sends}` } };
                }),
          dispatch: (
            command: Extract<
              Parameters<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>[0],
              { type: "message.dispatch" | "thread.runtime-mode.set" }
            >,
            options?: DispatchRuntimeOptions,
          ) =>
            guarded(
              options,
              command.commandId,
              Effect.gen(function* () {
                if (command.type === "thread.runtime-mode.set") {
                  const child = independentJobs.get(command.threadId)!;
                  assert.equal(
                    child.thread.voiceIntake!.intentId,
                    command.voiceIntakeConfirmation!.intentId,
                  );
                  independentJobs.set(command.threadId, {
                    ...child,
                    thread: {
                      ...child.thread,
                      voiceIntake: command.voiceIntakeConfirmation,
                    },
                  });
                  return { events: [] };
                }
                if (command.delegation !== undefined && admitIndependent)
                  return yield* admitIndependent(command);
                if (command.dispatchMode.type === "restart_active") {
                  assert.isFalse(
                    independentJobs.get(command.threadId)!.thread.voiceIntake!.provisional,
                  );
                  authorizedRestarts += 1;
                } else if (
                  command.dispatchMode.type !== "steer_active" ||
                  command.dispatchMode.onInactive !== "reject"
                )
                  return yield* new Orchestrator.OrchestratorCommandRejectedError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Expected exact, fail-closed steering.",
                  });
                const targetRunId = command.dispatchMode.targetRunId;
                if (command.voiceIntakeSourceThreadId !== undefined) {
                  assert.equal(command.voiceIntakeSourceThreadId, command.threadId);
                  assert.equal(command.threadId, threadId);
                  assert.isFalse(command.voiceIntakeSource!.provisional);
                  mainRefinements.push(command);
                  beforeMainCommit?.();
                }
                const target = independentJobs.get(command.threadId) ?? durableProjection;
                const run = target.runs.find((candidate) => candidate.id === targetRunId);
                if (
                  rejectSteerAtAdmission ||
                  !run ||
                  !["running", "starting", "waiting"].includes(run.status)
                )
                  return yield* new Orchestrator.OrchestratorCommandRejectedError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Target run ended at admission.",
                  });
                steers += 1;
                const updated = {
                  ...target,
                  messages: [
                    ...target.messages,
                    {
                      id: command.messageId,
                      threadId: command.threadId,
                      runId: run.id,
                      role: "user",
                      text: command.text,
                    } as never,
                  ],
                };
                if (independentJobs.has(command.threadId))
                  independentJobs.set(command.threadId, updated);
                else durableProjection = updated;
                return { events: [] };
              }),
            ),
        } as unknown as ThreadManagementService.ThreadManagementServiceShape),
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: () =>
            Effect.succeed({
              driverKind: "codex",
              snapshot: {
                getSnapshot: Effect.succeed({
                  models: [
                    {
                      slug: "gpt-6-luna",
                      capabilities: {
                        optionDescriptors: [
                          { id: "reasoningEffort", type: "select", options: [{ id: "low" }] },
                          { id: "serviceTier", type: "select", options: [{ id: "priority" }] },
                        ],
                      },
                    },
                  ],
                }),
              },
            }),
        } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
      );
      const program = Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const service = yield* CodexLiveSessionService.CodexLiveSessionService;
        const prepared = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-1",
        });
        assert.equal(prepared.status, "prepared");
        assert.equal(prepared.providerSessionId, "provider-session-test");
        assert.equal(prepared.plannerNativeThreadId, "planner-native-1");
        assert.deepEqual(plannerOptions, { serviceTier: "priority", reasoningEffort: "high" });
        const duplicatePrepare = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-1",
        });
        assert.equal(duplicatePrepare.leaseId, prepared.leaseId);
        assert.equal(plannerCalls, 1);

        const delivered = yield* Queue.unbounded<LiveVoiceEvent>();
        const observedStatuses: string[] = [];
        const observedTranscripts: Array<Extract<LiveVoiceEvent, { type: "transcript" }>> = [];
        yield* service
          .subscribe(session, {
            leaseId: prepared.leaseId,
            generation: prepared.generation,
          })
          .pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "status") observedStatuses.push(event.session.status);
                if (event.type === "transcript") observedTranscripts.push(event);
              }).pipe(Effect.andThen(Queue.offer(delivered, event))),
            ),
            Effect.forkChild({ startImmediately: true }),
          );
        const waitForEvent = (predicate: (event: LiveVoiceEvent) => boolean) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(delivered);
              if (predicate(event)) return event;
            }
          });
        const initial = yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === prepared.leaseId &&
            event.session.generation === prepared.generation &&
            event.session.status === "prepared",
        );
        assert.equal(initial.type, "status");

        const acknowledged = yield* service.start(session, {
          leaseId: prepared.leaseId,
          generation: prepared.generation,
          offerSdp: "v=0\r\n",
          clientRequestId: "start-1",
        });
        assert.equal(acknowledged.status, "starting");

        yield* Queue.offer(nativeEvents, {
          type: "sdp",
          plannerNativeThreadId: "planner-native-1",
          sdp: "v=0\\r\\nanswer",
        });
        const notStartedYet = yield* service.status(session, {
          leaseId: prepared.leaseId,
          generation: prepared.generation,
        });
        assert.equal(notStartedYet.status, "starting");
        yield* Queue.offer(nativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
        });
        const activeEvent = yield* waitForEvent(
          (event) => event.type === "status" && event.session.status === "active",
        );
        assert.equal(activeEvent.type, "status");

        assert.isTrue(typeof submitWork === "function");
        const invokeWithPlanner = (
          plannerNativeThreadId: string,
          callId: string,
          message: string,
          plannerTurnId: string,
        ) =>
          submitWork!({
            plannerNativeThreadId,
            plannerTurnId,
            callId,
            message,
          });
        const invoke = (callId: string, message: string, plannerTurnId = "planner-turn-1") =>
          invokeWithPlanner("planner-native-1", callId, message, plannerTurnId);
        currentPolicy = { ...currentPolicy, cwd: "/changed-worktree" };
        const policyChanged = yield* Effect.exit(
          invoke("call-stale", "A request captured under old settings", "planner-turn-stale"),
        );
        assert.isTrue(Exit.isFailure(policyChanged));
        assert.equal(sends, 0);
        currentPolicy = policy;
        const firstReceipt = yield* invoke("call-1", "Implement the requested change");
        const duplicateReceipt = yield* invoke("call-2", "Implement the requested change");
        assert.equal(firstReceipt, duplicateReceipt);
        assert.equal(sends, 1);

        const makeRunProjection = (
          runId: string,
          childStatus: "running" | "completed",
          finalText = `  ${`durable answer for ${runId} `.repeat(400)}\n  `,
        ) => {
          const commentaryText = `commentary for ${runId}`;
          const commentaryNodeId = `commentary-${runId}`;
          const finalNodeId = `assistant-${runId}`;
          const commentaryMessageId = `commentary-message-${runId}`;
          const finalMessageId = `final-${runId}`;
          return {
            ...projection,
            runs: [
              {
                id: runId,
                threadId,
                ordinal: runId.endsWith("1") ? 1 : 2,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: `user-${runId}`,
                rootNodeId: `root-${runId}`,
                activeAttemptId: `attempt-${runId}`,
                status: "completed",
                requestedAt: "2026-10-14T00:00:00.000Z",
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
                checkpointId: `checkpoint-${runId}`,
              },
            ],
            nodes: [
              {
                id: commentaryNodeId,
                threadId,
                runId,
                parentNodeId: `root-${runId}`,
                rootNodeId: `root-${runId}`,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
              {
                id: finalNodeId,
                threadId,
                runId,
                parentNodeId: `root-${runId}`,
                rootNodeId: `root-${runId}`,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            attempts: [
              {
                id: `attempt-${runId}`,
                runId,
                attemptOrdinal: 1,
                rootNodeId: `root-${runId}`,
                providerInstanceId,
                providerThreadId: "provider-thread-test",
                providerTurnId: null,
                reason: "initial",
                status: "completed",
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            providerTurns: [
              {
                id: "provider-turn-test",
                providerThreadId: "provider-thread-test",
                nodeId: `root-${runId}`,
                runAttemptId: `attempt-${runId}`,
                nativeTurnRef: null,
                ordinal: 1,
                status: "completed",
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            subagents: [
              {
                id: `child-${runId}`,
                threadId,
                runId,
                parentNodeId: `root-${runId}`,
                origin: "app_owned",
                createdBy: "assistant",
                driver: "codex",
                providerInstanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "required child work",
                title: null,
                model: null,
                status: childStatus,
                result: null,
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: childStatus === "completed" ? "2026-10-14T00:00:03.000Z" : null,
                updatedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            messages: [
              {
                id: commentaryMessageId,
                threadId,
                runId,
                nodeId: commentaryNodeId,
                role: "assistant",
                text: commentaryText,
                streaming: false,
                attachments: [],
                createdAt: "2026-10-14T00:00:02.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
              },
              {
                id: finalMessageId,
                threadId,
                runId,
                nodeId: finalNodeId,
                role: "assistant",
                text: finalText,
                streaming: false,
                attachments: [],
                createdAt: "2026-10-14T00:00:02.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            turnItems: [
              {
                id: `commentary-item-${runId}`,
                threadId,
                runId,
                nodeId: commentaryNodeId,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
                type: "assistant_message",
                messageId: commentaryMessageId,
                text: commentaryText,
                streaming: false,
              },
              {
                id: `final-item-${runId}`,
                threadId,
                runId,
                nodeId: finalNodeId,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "completed",
                title: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
                type: "assistant_message",
                messageId: finalMessageId,
                text: finalText,
                streaming: false,
              },
            ],
            checkpoints: [],
          } as unknown as OrchestrationV2ThreadProjection;
        };
        const makeReadyProjection = (runId: string, ordinal: number, finalText?: string) =>
          ({
            ...makeRunProjection(runId, "completed", finalText),
            checkpoints: [
              {
                id: `checkpoint-${runId}`,
                threadId,
                scopeId: `scope-root-${ordinal}`,
                runId,
                nodeId: `root-${runId}`,
                parentCheckpointId: null,
                ordinalWithinScope: 1,
                appRunOrdinal: ordinal,
                ref: `checkpoint-ref-${ordinal}`,
                status: "ready",
                files: [],
                capturedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
          }) as unknown as OrchestrationV2ThreadProjection;
        const eventFor = (event: OrchestrationV2StoredEvent["event"]) =>
          ({
            sequence: 1,
            commandId: null,
            event,
          }) as OrchestrationV2StoredEvent;
        const waitForGateRead = () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                gateReadResolvers.push(resolve);
              }),
          );

        // The canonical job is held at its completion boundary while this same
        // conversation admits status, priority changes, and more transcript events.
        const completedFixture = makeRunProjection("durable-run-1", "running");
        durableProjection = {
          ...completedFixture,
          runs: completedFixture.runs.map((run) => ({
            ...run,
            status: "running",
            completedAt: null,
          })),
          messages: completedFixture.messages.filter((message) =>
            message.id.startsWith("commentary-"),
          ),
          providerTurns: completedFixture.providerTurns.map((turn) => ({
            ...turn,
            status: "running" as const,
            completedAt: null,
          })),
          turnItems: completedFixture.turnItems.map((item) =>
            item.type === "assistant_message" && item.ordinal === 2
              ? {
                  ...item,
                  type: "command_execution" as const,
                  input: "read-only inventory",
                  output: "PRIVATE_TOOL_DATA_MUST_NOT_FORWARD",
                }
              : item,
          ),
        };
        const firstContext = yield* Deferred.make<void>();
        const heldContext = yield* Deferred.make<void>();
        contextAppendGate = heldContext;
        contextSignals.set("commentary for durable-run-1", firstContext);
        const updateEvent = () =>
          eventFor({
            type: "turn-item.updated",
            id: "public-update-event",
            threadId,
            runId: "durable-run-1",
            nodeId: "root-durable-run-1",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.turnItems[0]!,
          } as never);
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Deferred.await(firstContext);
        assert.equal(
          yield* invoke("call-while-native-append-is-held", "Implement the requested change"),
          firstReceipt,
          "native output acknowledgement must not hold work admission",
        );
        assert.isFalse(yield* Deferred.isDone(heldContext));
        yield* sql`UPDATE codex_live_voice_intents SET receipt_json = json_set(receipt_json, '$.intakeIntent', json('{"id":"concurrent-intake-marker"}')) WHERE lease_id = ${prepared.leaseId} AND planner_turn_id = 'planner-turn-1'`;
        const progressSettled = waitForDelivery("commentary-message-durable-run-1");
        yield* Deferred.succeed(heldContext, undefined);
        yield* Effect.promise(() => progressSettled);
        const progressLedger = yield* sql<{
          receipt_json: string;
        }>`SELECT receipt_json FROM codex_live_voice_intents WHERE lease_id = ${prepared.leaseId} AND planner_turn_id = 'planner-turn-1'`;
        const progressReceipt = decodeJson(progressLedger[0]!.receipt_json) as {
          intakeIntent: { id: string };
          publicReadbacks: Record<string, { state: string }>;
        };
        assert.equal(progressReceipt.intakeIntent.id, "concurrent-intake-marker");
        assert.isTrue(
          Object.values(progressReceipt.publicReadbacks).some(
            (delivery) => delivery.state === "sent",
          ),
        );
        assert.deepEqual(
          contexts.map((message) => message.text),
          ["commentary for durable-run-1"],
        );
        assert.equal(
          completedWork,
          0,
          "public context arrives while the real work completion gate is still held",
        );
        assert.equal(
          spoken.length,
          0,
          "public context must not use forced speech during an unqualified speaking slot",
        );
        const question = "Soll ich zuerst den kleineren Befund erklären?";
        const beforeStreaming = durableProjection;
        const streamedFirst = "Ein erster geprüfter Befund liegt vor.";
        const streamedSecond = "Ein zweiter Befund folgt.";
        const streamedText = `${streamedFirst}\n\n${streamedSecond}`;
        durableProjection = {
          ...completedFixture,
          runs: completedFixture.runs.map((run) => ({
            ...run,
            status: "running",
            completedAt: null,
          })),
          providerTurns: completedFixture.providerTurns.map((turn) => ({
            ...turn,
            status: "running",
            completedAt: null,
          })),
          nodes: completedFixture.nodes.map((node) =>
            node.id === completedFixture.messages[1]!.nodeId
              ? { ...node, status: "running" }
              : node,
          ),
          messages: completedFixture.messages.slice(0, 1),
          turnItems: completedFixture.turnItems.map((item) =>
            item.type === "assistant_message" && item.ordinal === 2
              ? { ...item, streaming: true, status: "running", text: streamedText }
              : item,
          ),
        } as OrchestrationV2ThreadProjection;
        const firstParagraph = yield* Deferred.make<void>();
        contextSignals.set(streamedFirst, firstParagraph);
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Deferred.await(firstParagraph);
        assert.equal(contexts.at(-1)!.text, streamedFirst);
        assert.equal(spoken.length, 0, "streaming context must not force an interruption");
        assert.equal(completedWork, 0, "first paragraph arrives before work completion");
        const nextParagraph = yield* Deferred.make<void>();
        contextSignals.set(streamedSecond, nextParagraph);
        durableProjection = {
          ...durableProjection,
          turnItems: durableProjection.turnItems.map((item) =>
            item.type === "assistant_message" && item.ordinal === 2
              ? { ...item, text: `${streamedText}\n\nStill generating` }
              : item,
          ),
        };
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Deferred.await(nextParagraph);
        assert.deepEqual(
          contexts.splice(1).map((message) => message.text),
          [streamedFirst, streamedSecond],
          "repeated projection updates do not redeliver the first paragraph",
        );
        durableProjection = beforeStreaming;
        const secondContext = yield* Deferred.make<void>();
        contextSignals.set(question, secondContext);
        const firstMessage = durableProjection.messages[0]!;
        const firstItem = durableProjection.turnItems.find(
          (item) => item.type === "assistant_message",
        )!;
        const firstNode = durableProjection.nodes.find((node) => node.id === firstMessage.nodeId)!;
        const previousUpdate = "Der erste native Turn ist fertig; der Auftrag läuft weiter.";
        const previousTurn = {
          ...completedFixture.providerTurns[0]!,
          id: "previous-native-turn" as never,
        };
        const otherAttemptTurn = {
          ...previousTurn,
          id: "other-attempt-native-turn" as never,
          runAttemptId: "other-attempt" as never,
          ordinal: 99,
        };
        durableProjection = {
          ...durableProjection,
          providerTurns: [
            previousTurn,
            otherAttemptTurn,
            ...durableProjection.providerTurns.map((turn) => ({ ...turn, ordinal: 2 })),
          ],
          messages: [
            {
              ...firstMessage,
              id: "previous-turn-message" as never,
              nodeId: "previous-turn-node" as never,
              text: previousUpdate,
            },
            {
              ...firstMessage,
              id: "other-attempt-message" as never,
              nodeId: "other-attempt-node" as never,
              text: "OTHER_ATTEMPT_MUST_NOT_FORWARD",
            },
            ...durableProjection.messages,
            {
              ...firstMessage,
              id: "public-question" as never,
              nodeId: "public-question-node" as never,
              text: question,
            },
          ],
          nodes: [
            {
              ...firstNode,
              id: "previous-turn-node" as never,
              providerTurnId: previousTurn.id,
            },
            {
              ...firstNode,
              id: "other-attempt-node" as never,
              providerTurnId: otherAttemptTurn.id,
            },
            ...durableProjection.nodes,
            { ...firstNode, id: "public-question-node" as never },
          ],
          turnItems: [
            {
              ...firstItem,
              id: "previous-turn-item" as never,
              nodeId: "previous-turn-node" as never,
              providerTurnId: previousTurn.id,
              messageId: "previous-turn-message" as never,
              text: previousUpdate,
            },
            {
              ...firstItem,
              id: "other-attempt-item" as never,
              nodeId: "other-attempt-node" as never,
              providerTurnId: otherAttemptTurn.id,
              messageId: "other-attempt-message" as never,
              text: "OTHER_ATTEMPT_MUST_NOT_FORWARD",
            },
            ...durableProjection.turnItems,
            {
              ...firstItem,
              id: "public-question-item" as never,
              nodeId: "public-question-node" as never,
              messageId: "public-question" as never,
              text: question,
              ordinal: 3,
            },
            {
              ...firstItem,
              id: "private-next-item" as never,
              type: "command_execution",
              input: "read-only continuation",
              output: "PRIVATE_TOOL_CONTEXT_MUST_NOT_FORWARD",
              ordinal: 4,
            },
          ],
        } as OrchestrationV2ThreadProjection;
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Deferred.await(secondContext);
        assert.deepEqual(
          contexts.map((message) => message.text),
          ["commentary for durable-run-1", previousUpdate, question],
          "a later native turn admits the earlier turn's last answer once, within this attempt",
        );

        const betweenTurnsUpdate = "Öffentlicher Befund zwischen zwei nativen Turns.";
        const betweenTurnsContext = yield* Deferred.make<void>();
        contextSignals.set(betweenTurnsUpdate, betweenTurnsContext);
        durableProjection = {
          ...durableProjection,
          providerTurns: durableProjection.providerTurns.map((turn) => ({
            ...turn,
            status: "completed",
          })),
          messages: [
            ...durableProjection.messages,
            {
              ...firstMessage,
              id: "between-turns-message" as never,
              nodeId: "between-turns-node" as never,
              text: betweenTurnsUpdate,
            },
          ],
          nodes: [...durableProjection.nodes, { ...firstNode, id: "between-turns-node" as never }],
          turnItems: [
            ...durableProjection.turnItems,
            {
              ...firstItem,
              id: "between-turns-item" as never,
              nodeId: "between-turns-node" as never,
              messageId: "between-turns-message" as never,
              text: betweenTurnsUpdate,
              ordinal: 5,
            },
            {
              ...firstItem,
              id: "between-turns-next" as never,
              type: "command_execution",
              input: "read-only continuation",
              ordinal: 6,
            },
          ],
        } as OrchestrationV2ThreadProjection;
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Deferred.await(betweenTurnsContext);
        assert.deepEqual(
          contexts.map((message) => message.text),
          ["commentary for durable-run-1", previousUpdate, question, betweenTurnsUpdate],
        );

        const rawAsr = "  Original-ASR ohne Rekonstruktion. ".repeat(1000);
        yield* Queue.offer(nativeEvents, {
          type: "transcript",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: "foreign-session",
          role: "user",
          text: "STALE_ASR_MUST_NOT_FORWARD",
          segment: { id: "stale-asr", revision: 1, kind: "snapshot", final: true },
        });
        yield* Queue.offer(nativeEvents, {
          type: "transcript",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
          role: "user",
          text: rawAsr,
          segment: { id: "original-asr", revision: 1, kind: "snapshot", final: true },
        });
        const rawParts: string[] = [];
        for (let partIndex = 0; partIndex < Math.ceil(rawAsr.length / 16_384); partIndex += 1) {
          const event = yield* waitForEvent(
            (event) =>
              event.type === "transcript" &&
              event.segment?.id === "original-asr" &&
              event.segment.partIndex === partIndex,
          );
          if (event.type === "transcript") rawParts.push(event.text);
        }
        assert.equal(
          rawParts.join(""),
          rawAsr,
          "long original ASR is transported in bounded parts without clipping",
        );
        assert.isFalse(
          observedTranscripts.some((event) => event.text.includes("STALE_ASR_MUST_NOT_FORWARD")),
        );
        assert.equal(
          sends,
          1,
          "ASR segments and public output never authorize or dispatch new work",
        );
        const control = (
          action: "status" | "steer",
          callId: string,
          runId?: string,
          message?: string,
        ) =>
          controlWork!({
            plannerNativeThreadId: "planner-native-1",
            plannerTurnId: `conversation-${callId}`,
            callId,
            action,
            ...(runId === undefined ? {} : { runId }),
            ...(message === undefined ? {} : { message }),
          });
        const beforePriority = decodeWorkStatus(
          yield* control("status", "status-1", "durable-run-1"),
        );
        assert.equal(beforePriority.threadId, threadId);
        assert.equal(beforePriority.environmentId, "env-live-test");
        assert.equal(beforePriority.leaseId, prepared.leaseId);
        assert.equal(beforePriority.generation, prepared.generation);
        assert.deepEqual(beforePriority.tasks, [
          {
            runId: "durable-run-1",
            status: "running",
            resultReady: false,
            commentary: betweenTurnsUpdate,
          },
        ]);
        assert.equal(completedWork, 0);
        const savedProjection = durableProjection;
        const childThreadId = "child-thread-live" as never;
        childProjection = {
          ...durableProjection,
          thread: {
            ...durableProjection.thread,
            id: childThreadId,
            forkedFrom: { type: "node", nodeId: durableProjection.subagents[0]!.id },
            lineage: {
              parentThreadId: threadId,
              relationshipToParent: "subagent",
              rootThreadId: threadId,
            },
          },
          runs: durableProjection.runs.map((run) => ({ ...run, threadId: childThreadId })),
          turnItems: durableProjection.turnItems.map((item) => ({
            ...item,
            threadId: childThreadId,
          })),
          subagents: [],
        };
        durableProjection = {
          ...durableProjection,
          runs: durableProjection.runs.map((run) => ({ ...run, status: "completed" })),
          subagents: durableProjection.subagents.map((child) => ({ ...child, childThreadId })),
        };
        const withChild = yield* control("status", "parent-completed-child-running");
        const childReceipt = decodeCurrentWorkStatus(withChild);
        assert.equal(childReceipt.tasks[0]!.status, "completed");
        assert.isFalse(childReceipt.tasks[0]!.resultReady);
        assert.equal(childReceipt.tasks[0]!.visibility, "historical");
        assert.isNull(childReceipt.tasks[0]!.currentStep);
        assert.equal(childReceipt.delegatedTasks[0]!.status, "running");
        assert.equal(childReceipt.delegatedTasks[0]!.request, "required child work");
        assert.equal(childReceipt.delegatedTasks[0]!.lastUpdate, betweenTurnsUpdate);
        assert.isFalse(childReceipt.delegatedTasks[0]!.resultReady);
        assert.equal(sends, 1, "status must not create replacement work");
        childProjection = {
          ...childProjection,
          thread: {
            ...childProjection.thread,
            lineage: {
              ...childProjection.thread.lineage,
              parentThreadId: "foreign-parent" as never,
            },
          },
        };
        const foreignChild = decodeCurrentWorkStatus(yield* control("status", "foreign-child"));
        assert.equal(foreignChild.delegatedTasks[0]!.visibility, "unknown");
        assert.isNull(foreignChild.delegatedTasks[0]!.lastUpdate);
        durableProjection = {
          ...savedProjection,
          runs: [
            ...savedProjection.runs,
            ...Array.from({ length: 10 }, (_, i) => ({
              ...savedProjection.runs[0]!,
              id: `old-${i}` as never,
              ordinal: i + 10,
              status: "completed" as const,
            })),
          ],
        };
        assert.equal(
          decodeWorkStatus(yield* control("status", "active-first")).tasks[0]!.status,
          "running",
        );
        durableProjection = savedProjection;
        childProjection = undefined;
        const stalledRead = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        projectionGate = stalledRead;
        const statusFiber = yield* control("status", "bounded-read").pipe(Effect.forkChild);
        yield* Deferred.await(stalledRead.started);
        yield* TestClock.adjust("6 seconds");
        const unavailable = decodeCurrentWorkStatus(yield* Fiber.join(statusFiber));
        assert.equal(unavailable.visibility, "unavailable");
        assert.equal(unavailable.reason, "status_timeout");
        assert.equal(completedWork, 0);
        assert.equal(sends, 1, "timeout never creates replacement work");
        const staleContext = "Dieser Zwischenbefund gehört zum alten Kontext.";
        const contextLookup = holdDispatchPrincipalLookup();
        durableProjection = {
          ...durableProjection,
          messages: [
            ...durableProjection.messages,
            {
              ...firstMessage,
              id: "stale-public" as never,
              nodeId: "stale-public-node" as never,
              text: staleContext,
            },
          ],
          nodes: [...durableProjection.nodes, { ...firstNode, id: "stale-public-node" as never }],
          turnItems: [
            ...durableProjection.turnItems,
            {
              ...firstItem,
              id: "stale-public-item" as never,
              nodeId: "stale-public-node" as never,
              messageId: "stale-public" as never,
              text: staleContext,
              ordinal: 7,
            },
            {
              ...firstItem,
              id: "stale-public-next" as never,
              type: "command_execution",
              input: "read-only continuation",
              ordinal: 8,
            },
          ],
        } as OrchestrationV2ThreadProjection;
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* Effect.promise(() => contextLookup.started);
        const whileDeliveryBlocked = decodeWorkStatus(
          yield* control("status", "while-delivery-blocked"),
        );
        assert.equal(whileDeliveryBlocked.tasks[0]!.status, "running");
        assert.equal(
          completedWork,
          0,
          "status answers before delivery and work completion gates open",
        );
        currentPolicy = { ...policy, cwd: "/changed-during-public-delivery" };
        contextLookup.release();
        const afterRefusal = waitForGateRead();
        yield* Queue.offer(t3EventQueues.get("turn-item.updated")!, updateEvent());
        yield* afterRefusal;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              control("steer", "public-context-barrier", "durable-run-1", "must be refused"),
            ),
          ),
        );
        currentPolicy = policy;
        assert.isFalse(contexts.some((message) => message.text === staleContext));
        const refusedContext = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${prepared.leaseId} AND generation = ${prepared.generation}
            AND planner_turn_id = ${"planner-turn-1"}
        `;
        assert.equal(
          (
            decodeJson(refusedContext[0]!.receipt_json) as {
              publicReadbacks: Record<string, { state: string }>;
            }
          ).publicReadbacks["stale-public"]?.state,
          "refused",
        );
        yield* Queue.offer(nativeEvents, {
          type: "transcript",
          plannerNativeThreadId: "planner-native-1",
          role: "user",
          text: "Please prioritize the small fix while we keep talking.",
        });
        yield* waitForEvent(
          (event) => event.type === "transcript" && event.text.includes("prioritize"),
        );
        const priority = yield* control(
          "steer",
          "priority-1",
          "durable-run-1",
          "Prioritize the small fix.",
        );
        assert.equal(
          priority,
          yield* control("steer", "priority-1", "durable-run-1", "Prioritize the small fix."),
        );
        assert.equal(steers, 1);
        const changedSteerIntent = yield* Effect.exit(
          control("steer", "priority-1", "durable-run-1", "A different instruction."),
        );
        assert.isTrue(Exit.isFailure(changedSteerIntent));
        const afterPriority = decodeWorkStatus(yield* control("status", "status-2"));
        assert.equal(afterPriority.tasks[0]!.status, "running");
        assert.equal(completedWork, 0);
        assert.equal(sends, 1, "conversational control must never queue a replacement job");
        assert.equal(spoken.length, 0, "no invented final while canonical work is held");
        yield* Queue.offer(nativeEvents, {
          type: "transcript",
          plannerNativeThreadId: "planner-native-1",
          role: "assistant",
          text: "The task is still running; we can keep talking.",
        });
        yield* waitForEvent(
          (event) => event.type === "transcript" && event.text.includes("keep talking"),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(control("status", "foreign-run", "another-thread-run")),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              controlWork!({
                plannerNativeThreadId: "stale-planner",
                plannerTurnId: "stale",
                callId: "stale",
                action: "status",
              }),
            ),
          ),
        );
        currentPolicy = { ...currentPolicy, cwd: "/changed-context" };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              control("steer", "changed-context", "durable-run-1", "Must not cross contexts."),
            ),
          ),
        );
        currentPolicy = policy;
        const originalThread = durableProjection.thread;
        durableProjection = {
          ...durableProjection,
          thread: { ...originalThread, id: "other-thread" as never },
        };
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control("status", "changed-thread"))));
        durableProjection = { ...durableProjection, thread: originalThread };
        yield* sql`UPDATE codex_live_voice_leases SET environment_id = 'other-environment' WHERE lease_id = ${prepared.leaseId}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control("status", "changed-environment"))));
        yield* sql`UPDATE codex_live_voice_leases SET environment_id = 'env-live-test' WHERE lease_id = ${prepared.leaseId}`;
        rejectSteerAtAdmission = true;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              control("steer", "rollover", "durable-run-1", "Must not reach the next run."),
            ),
          ),
        );
        rejectSteerAtAdmission = false;
        assert.equal(steers, 1);
        assert.equal(sends, 1);
        yield* Deferred.succeed(workCompletion, undefined);

        durableProjection = makeRunProjection("durable-run-1", "running");
        const firstGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-1",
            threadId,
            runId: "durable-run-1",
            nodeId: "root-durable-run-1",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* firstGateRead;
        assert.equal(spoken.length, 0, "a still-running required child blocks speech");
        assert.deepEqual(
          decodeWorkStatus(yield* control("status", "child-pending", "durable-run-1")).tasks,
          [{ runId: "durable-run-1", status: "completed", resultReady: false, commentary: null }],
        );

        durableProjection = {
          ...durableProjection,
          subagents: [{ ...durableProjection.subagents[0]!, status: "completed" }],
          checkpoints: [
            { id: "checkpoint-durable-run-1", runId: "durable-run-1", status: "missing" },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const childGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("subagent.updated")!,
          eventFor({
            type: "subagent.updated",
            id: "event-child-1",
            threadId,
            runId: "durable-run-1",
            nodeId: "child-durable-run-1",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:04.000Z",
            payload: durableProjection.subagents[0] as never,
          } as never),
        );
        yield* childGateRead;
        yield* Effect.promise(() => speechObserved);
        yield* Deferred.await(workFinished);
        assert.equal(completedWork, 1, "the held canonical job completes exactly once");
        assert.deepEqual(
          decodeWorkStatus(yield* control("status", "result-ready", "durable-run-1")).tasks,
          [{ runId: "durable-run-1", status: "completed", resultReady: true, commentary: null }],
        );
        const followUp = decodeJson(yield* control("status", "follow-up-after-completion")) as {
          tasks: Array<{ runId: string; result: string }>;
        };
        assert.equal(followUp.tasks[0]!.runId, "durable-run-1");
        assert.include(followUp.tasks[0]!.result, "durable answer for durable-run-1");
        assert.isAtMost(followUp.tasks[0]!.result.length, 1_000);
        const fullResult = decodeJson(
          yield* control("status", "explicit-result", "durable-run-1"),
        ) as { tasks: Array<{ result: string }> };
        assert.isAbove(fullResult.tasks[0]!.result.length, 1_000);
        assert.deepEqual(spoken, [
          {
            plannerNativeThreadId: "planner-native-1",
            text: `  ${`durable answer for durable-run-1 `.repeat(400)}\n  `,
          },
        ]);
        assert.isFalse(
          contexts.some((message) => message.text.includes("durable answer for durable-run-1")),
          "the actual final answer is delivered only by the final path",
        );
        const sentReceipt = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${prepared.leaseId} AND generation = ${prepared.generation}
            AND planner_turn_id = ${"planner-turn-1"}
        `;
        assert.equal(readbackState(sentReceipt[0]!.receipt_json), "sent");
        speechObserved = new Promise<void>((resolve) => {
          resolveSpeech = resolve;
        });
        appendSpeechFails = true;
        yield* invoke("call-next", "Queue follow-up work", "planner-turn-2");
        assert.equal(sends, 2);
        durableProjection = {
          ...makeRunProjection("durable-run-2", "completed"),
          checkpoints: [
            {
              id: "checkpoint-durable-run-2",
              threadId,
              scopeId: "scope-root-2",
              runId: "durable-run-2",
              nodeId: "root-durable-run-2",
              parentCheckpointId: null,
              ordinalWithinScope: 1,
              appRunOrdinal: 2,
              ref: "checkpoint-ref-2",
              status: "ready",
              files: [],
              capturedAt: "2026-10-14T00:00:03.000Z",
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const ambiguousGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-2",
            threadId,
            runId: "durable-run-2",
            nodeId: "root-durable-run-2",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* ambiguousGateRead;
        yield* Effect.promise(() => appendAttemptObserved);
        assert.equal(appendAttempts, 2);
        assert.equal(
          spoken.length,
          1,
          "ambiguous append acknowledgement is not treated as delivery",
        );
        const unknownReceipt = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${prepared.leaseId} AND generation = ${prepared.generation}
            AND planner_turn_id = ${"planner-turn-2"}
        `;
        assert.equal(readbackState(unknownReceipt[0]!.receipt_json), "unknown");
        appendAttemptObserved = new Promise<void>((resolve) => {
          resolveAppendAttempt = resolve;
        });
        const duplicateReadback = yield* invoke(
          "call-next-retry",
          "Queue follow-up work",
          "planner-turn-2",
        );
        assert.equal(
          duplicateReadback,
          yield* invoke("call-next-again", "Queue follow-up work", "planner-turn-2"),
        );
        assert.equal(appendAttempts, 2, "a claimed readback is never blindly retried");

        appendSpeechFails = false;
        yield* invoke("call-empty-final", "Queue commentary and an empty final", "planner-turn-3");
        assert.equal(sends, 3);
        durableProjection = makeReadyProjection("durable-run-3", 3, " \t\n");
        const emptyFinalGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-3",
            threadId,
            runId: "durable-run-3",
            nodeId: "root-durable-run-3",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* emptyFinalGateRead;
        assert.equal(
          appendAttempts,
          2,
          "an empty terminal final item cannot fall back to earlier commentary",
        );
        const staleGeneration = yield* Effect.exit(
          service.status(session, {
            leaseId: prepared.leaseId,
            generation: prepared.generation + 1,
          }),
        );
        assert.isTrue(Exit.isFailure(staleGeneration));
        const staleReplay = yield* Effect.exit(
          invoke("call-stale-retry", "A request captured under old settings", "planner-turn-stale"),
        );
        assert.isTrue(Exit.isFailure(staleReplay));
        assert.equal(sends, 3);
        const changedIntent = yield* Effect.exit(invoke("call-3", "Submit a different request"));
        assert.isTrue(Exit.isFailure(changedIntent));
        assert.equal(sends, 3);

        const wrongSubject = {
          ...session,
          subject: "different-subject",
        };
        const unauthorized = yield* Effect.exit(
          service.status(wrongSubject, {
            leaseId: prepared.leaseId,
            generation: prepared.generation,
          }),
        );
        assert.isTrue(Exit.isFailure(unauthorized));

        const workReceiptBeforeStop = yield* invoke(
          "call-before-stop",
          "Queue work that must outlive Live",
          "planner-turn-4",
        );
        assert.equal(sends, 4);
        const beforeEnd = makeRunProjection("durable-run-4", "running");
        durableProjection = {
          ...beforeEnd,
          runs: beforeEnd.runs.map((run) => ({ ...run, status: "running" })),
        };
        const contextBeforeEnd = yield* Deferred.make<void>();
        const heldAtEnd = yield* Deferred.make<void>();
        contextAppendGate = heldAtEnd;
        contextSignals.set("commentary for durable-run-4", contextBeforeEnd);
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-held-at-end",
            threadId,
            runId: "durable-run-4",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0]!,
          } as never),
        );
        yield* Deferred.await(contextBeforeEnd);
        durableProjection = makeReadyProjection("durable-run-4", 4);
        const stopped = yield* service.stop(session, {
          leaseId: prepared.leaseId,
          generation: prepared.generation,
          clientRequestId: "stop-1",
        });
        assert.equal(stopped.status, "stopping");
        assert.isFalse(
          yield* Deferred.isDone(heldAtEnd),
          "End remains reachable during native I/O",
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control("status", "after-end"))));
        assert.equal(stops, 1);
        assert.equal(sends, 4);
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-4",
            threadId,
            runId: "durable-run-4",
            nodeId: "root-durable-run-4",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* Effect.yieldNow;
        assert.equal(
          appendAttempts,
          2,
          "Stop Live suppresses readback without cancelling queued work",
        );
        const acceptedWorkAfterStop = yield* invoke(
          "call-5",
          "Queue work that must outlive Live",
          "planner-turn-4",
        );
        assert.equal(acceptedWorkAfterStop, workReceiptBeforeStop);
        const afterStop = yield* Effect.exit(
          invoke("call-6", "A request after stopping is refused", "planner-turn-5"),
        );
        assert.isTrue(Exit.isFailure(afterStop));
        assert.equal(sends, 4);
        const statusesBeforeLateReadiness = observedStatuses.length;
        yield* Queue.offer(nativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
        });
        yield* Queue.offer(nativeEvents, {
          type: "sdp",
          plannerNativeThreadId: "planner-native-1",
          sdp: "late-answer-after-stop",
        });
        yield* Queue.offer(nativeEvents, {
          type: "closed",
          plannerNativeThreadId: "planner-native-1",
        });
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === prepared.leaseId &&
            event.session.generation === prepared.generation &&
            event.session.status === "closed",
        );

        assert.isFalse(
          observedStatuses.slice(statusesBeforeLateReadiness).includes("active"),
          "late readiness must not resurrect a stopping call",
        );

        durableProjection = {
          ...projection,
          providerSessions: [{ id: secondProviderSessionId, providerInstanceId }],
          runs: [],
          attempts: [],
          nodes: [],
          subagents: [],
          checkpoints: [],
          messages: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const secondPrepared = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-2",
        });
        assert.equal(secondPrepared.providerSessionId, secondProviderSessionId);
        assert.equal(secondPrepared.plannerNativeThreadId, "planner-native-2");
        yield* service
          .subscribe(session, {
            leaseId: secondPrepared.leaseId,
            generation: secondPrepared.generation,
          })
          .pipe(
            Stream.runForEach((event) => Queue.offer(delivered, event)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === secondPrepared.leaseId &&
            event.session.generation === secondPrepared.generation &&
            event.session.status === "prepared",
        );
        yield* service.start(session, {
          leaseId: secondPrepared.leaseId,
          generation: secondPrepared.generation,
          offerSdp: "v=0\\r\\n",
          clientRequestId: "start-2",
        });
        yield* Queue.offer(secondNativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
        });
        yield* Queue.offer(secondNativeEvents, {
          type: "sdp",
          plannerNativeThreadId: "planner-native-2",
          sdp: "v=0\\r\\nanswer",
        });
        yield* Queue.offer(secondNativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-2",
          realtimeSessionId: `${secondPrepared.leaseId}:${secondPrepared.generation}`,
        });
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === secondPrepared.leaseId &&
            event.session.generation === secondPrepared.generation &&
            event.session.status === "active",
        );

        assert.equal(
          (yield* service.status(session, {
            leaseId: prepared.leaseId,
            generation: prepared.generation,
          })).status,
          "closed",
          "an old planner notification cannot resurrect the ended call",
        );

        const raceReceipt = yield* invokeWithPlanner(
          "planner-native-2",
          "call-native-error-race",
          "Queue readback before a native failure",
          "planner-turn-native-error-race",
        );
        assert.equal(sends, 5);
        const raceRunId = `durable-run-${sends}`;
        durableProjection = makeReadyProjection(raceRunId, 5);
        const principalGate = holdDispatchPrincipalLookup();
        const raceGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-native-error-race",
            threadId,
            runId: raceRunId,
            nodeId: `root-${raceRunId}`,
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* raceGateRead;
        yield* Effect.promise(() => principalGate.started);
        yield* Queue.offer(secondNativeEvents, {
          type: "error",
          plannerNativeThreadId: "planner-native-2",
        });
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === secondPrepared.leaseId &&
            event.session.generation === secondPrepared.generation &&
            event.session.status === "failed",
        );
        const refusalSettled = waitForDelivery(`final-${raceRunId}`);
        principalGate.release();
        const duplicateRaceReceipt = yield* invokeWithPlanner(
          "planner-native-2",
          "call-native-error-race",
          "Queue readback before a native failure",
          "planner-turn-native-error-race",
        );
        assert.equal(duplicateRaceReceipt, raceReceipt);
        yield* Effect.promise(() => refusalSettled);
        assert.equal(sends, 5);
        assert.equal(
          appendAttempts,
          2,
          "a native failure committed during principal lookup prevents appendSpeech",
        );
        const refusedReceipt = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${secondPrepared.leaseId}
            AND generation = ${secondPrepared.generation}
            AND planner_turn_id = ${"planner-turn-native-error-race"}
        `;
        assert.equal(readbackState(refusedReceipt[0]!.receipt_json), "refused");
        assert.isString(raceReceipt);

        for (const code of ["managed_account_required", "planner_restriction_failed"] as const) {
          plannerFailure = code;
          const clientRequestId = `prepare-failure-${code}`;
          const error = yield* Effect.flip(service.prepare(session, { threadId, clientRequestId }));
          assert.equal(error.code, code);
          const failed = yield* service.prepare(session, { threadId, clientRequestId });
          assert.equal(failed.status, "failed");
          assert.isNull(failed.plannerNativeThreadId);
          const attempts = plannerAttempts;
          assert.equal(
            (yield* service.prepare(session, { threadId, clientRequestId })).leaseId,
            failed.leaseId,
          );
          assert.equal(plannerAttempts, attempts, "a failed prepare request remains idempotent");
        }

        const historical = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-failure-planner_restriction_failed",
        });
        const lease = {
          leaseId: historical.leaseId,
          generation: historical.generation,
          clientRequestId: "stop-historical",
        };
        yield* sql`UPDATE codex_live_voice_leases SET status = 'unknown' WHERE lease_id = ${lease.leaseId}`;
        const status = () =>
          service.status(session, lease).pipe(Effect.map((value) => value.status));
        for (const invalidPrincipal of [
          { ...session, scopes: [] },
          { ...session, subject: "different-subject" },
          { ...session, sessionId: AuthSessionId.make("different-session") },
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(service.stop(invalidPrincipal, lease))));
          assert.equal(yield* status(), "unknown");
        }
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.stop(session, { ...lease, generation: lease.generation + 1 }),
            ),
          ),
        );
        yield* sql`UPDATE codex_live_voice_leases SET principal_session_id = 'different-owner' WHERE lease_id = ${lease.leaseId}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(service.stop(session, lease))));
        yield* sql`UPDATE codex_live_voice_leases SET principal_session_id = ${sessionId},
          planner_native_thread_id = 'unresolved-native-planner', provider_session_id = NULL
          WHERE lease_id = ${lease.leaseId}`;
        assert.equal(
          (yield* service.stop(session, lease)).status,
          "unknown",
          "a lease that may own a native planner cannot be cleared locally",
        );
        yield* sql`UPDATE codex_live_voice_leases SET planner_native_thread_id = NULL WHERE lease_id = ${lease.leaseId}`;
        const stopsBeforeHistorical = stops;
        assert.equal((yield* service.stop(session, lease)).status, "failed");
        assert.equal(stops, stopsBeforeHistorical, "no native session exists to stop");
        const neverStartedOrphan = {
          principalSessionId: String(sessionId),
          principalSubject: session.subject,
          status: "unknown",
          plannerNativeThreadId: null as string | null,
          nativeStarted: 0,
          nativeSdpReceived: 0,
          startClientRequestId: null as string | null,
        };
        for (const unsafe of [
          {
            ...neverStartedOrphan,
            reason: "foreign-session",
            principalSessionId: "different-owner",
          },
          {
            ...neverStartedOrphan,
            reason: "foreign-subject",
            principalSubject: "different-subject",
          },
          { ...neverStartedOrphan, reason: "not-unknown", status: "prepared" },
          { ...neverStartedOrphan, reason: "planner", plannerNativeThreadId: "unresolved-planner" },
          { ...neverStartedOrphan, reason: "native-started", nativeStarted: 1 },
          { ...neverStartedOrphan, reason: "native-sdp", nativeSdpReceived: 1 },
          {
            ...neverStartedOrphan,
            reason: "start-request",
            startClientRequestId: "uncertain-start",
          },
        ]) {
          yield* sql`UPDATE codex_live_voice_leases SET
            principal_session_id = ${unsafe.principalSessionId},
            principal_subject = ${unsafe.principalSubject}, status = ${unsafe.status},
            planner_native_thread_id = ${unsafe.plannerNativeThreadId},
            native_started = ${unsafe.nativeStarted}, native_sdp_received = ${unsafe.nativeSdpReceived},
            start_client_request_id = ${unsafe.startClientRequestId}
            WHERE lease_id = ${lease.leaseId}`;
          const error = yield* Effect.flip(
            service.prepare(session, {
              threadId,
              clientRequestId: `unsafe-orphan-${unsafe.reason}`,
            }),
          );
          assert.equal(error.code, "dispatch_conflict", unsafe.reason);
          const persisted = yield* sql<{ status: string }>`
            SELECT status FROM codex_live_voice_leases WHERE lease_id = ${lease.leaseId}
          `;
          assert.equal(persisted[0]!.status, unsafe.status, "unsafe leases remain untouched");
        }
        yield* sql`UPDATE codex_live_voice_leases SET
          principal_session_id = ${sessionId}, principal_subject = ${session.subject}, status = 'unknown',
          planner_native_thread_id = NULL, native_started = 0, native_sdp_received = 0,
          start_client_request_id = NULL WHERE lease_id = ${lease.leaseId}`;
        plannerFailure = undefined;
        const retry = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-after-restart-orphan",
        });
        const retiredOrphan = yield* sql<{ status: string }>`
          SELECT status FROM codex_live_voice_leases WHERE lease_id = ${lease.leaseId}
        `;
        assert.equal(
          retiredOrphan[0]!.status,
          "failed",
          "new prepare retires only its own never-started orphan",
        );
        assert.equal(
          stops,
          stopsBeforeHistorical,
          "orphan recovery never calls the native runtime",
        );
        assert.equal(
          retry.status,
          "prepared",
          "failed preparation and historical empty leases do not block a new call",
        );
        yield* sql`UPDATE codex_live_voice_leases SET status = 'unknown',
          planner_native_thread_id = NULL WHERE lease_id = ${retry.leaseId}`;
        const activeConflict = yield* Effect.flip(
          service.prepare(session, {
            threadId,
            clientRequestId: "active-runtime-is-not-an-orphan",
          }),
        );
        assert.equal(
          activeConflict.code,
          "dispatch_conflict",
          "an in-memory active lease cannot be retired",
        );
        yield* sql`UPDATE codex_live_voice_leases SET status = 'prepared',
          planner_native_thread_id = ${retry.plannerNativeThreadId} WHERE lease_id = ${retry.leaseId}`;

        const endPrepared = (lease: LiveVoiceSession, principal = session) =>
          Effect.gen(function* () {
            yield* service.stop(principal, {
              leaseId: lease.leaseId,
              generation: lease.generation,
              clientRequestId: `end-${lease.leaseId}`,
            });
            yield* Queue.offer(runtimeEvents.get(lease.providerSessionId!)!, {
              type: "closed",
              plannerNativeThreadId: lease.plannerNativeThreadId!,
            });
            yield* service.subscribe(principal, lease).pipe(
              Stream.filter(
                (event) => event.type === "status" && event.session.status === "closed",
              ),
              Stream.runHead,
            );
          });
        yield* endPrepared(retry);
        const sharedTextSessionId = retry.providerSessionId;

        yield* sql`
          INSERT INTO codex_live_voice_leases (
            lease_id, generation, environment_id, thread_id, provider_instance_id,
            model_selection_json, runtime_policy_json, provider_session_id,
            planner_native_thread_id, principal_session_id, principal_subject,
            client_request_id, status, updated_at
          ) SELECT
            'foreign-shared-runtime', generation, environment_id, 'another-forked-thread',
            provider_instance_id, model_selection_json, runtime_policy_json, provider_session_id,
            'foreign-unknown-planner', 'another-principal', 'another-subject',
            'foreign-prepare', 'unknown', updated_at
          FROM codex_live_voice_leases WHERE lease_id = ${retry.leaseId}
        `;
        const stopsBeforeShared = stops;
        const shared = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-with-shared-text-runtime",
        });
        assert.equal(shared.status, "prepared");
        assert.notEqual(shared.providerSessionId, sharedTextSessionId);
        assert.lengthOf(openedRuntimes, 1);
        assert.equal(openedRuntimes[0]!.resumeFromSession?.id, sharedTextSessionId);
        assert.equal(stops, stopsBeforeShared, "a foreign voice lease is never stopped");
        const foreign = yield* sql<{ status: string; provider_session_id: string }>`
          SELECT status, provider_session_id FROM codex_live_voice_leases
          WHERE lease_id = 'foreign-shared-runtime'
        `;
        assert.equal(foreign[0]!.status, "unknown");
        assert.equal(foreign[0]!.provider_session_id, sharedTextSessionId);
        yield* endPrepared(shared);
        yield* sql`UPDATE codex_live_voice_leases SET status = 'closed'
          WHERE lease_id = 'foreign-shared-runtime'`;

        failNextLookup = true;
        const lookupFailure = yield* Effect.flip(
          service.prepare(session, { threadId, clientRequestId: "prepare-lookup-failure" }),
        );
        assert.equal(lookupFailure.code, "runtime_unavailable");
        const lookupOrphan = yield* sql<{ status: string }>`
          SELECT status FROM codex_live_voice_leases
          WHERE client_request_id = 'prepare-lookup-failure'
        `;
        assert.equal(lookupOrphan[0]!.status, "unknown");
        const afterLookup = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-after-lookup-failure",
        });
        assert.equal(afterLookup.providerSessionId, sharedTextSessionId);
        yield* endPrepared(afterLookup);

        yield* sql.unsafe(`CREATE TEMP TRIGGER reject_voice_binding
          BEFORE UPDATE OF provider_session_id ON codex_live_voice_leases
          WHEN NEW.provider_session_id IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'binding failed before planner'); END`);
        const attemptsBeforeBinding = plannerAttempts;
        const bindingFailure = yield* Effect.flip(
          service.prepare(session, { threadId, clientRequestId: "prepare-binding-failure" }),
        );
        assert.equal(bindingFailure.code, "runtime_unavailable");
        assert.equal(plannerAttempts, attemptsBeforeBinding);
        const bindingOrphan = yield* sql<{ status: string; provider_session_id: string | null }>`
          SELECT status, provider_session_id FROM codex_live_voice_leases
          WHERE client_request_id = 'prepare-binding-failure'
        `;
        assert.equal(bindingOrphan[0]!.status, "unknown");
        assert.isNull(bindingOrphan[0]!.provider_session_id);
        yield* sql.unsafe("DROP TRIGGER reject_voice_binding");

        // This is the persisted .57 failure: binding failed before cleanup existed.
        yield* sql`UPDATE codex_live_voice_leases SET status = 'preparing',
          principal_session_id = 'previous-browser-client'
          WHERE client_request_id = 'prepare-binding-failure'`;
        for (const unsafe of [
          { reason: "subject", subject: "another-subject" },
          { reason: "provider", providerSessionId: "unresolved-provider" },
          { reason: "planner", plannerNativeThreadId: "unresolved-planner" },
          { reason: "start", startRequestId: "uncertain-start" },
          { reason: "stop", stopRequestId: "uncertain-stop" },
          { reason: "native-started", nativeStarted: 1 },
          { reason: "native-sdp", nativeSdpReceived: 1 },
          { reason: "unknown", status: "unknown" },
        ]) {
          yield* sql`UPDATE codex_live_voice_leases SET
            status = ${unsafe.status ?? "preparing"},
            principal_subject = ${unsafe.subject ?? session.subject},
            provider_session_id = ${unsafe.providerSessionId ?? null},
            planner_native_thread_id = ${unsafe.plannerNativeThreadId ?? null},
            start_client_request_id = ${unsafe.startRequestId ?? null},
            stop_client_request_id = ${unsafe.stopRequestId ?? null},
            native_started = ${unsafe.nativeStarted ?? 0},
            native_sdp_received = ${unsafe.nativeSdpReceived ?? 0}
            WHERE client_request_id = 'prepare-binding-failure'`;
          const before = yield* sql`SELECT * FROM codex_live_voice_leases
            WHERE client_request_id = 'prepare-binding-failure'`;
          const refused = yield* Effect.flip(
            service.prepare(session, {
              threadId,
              clientRequestId: `cross-client-${unsafe.reason}`,
            }),
          );
          assert.equal(refused.code, "dispatch_conflict", unsafe.reason);
          assert.deepEqual(
            yield* sql`SELECT * FROM codex_live_voice_leases
              WHERE client_request_id = 'prepare-binding-failure'`,
            before,
            "a different client leaves ambiguous or foreign leases byte-for-byte unchanged",
          );
        }
        yield* sql`UPDATE codex_live_voice_leases SET status = 'preparing',
          principal_subject = ${session.subject}, provider_session_id = NULL,
          planner_native_thread_id = NULL, start_client_request_id = NULL,
          stop_client_request_id = NULL, native_started = 0, native_sdp_received = 0
          WHERE client_request_id = 'prepare-binding-failure'`;
        yield* sql`INSERT INTO codex_live_voice_intents (
          lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
          call_id, message, command_id, message_id, dispatch_state, updated_at
        ) SELECT lease_id, generation, 'unresolved-intent-planner', 'unresolved-intent-turn', 0,
          'orphan-intent-call', 'Pending work must be preserved', 'orphan-intent-command',
          'orphan-intent-message', 'reserved', updated_at
          FROM codex_live_voice_leases WHERE client_request_id = 'prepare-binding-failure'`;
        const intentConflict = yield* Effect.flip(
          service.prepare(session, { threadId, clientRequestId: "cross-client-pending-intent" }),
        );
        assert.equal(intentConflict.code, "dispatch_conflict");
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM codex_live_voice_leases
            WHERE client_request_id = 'prepare-binding-failure'`)[0]!.status,
          "preparing",
          "an empty-looking lease with durable work remains protected",
        );
        yield* sql`DELETE FROM codex_live_voice_intents WHERE call_id = 'orphan-intent-call'`;
        const stopsBeforeLegacy = stops;
        const recovered = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-after-historical-binding-failure",
        });
        assert.equal(recovered.status, "prepared");
        assert.equal(stops, stopsBeforeLegacy);
        const retiredBinding = yield* sql<{ status: string; principal_session_id: string }>`
          SELECT status, principal_session_id FROM codex_live_voice_leases
          WHERE client_request_id = 'prepare-binding-failure'
        `;
        assert.equal(retiredBinding[0]!.status, "failed");
        assert.equal(retiredBinding[0]!.principal_session_id, previousClient.sessionId);
        const attemptsBeforeReplay = plannerAttempts;
        const replay = yield* service.prepare(previousClient, {
          threadId,
          clientRequestId: "prepare-binding-failure",
        });
        assert.equal(
          replay.status,
          "failed",
          "the prior client's request keeps its original receipt",
        );
        assert.equal(
          plannerAttempts,
          attemptsBeforeReplay,
          "replay cannot create a second planner",
        );
        yield* endPrepared(recovered);

        yield* sql`UPDATE codex_live_voice_leases SET status = 'preparing'
          WHERE client_request_id = 'prepare-binding-failure'`;
        const racingPrincipals = [session, previousClient];
        const attemptsBeforeRace = plannerAttempts;
        const racing = yield* Effect.all(
          racingPrincipals.map((principal, index) =>
            service
              .prepare(principal, { threadId, clientRequestId: `orphan-race-${index}` })
              .pipe(Effect.exit),
          ),
          { concurrency: "unbounded" },
        );
        assert.equal(racing.filter(Exit.isSuccess).length, 1, "only one new lease wins admission");
        assert.equal(racing.filter(Exit.isFailure).length, 1);
        assert.equal(plannerAttempts, attemptsBeforeRace + 1);
        for (const [index, result] of racing.entries()) {
          if (Exit.isSuccess(result)) yield* endPrepared(result.value, racingPrincipals[index]!);
        }

        if (!reuseRuntime) {
          const gate = {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          lookupGate = gate;
          const firstFiber = yield* service
            .prepare(session, {
              threadId: "fork-prepare-a" as never,
              clientRequestId: "simultaneous-shared-a",
            })
            .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(gate.started);
          const second = yield* Effect.exit(
            service.prepare(session, {
              threadId: "fork-prepare-b" as never,
              clientRequestId: "simultaneous-shared-b",
            }),
          );
          yield* Deferred.succeed(gate.release, undefined);
          const first = yield* Fiber.join(firstFiber);
          if (Exit.isFailure(first) || Exit.isFailure(second)) {
            assert.fail(
              "Concurrent fork prepares must claim different voice runtimes before lookup.",
            );
          }
          assert.notEqual(first.value.providerSessionId, second.value.providerSessionId);
          assert.equal(first.value.status, "prepared");
          assert.equal(second.value.status, "prepared");
          yield* endPrepared(first.value);
          yield* endPrepared(second.value);
        } else {
          const gate = {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          plannerGate = gate;
          const failing = yield* service
            .prepare(session, {
              threadId,
              clientRequestId: "planner-will-fail-under-request-lock",
            })
            .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(gate.started);
          let markPreviousRead!: () => void;
          const previousRead = new Promise<void>((resolve) => {
            markPreviousRead = resolve;
          });
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (time, exit) => {
                end(time, exit);
                if (span.name === "VoiceIntake.processLatest") notifyIntakeProcessed?.();
                if (
                  String(span.attributes.get("db.query.text")).includes(
                    "ORDER BY updated_at DESC LIMIT 1",
                  )
                ) {
                  markPreviousRead();
                }
              };
              return span;
            },
          });
          const next = yield* service
            .prepare(previousClient, {
              threadId,
              clientRequestId: "prepare-after-in-flight-planner-failure",
            })
            .pipe(
              Effect.withTracer(tracer),
              Effect.exit,
              Effect.forkChild({ startImmediately: true }),
            );
          yield* Effect.promise(() => previousRead);
          yield* Deferred.succeed(gate.release, undefined);
          const failed = yield* Fiber.join(failing);
          assert.isTrue(Exit.isFailure(failed));
          const result = yield* Fiber.join(next);
          if (Exit.isFailure(result)) {
            assert.fail(
              "A prepare waiting on the prior request must re-read its terminal failure.",
            );
          }
          assert.equal(result.value.status, "prepared");
          yield* endPrepared(result.value, previousClient);
        }

        durableProjection = {
          ...durableProjection,
          thread: { ...durableProjection.thread, deletedAt: null },
          runs: [],
          attempts: [],
          nodes: [],
          messages: [],
          turnItems: [],
          providerTurns: [],
          subagents: [],
          checkpoints: [],
        };
        const independentSeeds = new Map<string, OrchestrationV2ThreadProjection>();
        let admissions = 0;
        admitIndependent = (command) =>
          Effect.gen(function* () {
            const index = ++admissions;
            const childId = ThreadId.make(`independent-child-${index}`);
            const childRunId = RunId.make(`independent-run-${index}`);
            const taskId = NodeId.make(`independent-task-${index}`);
            const admissionId = RunId.make(`independent-admission-${index}`);
            const seed = makeRunProjection(
              childRunId,
              "completed",
              `Final findings for task ${index}.`,
            );
            const completed = {
              ...seed,
              thread: {
                ...seed.thread,
                id: childId,
                deletedAt: null,
                lineage: {
                  parentThreadId: threadId,
                  relationshipToParent: "subagent" as const,
                  rootThreadId: threadId,
                },
                ...(command.delegation?.voiceIntake
                  ? { voiceIntake: command.delegation.voiceIntake }
                  : {}),
                forkedFrom: { type: "node" as const, nodeId: taskId },
              },
              runs: seed.runs.map((run) => ({ ...run, threadId: childId })),
              messages: seed.messages.map((message) => ({ ...message, threadId: childId })),
              turnItems: seed.turnItems.map((item) => ({ ...item, threadId: childId })),
              nodes: seed.nodes.map((node) => ({ ...node, threadId: childId })),
              subagents: [],
            } as OrchestrationV2ThreadProjection;
            independentSeeds.set(childId, completed);
            independentJobs.set(childId, {
              ...completed,
              runs: completed.runs.map((run) => ({ ...run, status: "running", completedAt: null })),
              providerTurns: completed.providerTurns.map((turn) => ({
                ...turn,
                status: "running",
                completedAt: null,
              })),
              turnItems: completed.turnItems.map((item) =>
                item.type === "assistant_message" && item.ordinal === 2
                  ? { ...item, status: "running", streaming: true, text: "Still generating" }
                  : item,
              ),
              nodes: completed.nodes.map((node) =>
                node.id === completed.messages[1]!.nodeId ? { ...node, status: "running" } : node,
              ),
            });
            const queues = new Map<string, Queue.Queue<OrchestrationV2StoredEvent>>();
            for (const eventType of t3EventQueues.keys())
              queues.set(eventType, yield* Queue.unbounded<OrchestrationV2StoredEvent>());
            independentQueues.set(childId, queues);
            const task = {
              ...seed.subagents[0]!,
              id: taskId,
              threadId,
              runId: admissionId,
              parentNodeId: NodeId.make(`admission-root-${index}`),
              origin: "app_owned" as const,
              childThreadId: childId,
              prompt: command.text,
              status: "running" as const,
              title: command.text,
            };
            durableProjection = {
              ...durableProjection,
              runs: [
                ...durableProjection.runs,
                {
                  ...seed.runs[0]!,
                  id: admissionId,
                  threadId,
                  delegationAdmission: command.delegation,
                  providerThreadId: null,
                  activeAttemptId: null,
                },
              ],
              subagents: [...durableProjection.subagents, task],
            };
            return {
              sequence: admissions,
              storedEvents: [
                eventFor({ type: "subagent.updated", threadId, payload: task } as never),
                eventFor({
                  type: "run.created",
                  threadId: childId,
                  payload: independentJobs.get(childId)!.runs[0]!,
                } as never),
              ],
            };
          });
        const parallelLease = yield* service.prepare(session, {
          threadId,
          clientRequestId: "parallel-voice-replay",
        });
        const ready = yield* service.subscribe(session, parallelLease).pipe(
          Stream.filter((event) => event.type === "status" && event.session.status === "active"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* service.start(session, {
          ...parallelLease,
          clientRequestId: "parallel-start",
          offerSdp: "synthetic-offer",
        });
        const replayEvents = runtimeEvents.get(parallelLease.providerSessionId!)!;
        yield* Queue.offer(replayEvents, {
          type: "started",
          plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
          realtimeSessionId: `${parallelLease.leaseId}:${parallelLease.generation}`,
        });
        yield* Queue.offer(replayEvents, {
          type: "sdp",
          plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
          sdp: "synthetic-answer",
        });
        yield* Fiber.join(ready);
        const submit = (
          index: number,
          plannerTurnId = "one-native-start-or-steer-turn",
          message = `Independent request ${index}`,
        ) =>
          submitWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId,
            callId: `native-call-${index}-${plannerTurnId}`,
            requestId: `logical-task-${index}`,
            message,
          });
        const receipts: Array<Record<string, string>> = [];
        for (let index = 1; index <= 3; index++)
          receipts.push(decodeJson(yield* submit(index)) as Record<string, string>);
        assert.equal(admissions, 3, "one native turn can admit three independent logical tasks");
        assert.deepEqual(decodeJson(yield* submit(1, "repeated-native-handoff")), receipts[0]);
        assert.equal(admissions, 3, "repeated handoffs retain the same logical task identity");
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              submit(1, "changed-handoff", "Different task under the same identity"),
            ),
          ),
        );
        const taskControl = (
          index: number,
          action: "status" | "steer",
          callId: string,
          message?: string,
          runId = receipts[index]!.runId!,
        ) =>
          controlWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId: `control-${callId}`,
            callId,
            taskId: receipts[index]!.taskId!,
            runId,
            action,
            ...(message === undefined ? {} : { message }),
          });
        const parallelStatus = decodeJson(
          yield* controlWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId: "status-all",
            callId: "status-all",
            action: "status",
          }),
        ) as { tasks: unknown[]; delegatedTasks: Array<{ status: string; resultReady: boolean }> };
        assert.deepEqual(
          parallelStatus.tasks,
          [],
          "completed admissions are not finished provider work",
        );
        assert.deepEqual(
          parallelStatus.delegatedTasks.map((task) => [task.status, task.resultReady]),
          Array.from({ length: 3 }, () => ["running", false]),
        );
        const chunk = "First useful finding while the other tasks are still running.";
        const chunkArrived = yield* Deferred.make<void>();
        contextSignals.set(
          JSON.stringify({
            type: "background_task_output",
            taskId: receipts[0]!.taskId,
            requestId: receipts[0]!.requestId,
            runId: receipts[0]!.runId,
            kind: "update",
            resultReady: false,
            text: chunk,
          }),
          chunkArrived,
        );
        const firstChild = receipts[0]!.threadId!;
        const streaming = independentJobs.get(firstChild)!;
        independentJobs.set(firstChild, {
          ...streaming,
          turnItems: streaming.turnItems.map((item) =>
            item.type === "assistant_message" && item.ordinal === 2
              ? { ...item, text: `${chunk}\n\nUnfinished tail` }
              : item,
          ),
        });
        const publishChild = (index: number, eventType: "run.updated" | "turn-item.updated") => {
          const childId = receipts[index]!.threadId!;
          const child = independentJobs.get(childId)!;
          return Queue.offer(
            independentQueues.get(childId)!.get(eventType)!,
            eventFor({
              type: eventType,
              threadId: childId,
              runId: receipts[index]!.runId,
              payload: eventType === "run.updated" ? child.runs[0]! : child.turnItems[0]!,
            } as never),
          );
        };
        yield* publishChild(0, "turn-item.updated");
        yield* Deferred.await(chunkArrived);
        assert.deepEqual(
          decodeJson(yield* submit(1, "handoff-after-public-chunk")),
          receipts[0],
          "public-output bookkeeping preserves a logical submission receipt, including its null destination",
        );
        const firstSteerReceipt = yield* taskControl(
          0,
          "steer",
          "refine-first",
          "Keep the findings concise.",
        );
        const firstSteerMessage = independentJobs.get(firstChild)!.messages.at(-1)!;
        const steersBefore = steers;
        yield* taskControl(1, "steer", "refine-second", "Focus on the smaller issue.");
        yield* taskControl(1, "steer", "refine-second", "Focus on the smaller issue.");
        assert.equal(steers, steersBefore + 1);
        assert.equal(
          independentJobs.get(receipts[1]!.threadId!)!.messages.at(-1)!.text,
          "Focus on the smaller issue.",
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              taskControl(
                1,
                "steer",
                "foreign-run",
                "Must not reach task three",
                receipts[2]!.runId,
              ),
            ),
          ),
        );
        speechObserved = new Promise<void>((resolve) => {
          resolveSpeech = resolve;
        });
        const firstCompletedSeed = independentSeeds.get(firstChild)!;
        independentJobs.set(firstChild, {
          ...firstCompletedSeed,
          messages: [...firstCompletedSeed.messages, firstSteerMessage],
        });
        yield* publishChild(0, "run.updated");
        yield* Effect.promise(() => speechObserved);
        assert.deepEqual(decodeJson(spoken.at(-1)!.text), {
          type: "background_task_output",
          taskId: receipts[0]!.taskId,
          requestId: receipts[0]!.requestId,
          runId: receipts[0]!.runId,
          kind: "result",
          resultReady: true,
          text: "Final findings for task 1.",
        });
        assert.equal(independentJobs.get(receipts[1]!.threadId!)!.runs[0]!.status, "running");
        assert.equal(independentJobs.get(receipts[2]!.threadId!)!.runs[0]!.status, "running");
        const completedChild = independentJobs.get(firstChild)!;
        const completedRun = completedChild.runs[0]!;
        independentJobs.set(firstChild, {
          ...completedChild,
          runs: [
            ...completedChild.runs,
            {
              ...completedRun,
              id: RunId.make("nested-admission-status-only"),
              ordinal: completedRun.ordinal + 1,
              delegationAdmission: { modelSelection: completedChild.thread.modelSelection },
            },
            {
              ...completedRun,
              id: RunId.make("foreign-followup-task-run"),
              ordinal: completedRun.ordinal + 2,
              status: "running",
              delegatedTaskId: NodeId.make("foreign-followup-task"),
            },
          ],
        });
        const exactTask = decodeJson(
          yield* controlWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId: "exact-task-status",
            callId: "exact-task-status",
            action: "status",
            taskId: receipts[0]!.taskId!,
          }),
        ) as { delegatedTasks: Array<{ runId: string; resultReady: boolean }> };
        assert.equal(
          exactTask.delegatedTasks[0]!.runId,
          receipts[0]!.runId,
          "task status skips nested admission runs",
        );
        assert.isTrue(exactTask.delegatedTasks[0]!.resultReady);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              taskControl(
                0,
                "steer",
                "foreign-followup",
                "Do not steer another task in the same child",
                "foreign-followup-task-run",
              ),
            ),
          ),
        );
        const originalTask = durableProjection.subagents.find(
          (task) => task.id === receipts[0]!.taskId,
        )!;
        durableProjection = {
          ...durableProjection,
          subagents: [
            ...durableProjection.subagents,
            { ...originalTask, id: NodeId.make("foreign-followup-task") },
          ],
        };
        const followupStatus = decodeJson(
          yield* controlWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId: "followup-task-status",
            callId: "followup-task-status",
            action: "status",
            taskId: "foreign-followup-task",
          }),
        ) as { delegatedTasks: Array<{ runId: string }> };
        assert.equal(
          followupStatus.delegatedTasks[0]!.runId,
          "foreign-followup-task-run",
          "persisted follow-up ownership remains readable",
        );
        const aggregateAfterAdmission = decodeJson(
          yield* controlWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId: "aggregate-after-admission",
            callId: "aggregate-after-admission",
            action: "status",
          }),
        ) as { delegatedTasks: Array<{ taskId: string; resultReady: boolean }> };
        assert.isTrue(
          aggregateAfterAdmission.delegatedTasks.find(
            (task) => task.taskId === receipts[0]!.taskId,
          )!.resultReady,
        );
        const finished = decodeJson(yield* taskControl(0, "status", "first-result")) as {
          delegatedTasks: Array<{ resultReady: boolean; result: string }>;
        };
        assert.isTrue(finished.delegatedTasks[0]!.resultReady);
        assert.equal(finished.delegatedTasks[0]!.result, "Final findings for task 1.");
        const steersAfterCompletion = steers;
        const messagesAfterCompletion = independentJobs.get(firstChild)!.messages;
        assert.equal(
          yield* taskControl(0, "steer", "refine-first", "Keep the findings concise."),
          firstSteerReceipt,
          "an accepted steer receipt still replays after its exact run completes",
        );
        const inactiveReceipt = decodeJson(
          yield* taskControl(0, "steer", "completed-task", "Add more detail to the findings."),
        ) as Record<string, unknown>;
        assert.include(inactiveReceipt, {
          accepted: false,
          reason: "task_inactive",
          delivery: "not_steered",
          taskId: receipts[0]!.taskId,
          threadId: firstChild,
          runId: receipts[0]!.runId,
          status: "completed",
          resultReady: true,
          result: "Final findings for task 1.",
        });
        assert.deepEqual(
          decodeJson(
            yield* taskControl(0, "steer", "completed-task", "Add more detail to the findings."),
          ),
          inactiveReceipt,
          "an inactive-task retry retains the exact completed task and its result",
        );
        assert.equal(steers, steersAfterCompletion);
        assert.equal(admissions, 3, "completed-task steering never admits replacement work");
        assert.strictEqual(independentJobs.get(firstChild)!.messages, messagesAfterCompletion);
        assert.equal(independentJobs.get(firstChild)!.runs[0]!.status, "completed");
        const beforeDelete = independentJobs.get(firstChild)!;
        independentJobs.set(firstChild, {
          ...beforeDelete,
          thread: { ...beforeDelete.thread, deletedAt: yield* DateTime.now },
        });
        const afterDelete = decodeJson(
          yield* controlWork!({
            plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
            plannerTurnId: "deleted-child-status",
            callId: "deleted-child-status",
            action: "status",
          }),
        ) as {
          delegatedTasks: Array<{ taskId: string; resultReady: boolean; result: string | null }>;
        };
        assert.isFalse(
          afterDelete.delegatedTasks.find((task) => task.taskId === receipts[0]!.taskId)!
            .resultReady,
        );
        assert.isNull(
          afterDelete.delegatedTasks.find((task) => task.taskId === receipts[0]!.taskId)!.result,
        );
        const failedChild = receipts[2]!.threadId!;
        const failedState = JSON.stringify({
          type: "background_task_state",
          runId: receipts[2]!.runId,
          status: "failed",
          resultReady: false,
        });
        const failureArrived = yield* Deferred.make<void>();
        contextSignals.set(
          JSON.stringify({
            type: "background_task_output",
            taskId: receipts[2]!.taskId,
            requestId: receipts[2]!.requestId,
            runId: receipts[2]!.runId,
            kind: "update",
            resultReady: false,
            text: failedState,
          }),
          failureArrived,
        );
        const third = independentJobs.get(failedChild)!;
        independentJobs.set(failedChild, {
          ...third,
          runs: third.runs.map((run) => ({ ...run, status: "failed" })),
        });
        yield* publishChild(2, "run.updated");
        yield* Deferred.await(failureArrived);
        const failedReceipt = decodeJson(
          yield* taskControl(2, "steer", "failed-task", "Do not replace failed work"),
        ) as Record<string, unknown>;
        assert.include(failedReceipt, {
          accepted: false,
          reason: "task_inactive",
          delivery: "not_steered",
          taskId: receipts[2]!.taskId,
          threadId: failedChild,
          runId: receipts[2]!.runId,
          status: "failed",
          resultReady: false,
          result: null,
        });
        assert.equal(steers, steersAfterCompletion);
        assert.equal(independentJobs.get(failedChild)!.runs[0]!.status, "failed");
        assert.equal(admissions, 3, "failure and rejected steering never create replacement tasks");
        yield* service.stop(session, { ...parallelLease, clientRequestId: "parallel-end" });
        assert.equal(
          independentJobs.get(receipts[1]!.threadId!)!.runs[0]!.status,
          "running",
          "EndCall does not cancel independent work",
        );
        const previousClosed = yield* service.subscribe(session, parallelLease).pipe(
          Stream.filter((event) => event.type === "status" && event.session.status === "closed"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Queue.offer(replayEvents, {
          type: "closed",
          plannerNativeThreadId: parallelLease.plannerNativeThreadId!,
        });
        yield* Fiber.join(previousClosed);
        const sourceThread = durableProjection.thread;
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
           interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
          VALUES (${threadId}, ${sourceThread.projectId}, ${"Voice intake fixture"}, ${sourceThread.providerInstanceId},
           ${sourceThread.providerInstanceId}, ${sourceThread.runtimeMode}, ${sourceThread.interactionMode},
           NULL, '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z', NULL, NULL, ${JSON.stringify(sourceThread)})`;
        expectedNewTaskOwner = "intake";
        let decideIntakeSnapshot: NonNullable<
          ProviderAdapter.ProviderAdapterV2LiveVoiceRuntime["decideIntake"]
        > = ({ snapshot }) =>
          Effect.succeed({
            requestId: snapshot.requestId,
            actions: snapshot.segments
              .filter(
                (segment) =>
                  !snapshot.intents.some((intent) =>
                    intent.sources.some((source) => source.segmentId === segment.id),
                  ),
              )
              .map((segment) => ({
                type: "new" as const,
                projectId: null,
                sources: [
                  {
                    segmentId: segment.id,
                    revision: segment.revision,
                    start: 0,
                    end: segment.text.length,
                    quote: segment.text,
                  },
                ],
                request: segment.text,
                readOnly: true,
              })),
          });
        intakeDecision = (input) => {
          assert.equal(
            input.modelSelection.options?.find((option) => option.id === "reasoningEffort")?.value,
            "low",
          );
          return decideIntakeSnapshot(input);
        };
        const intakeLease = yield* service.prepare(session, {
          threadId,
          clientRequestId: "exclusive-intake",
        });
        const intakeReady = yield* service.subscribe(session, intakeLease).pipe(
          Stream.filter((event) => event.type === "status" && event.session.status === "active"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* service.start(session, {
          ...intakeLease,
          clientRequestId: "exclusive-start",
          offerSdp: "synthetic-offer",
        });
        const intakeEvents = runtimeEvents.get(intakeLease.providerSessionId!)!;
        yield* Queue.offer(intakeEvents, {
          type: "started",
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          realtimeSessionId: `${intakeLease.leaseId}:${intakeLease.generation}`,
        });
        yield* Queue.offer(intakeEvents, {
          type: "sdp",
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          sdp: "synthetic-answer",
        });
        yield* Fiber.join(intakeReady);
        yield* sql.unsafe("CREATE TEMP TABLE intake_receipt_update_probe (used INTEGER NOT NULL)");
        yield* sql.unsafe("INSERT INTO intake_receipt_update_probe VALUES (0)");
        yield* sql.unsafe(`CREATE TEMP TRIGGER drop_one_intake_receipt_update BEFORE UPDATE ON codex_live_voice_intents
          WHEN OLD.dispatch_state = 'reserved' AND NEW.dispatch_state = 'admitted' AND (SELECT used FROM intake_receipt_update_probe) = 0
          BEGIN UPDATE intake_receipt_update_probe SET used = 1; SELECT RAISE(IGNORE); END`);
        for (let index = 0; index < 3; index++) {
          const processed = new Promise<void>((resolve) => {
            notifyIntakeProcessed = resolve;
          });
          const text = `Independent intake research ${index}`;
          yield* Queue.offer(intakeEvents, {
            type: "transcript",
            role: "user",
            plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
            text,
            segment: { id: `intake-segment-${index}`, revision: 1, kind: "snapshot", final: false },
          });
          if (index > 0) yield* TestClock.adjust("3 seconds");
          yield* Effect.promise(() => processed);
        }
        notifyIntakeProcessed = undefined;
        assert.equal(
          admissions,
          6,
          "three partial ASR snapshots reach independent admissions before final or any new completion",
        );
        const intakeRows = yield* sql<{
          receipt_json: string;
        }>`SELECT receipt_json FROM codex_live_voice_intents WHERE lease_id = ${intakeLease.leaseId} AND dispatch_state = 'admitted'`;
        assert.equal(
          intakeRows.length,
          3,
          "the committed child repairs a lost auxiliary receipt update without another admission",
        );
        assert.equal(
          (yield* sql<{ used: number }>`SELECT used FROM intake_receipt_update_probe`)[0]!.used,
          1,
        );
        for (const record of intakeRows) {
          const receipt = decodeJson(record.receipt_json) as {
            intakeIntent: { taskId: string; provisional: boolean; sources: unknown[] };
            voiceIntake: { intentId: string };
          };
          assert.isTrue(receipt.intakeIntent.provisional);
          assert.equal(receipt.intakeIntent.sources.length, 1);
          assert.isTrue(
            durableProjection.subagents.some((task) => task.id === receipt.intakeIntent.taskId),
          );
        }
        const continuing = decodeJson(intakeRows[0]!.receipt_json) as {
          intakeIntent: { id: string; threadId: string; runId: string; taskId: string };
        };
        const previousRuns = independentJobs
          .get(continuing.intakeIntent.threadId)!
          .runs.map((run) => run.id);
        decideIntakeSnapshot = ({ snapshot }) => {
          const segment = snapshot.segments.find(
            (candidate) => candidate.id === "confirmed-continuation",
          )!;
          const sources = [
            { segmentId: segment.id, revision: segment.revision, quote: segment.text },
          ];
          return Effect.succeed({
            requestId: snapshot.requestId,
            actions: [
              { type: "confirm" as const, intentId: continuing.intakeIntent.id, sources },
              {
                type: "refine" as const,
                intentId: continuing.intakeIntent.id,
                sources,
                message: segment.text,
                readOnly: false,
              },
            ],
          });
        };
        for (const revision of [1, 2]) {
          const continued = new Promise<void>((resolve) => {
            notifyIntakeProcessed = resolve;
          });
          yield* Queue.offer(intakeEvents, {
            type: "transcript",
            role: "user",
            plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
            text: "Yes, implement that confirmed task now.",
            segment: {
              id: "confirmed-continuation",
              revision,
              kind: "snapshot",
              final: revision > 1,
            },
          });
          yield* TestClock.adjust("3 seconds");
          yield* Effect.promise(() => continued);
        }
        assert.equal(
          authorizedRestarts,
          1,
          "complete nonfinal refinement promotes and restarts the same provisional run only once",
        );
        assert.deepEqual(
          independentJobs.get(continuing.intakeIntent.threadId)!.runs.map((run) => run.id),
          previousRuns,
        );
        assert.isFalse(
          independentJobs.get(continuing.intakeIntent.threadId)!.thread.voiceIntake!.provisional,
        );
        assert.equal(admissions, 6, "authorized continuation is not a replacement admission");
        const mainInputs: Array<Parameters<NonNullable<typeof mainSend>>[0]> = [];
        const mainReceipts = new Map<
          string,
          Effect.Success<ReturnType<NonNullable<typeof mainSend>>>
        >();
        durableProjection = makeRunProjection("main-live-work", "running");
        durableProjection = {
          ...durableProjection,
          runs: durableProjection.runs.map((run) => ({
            ...run,
            status: "running",
            completedAt: null,
          })),
        };
        mainSend = (input, options) =>
          Effect.gen(function* () {
            assert.isDefined(
              options?.voiceIntakeCommitGuard,
              "intake carries its runtime commit fence",
            );
            const held = beforeSourceCommit;
            beforeSourceCommit = undefined;
            if (held) {
              yield* Deferred.succeed(held.started, options!.voiceIntakeCommitGuard!);
              yield* Deferred.await(held.release);
            }
            return yield* guarded(
              options,
              input.commandId,
              Effect.sync(() => {
                const prior = mainReceipts.get(input.commandId);
                if (prior) return prior;
                assert.equal(input.mode, "auto");
                assert.equal(input.threadId, threadId);
                assert.equal(input.voiceIntakeSourceThreadId, threadId);
                assert.isFalse(input.voiceIntakeSource!.provisional);
                mainInputs.push(input);
                const run = durableProjection.runs[0]!;
                durableProjection = {
                  ...durableProjection,
                  messages: [
                    ...durableProjection.messages,
                    {
                      ...durableProjection.messages[0]!,
                      id: input.messageId,
                      threadId,
                      runId: run.id,
                      role: "user",
                      text: input.text,
                    },
                  ],
                };
                const result = {
                  delivery: mainInputs.length === 1 ? "started" : "steered",
                  run,
                } as Effect.Success<ReturnType<NonNullable<typeof mainSend>>>;
                mainReceipts.set(input.commandId, result);
                return result;
              }),
            );
          });
        const mainDecisions = yield* Queue.unbounded<{
          snapshot: Parameters<typeof decideIntakeSnapshot>[0]["snapshot"];
          answer: Deferred.Deferred<Effect.Success<ReturnType<typeof decideIntakeSnapshot>>>;
        }>();
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.gen(function* () {
            const answer =
              yield* Deferred.make<Effect.Success<ReturnType<typeof decideIntakeSnapshot>>>();
            yield* Queue.offer(mainDecisions, { snapshot, answer });
            return yield* Deferred.await(answer);
          });
        const selected = "button#selected-before-classification";
        const previewObserved = yield* Deferred.make<void>();
        contextSignals.set(
          `Selected preview context (reference data):\n${selected}`,
          previewObserved,
        );
        const releasePreview = yield* Deferred.make<void>();
        previewContextGate = releasePreview;
        yield* service.context(session, { ...intakeLease, revision: 1, context: selected });
        yield* Deferred.await(previewObserved);
        const mainClause = "Change the selected button to green.";
        yield* Queue.offer(intakeEvents, {
          type: "transcript",
          role: "user",
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          text: mainClause,
          segment: { id: "authorized-main", revision: 1, kind: "snapshot", final: false },
        });
        const mainFirst = yield* Queue.take(mainDecisions);
        assert.equal(mainFirst.snapshot.previewContext, selected);
        yield* service.context(session, { ...intakeLease, revision: 2, context: null });
        yield* service.context(session, {
          ...intakeLease,
          revision: 1,
          context: "stale selection",
        });
        yield* sql`UPDATE intake_receipt_update_probe SET used = 0`;
        let mainProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* Deferred.succeed(mainFirst.answer, {
          requestId: mainFirst.snapshot.requestId,
          actions: [
            {
              type: "new",
              projectId: null,
              request: mainClause,
              readOnly: false,
              sources: [{ segmentId: "authorized-main", revision: 1, quote: mainClause }],
            },
          ],
        });
        yield* Effect.promise(() => mainProcessed);
        assert.equal(
          mainInputs.length,
          1,
          "native context acknowledgement does not block work admission",
        );
        assert.include(mainInputs[0]!.text, selected);
        assert.notInclude(mainInputs[0]!.text, "stale selection");
        yield* Deferred.succeed(releasePreview, undefined);
        const mainStored = yield* sql<{
          receipt_json: string;
        }>`SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${intakeLease.leaseId} AND message = ${mainClause} AND dispatch_state = 'admitted'`;
        assert.equal(
          mainStored.length,
          1,
          "committed Main message repairs a lost auxiliary receipt update",
        );
        const mainReceipt = decodeJson(mainStored[0]!.receipt_json) as {
          previewContext: string;
          intakeIntent: { id: string; threadId: string; provisional: boolean };
        };
        assert.equal(mainReceipt.previewContext, selected);
        assert.equal(mainReceipt.intakeIntent.threadId, threadId);
        assert.isFalse(mainReceipt.intakeIntent.provisional);
        const laterText = `${mainClause} Keep its existing label. Also add a search field.`;
        yield* Queue.offer(intakeEvents, {
          type: "transcript",
          role: "user",
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          text: laterText,
          segment: { id: "authorized-main", revision: 2, kind: "snapshot", final: false },
        });
        const mainLater = yield* Queue.take(mainDecisions);
        assert.isNull(mainLater.snapshot.previewContext, "a stale revision cannot undo Clear");
        mainProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        const anchor = (quote: string) => ({ segmentId: "authorized-main", revision: 2, quote });
        yield* Deferred.succeed(mainLater.answer, {
          requestId: mainLater.snapshot.requestId,
          actions: [
            {
              type: "new",
              projectId: null,
              request: mainClause,
              readOnly: false,
              sources: [anchor(mainClause)],
            },
            {
              type: "refine",
              intentId: mainReceipt.intakeIntent.id,
              message: "Keep the existing label.",
              readOnly: false,
              sources: [anchor("Keep its existing label.")],
            },
            {
              type: "new",
              projectId: null,
              request: "Add a search field.",
              readOnly: false,
              sources: [anchor("Also add a search field.")],
            },
          ],
        });
        yield* Effect.promise(() => mainProcessed);
        assert.equal(mainInputs.length, 2, "two independent requests use auto admission");
        assert.equal(mainRefinements.length, 1, "the refinement targets its exact existing run");
        assert.deepEqual(mainRefinements[0]!.dispatchMode, {
          type: "steer_active",
          targetRunId: RunId.make("main-live-work"),
          onInactive: "reject",
        });
        assert.equal(admissions, 6, "authorized Main work creates no forced child");
        yield* service.status(session, intakeLease);
        assert.equal(mainInputs.length, 2, "recovery never resends committed Main work");
        const mainStatus = decodeJson(
          yield* controlWork!({
            plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
            plannerTurnId: "main-status",
            callId: "main-status",
            action: "status",
            runId: "main-live-work",
          }),
        ) as { tasks: Array<{ runId: string }> };
        assert.equal(mainStatus.tasks[0]!.runId, "main-live-work");
        // Preparing/queued runs retain a constraint until that exact run is steerable.
        durableProjection = {
          ...durableProjection,
          runs: durableProjection.runs.map((run) => ({ ...run, status: "preparing" })),
        };
        const pendingClause = "Keep focus on the search field after submit.";
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.succeed({
            requestId: snapshot.requestId,
            actions: [
              {
                type: "refine",
                intentId: mainReceipt.intakeIntent.id,
                message: pendingClause,
                readOnly: false,
                sources: [{ segmentId: "preparing-constraint", revision: 1, quote: pendingClause }],
              },
            ],
          });
        let preparingProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* Queue.offer(intakeEvents, {
          type: "transcript",
          role: "user",
          text: pendingClause,
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          segment: { id: "preparing-constraint", revision: 1, kind: "snapshot", final: false },
        });
        yield* Effect.promise(() => preparingProcessed);
        assert.equal(mainRefinements.length, 1, "a preparing run cannot be steered yet");
        const pendingRecord = yield* sql<{
          receipt_json: string;
        }>`SELECT receipt_json FROM codex_live_voice_intents WHERE planner_turn_id = ${`request:${mainReceipt.intakeIntent.id}`}`;
        assert.equal(
          (
            decodeJson(pendingRecord[0]!.receipt_json) as {
              intakeIntent: { pendingSteer: { message: string } };
            }
          ).intakeIntent.pendingSteer.message,
          pendingClause,
        );
        durableProjection = {
          ...durableProjection,
          runs: durableProjection.runs.map((run) => ({ ...run, status: "running" })),
        };
        preparingProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "main-became-steerable",
            threadId,
            runId: "main-live-work",
            nodeId: null,
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:04.000Z",
            payload: durableProjection.runs[0]!,
          } as never),
        );
        yield* Effect.promise(() => preparingProcessed);
        assert.equal(
          mainRefinements.length,
          2,
          "the run event delivers its retained source-bound constraint",
        );
        assert.equal(mainInputs.length, 2);

        // Only the Main run is active during this quiet-call observation.
        const savedJobs = new Map(independentJobs);
        for (const [id, job] of savedJobs)
          independentJobs.set(id, {
            ...job,
            runs: job.runs.map((run) => ({ ...run, status: "completed" })),
          });
        const quietCount = () =>
          spoken.filter((item) => item.text.startsWith("Die Arbeit läuft noch.")).length;
        const beforeQuiet = quietCount();
        yield* TestClock.adjust("45 seconds");
        assert.equal(quietCount(), beforeQuiet, "current user speech suppresses quiet progress");
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.succeed({ requestId: snapshot.requestId, actions: [] });
        const emitSpeech = Effect.fnUntraced(function* (
          role: "user" | "assistant",
          text: string,
          id: string,
          revision: number,
          final: boolean,
        ) {
          const subscribed = yield* Deferred.make<void>();
          const delivered = yield* service.subscribe(session, intakeLease).pipe(
            Stream.tap((event) =>
              event.type === "status" ? Deferred.succeed(subscribed, undefined) : Effect.void,
            ),
            Stream.filter(
              (event) => event.type === "transcript" && event.role === role && event.text === text,
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(subscribed);
          yield* Queue.offer(intakeEvents, {
            type: "transcript",
            role,
            text,
            plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
            segment: { id, revision, kind: "snapshot", final },
          });
          yield* Fiber.join(delivered);
        });
        const timeoutError = () =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: ProviderDriverKind.make("codex"),
            detail: "PRIVATE_PROVIDER_TEXT_MUST_NOT_LOG",
            cause: new Cause.TimeoutError("PRIVATE_TIMEOUT_TEXT_MUST_NOT_LOG"),
          });
        let timeoutCalls = 0;
        decideIntakeSnapshot = () => {
          timeoutCalls++;
          return Effect.fail(timeoutError());
        };
        let timeoutProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* emitSpeech("user", "A standalone status question.", "timeout-retry", 1, true);
        yield* Effect.promise(() => timeoutProcessed);
        assert.equal(timeoutCalls, 2, "unchanged timed-out snapshot gets exactly one retry");
        const loggedWarnings = JSON.stringify(warningMessages);
        assert.include(loggedWarnings, "TimeoutError");
        assert.notInclude(loggedWarnings, "PRIVATE_PROVIDER_TEXT_MUST_NOT_LOG");
        assert.notInclude(loggedWarnings, "PRIVATE_TIMEOUT_TEXT_MUST_NOT_LOG");
        const startedTimeout = yield* Deferred.make<void>();
        const failOld = yield* Deferred.make<void>();
        const latestClassified = yield* Deferred.make<number>();
        const decidedVersions: number[] = [];
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.gen(function* () {
            decidedVersions.push(snapshot.version);
            if (decidedVersions.length === 1) {
              yield* Deferred.succeed(startedTimeout, undefined);
              yield* Deferred.await(failOld);
              return yield* timeoutError();
            }
            yield* Deferred.succeed(latestClassified, snapshot.version);
            return { requestId: snapshot.requestId, actions: [] };
          });
        yield* emitSpeech("user", "What is its current status?", "timeout-newer", 1, false);
        yield* Deferred.await(startedTimeout);
        yield* emitSpeech(
          "user",
          "What is its current status? Just a factual question.",
          "timeout-newer",
          2,
          true,
        );
        yield* Deferred.succeed(failOld, undefined);
        const latestVersion = yield* Deferred.await(latestClassified);
        assert.equal(
          decidedVersions.length,
          2,
          "newer snapshot wins immediately over an obsolete timeout retry",
        );
        assert.isAbove(latestVersion, decidedVersions[0]!);
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.succeed({ requestId: snapshot.requestId, actions: [] });
        yield* emitSpeech("user", laterText, "authorized-main", 3, true);
        yield* emitSpeech("assistant", "Ich höre weiter zu.", "speaking-assistant", 1, false);
        yield* TestClock.adjust("45 seconds");
        assert.equal(
          quietCount(),
          beforeQuiet,
          "current assistant speech suppresses quiet progress",
        );
        yield* emitSpeech("assistant", "Ich höre weiter zu.", "speaking-assistant", 2, true);
        quietSpeechSignal = yield* Deferred.make<void>();
        yield* TestClock.adjust("45 seconds");
        yield* Deferred.await(quietSpeechSignal);
        assert.equal(
          quietCount(),
          beforeQuiet + 1,
          "one factual spoken update after a quiet threshold",
        );
        yield* TestClock.adjust("90 seconds");
        assert.equal(quietCount(), beforeQuiet + 1, "unchanged evidence never repeats as filler");
        for (const [id, job] of savedJobs) independentJobs.set(id, job);
        const requestId = "voice-public-question";
        const publicQuestion = "Soll die Suche auch archivierte Einträge finden?";
        const questionText = JSON.stringify({
          type: "background_task_question",
          runId: "main-live-work",
          questions: [{ question: publicQuestion, options: ["Nur aktive", "Auch archivierte"] }],
        });
        const questionDelivered = yield* Deferred.make<void>();
        contextSignals.set(questionText, questionDelivered);
        const questionItem = {
          ...durableProjection.turnItems[0]!,
          id: "voice-public-question-item",
          type: "user_input_request",
          requestId,
          ordinal: 10,
          questions: [
            {
              id: "archive",
              header: "Suchumfang",
              question: publicQuestion,
              options: [
                { label: "Nur aktive", description: "Aktive Einträge" },
                { label: "Auch archivierte", description: "Alle Einträge" },
              ],
            },
          ],
        };
        durableProjection = {
          ...durableProjection,
          turnItems: [...durableProjection.turnItems, questionItem as never],
          runtimeRequests: [
            ...(durableProjection.runtimeRequests ?? []),
            {
              id: requestId,
              nodeId: questionItem.nodeId,
              providerTurnId: questionItem.providerTurnId,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: "2026-10-14T00:00:04.000Z",
              resolvedAt: null,
            } as never,
          ],
        };
        yield* Queue.offer(
          t3EventQueues.get("turn-item.updated")!,
          eventFor({
            type: "turn-item.updated",
            id: "main-public-question",
            threadId,
            runId: "main-live-work",
            nodeId: questionItem.nodeId,
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:04.000Z",
            payload: questionItem,
          } as never),
        );
        yield* Deferred.await(questionDelivered);
        assert.equal(
          contexts.at(-1)!.text,
          questionText,
          "pending public questions reach realtime without waiting for completion",
        );

        const staleClause = "Change the selected button to purple.";
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.succeed({
            requestId: snapshot.requestId,
            actions:
              snapshot.segments.at(-1)?.id === "source-revoked"
                ? []
                : [
                    {
                      type: "new",
                      projectId: null,
                      request: staleClause,
                      readOnly: false,
                      sources: [{ segmentId: "stale-commit", revision: 1, quote: staleClause }],
                    },
                  ],
          });
        const guardedCommitStarted =
          yield* Deferred.make<NonNullable<DispatchRuntimeOptions["voiceIntakeCommitGuard"]>>();
        const releaseGuardedCommit = yield* Deferred.make<void>();
        beforeSourceCommit = { started: guardedCommitStarted, release: releaseGuardedCommit };
        yield* emitSpeech("user", staleClause, "stale-commit", 1, false);
        const sourceGuard = yield* Deferred.await(guardedCommitStarted);
        yield* emitSpeech("user", "No, do not change that button.", "source-revoked", 1, true);
        assert.isFalse(
          sourceGuard.isCurrent(),
          "revocation during downstream I/O invalidates the runtime commit fence",
        );
        const refusedCommit = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* Deferred.succeed(releaseGuardedCommit, undefined);
        yield* Effect.promise(() => refusedCommit);
        assert.equal(
          mainInputs.length,
          2,
          "stale work never commits after sendToThread's downstream I/O",
        );
        yield* service.status(session, intakeLease);
        assert.equal(mainInputs.length, 2, "recovery cannot revive a refused intake reservation");
        assert.equal(
          admissions,
          6,
          "refused reserved intake never falls through to native child admission",
        );

        // End the owned run exactly after read, while another run becomes active.
        const oldRun = durableProjection.runs[0]!;
        beforeMainCommit = () => {
          beforeMainCommit = undefined;
          durableProjection = {
            ...durableProjection,
            runs: [
              { ...oldRun, status: "completed" },
              {
                ...oldRun,
                id: RunId.make("unrelated-new-run"),
                status: "running",
                ordinal: oldRun.ordinal + 1,
              },
            ],
          };
        };
        const raceClause = "Keep the existing accessible name.";
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.succeed({
            requestId: snapshot.requestId,
            actions: [
              {
                type: "refine",
                intentId: mainReceipt.intakeIntent.id,
                message: raceClause,
                readOnly: false,
                sources: [{ segmentId: "run-race", revision: 1, quote: raceClause }],
              },
            ],
          });
        const beforeRaceMessages = durableProjection.messages.length;
        const raceProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* emitSpeech("user", raceClause, "run-race", 1, false);
        yield* Effect.promise(() => raceProcessed);
        assert.deepEqual(mainRefinements.at(-1)!.dispatchMode, {
          type: "steer_active",
          targetRunId: oldRun.id,
          onInactive: "reject",
        });
        assert.equal(
          durableProjection.messages.length,
          beforeRaceMessages,
          "rejected stale steering cannot reach the new active run",
        );
        assert.equal(mainInputs.length, 2, "a stale refinement cannot auto-start replacement work");

        const decidingBeforeStop = yield* Deferred.make<void>();
        const finishAfterStop = yield* Deferred.make<void>();
        decideIntakeSnapshot = ({ snapshot }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(decidingBeforeStop, undefined);
            yield* Deferred.await(finishAfterStop);
            const segment = snapshot.segments.find((candidate) => candidate.id === "before-stop")!;
            return {
              requestId: snapshot.requestId,
              actions: [
                {
                  type: "new" as const,
                  projectId: null,
                  sources: [
                    { segmentId: segment.id, revision: segment.revision, quote: segment.text },
                  ],
                  request: segment.text,
                  readOnly: true,
                },
              ],
            };
          });
        const stoppedDecisionProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* Queue.offer(intakeEvents, {
          type: "transcript",
          role: "user",
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          text: "Old request during Stop.",
          segment: { id: "before-stop", revision: 1, kind: "snapshot", final: false },
        });
        yield* TestClock.adjust("3 seconds");
        yield* Deferred.await(decidingBeforeStop);
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,
          '$.voiceIntakeStopId', 'committed-stop-fixture') WHERE thread_id = ${threadId}`;
        yield* Deferred.succeed(finishAfterStop, undefined);
        yield* Effect.promise(() => stoppedDecisionProcessed);
        assert.equal(
          admissions,
          6,
          "PubSub intake rejects a decision after its durable source Stop marker changes",
        );
        const lateFinalProcessed = new Promise<void>((resolve) => {
          notifyIntakeProcessed = resolve;
        });
        yield* Queue.offer(intakeEvents, {
          type: "transcript",
          role: "user",
          plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
          text: "Old request during Stop.",
          segment: { id: "before-stop", revision: 2, kind: "snapshot", final: true },
        });
        yield* TestClock.adjust("3 seconds");
        yield* Effect.promise(() => lateFinalProcessed);
        notifyIntakeProcessed = undefined;
        assert.equal(admissions, 6, "a native late final cannot rebind its original source fence");
        assert.isTrue(
          Exit.isFailure(
            yield* submitWork!({
              plannerNativeThreadId: intakeLease.plannerNativeThreadId!,
              plannerTurnId: "late-native-handoff",
              callId: "late-native",
              requestId: "must-not-create",
              message: "Independent intake research 0",
            }).pipe(Effect.exit),
          ),
        );
        assert.equal(
          admissions,
          6,
          "the service also rejects native submissions in exclusive mode",
        );
        yield* service.stop(session, { ...intakeLease, clientRequestId: "exclusive-end" });
        const afterStopQuiet = quietCount();
        yield* TestClock.adjust("90 seconds");
        assert.equal(quietCount(), afterStopQuiet, "ended leases cannot speak quiet progress");
        assert.isTrue(
          Exit.isFailure(
            yield* service
              .context(session, {
                ...intakeLease,
                revision: 3,
                context: "closed lease selection",
              })
              .pipe(Effect.exit),
          ),
        );

        assert.equal(
          [...independentJobs.values()].filter((job) => job.runs[0]?.status === "running").length >=
            3,
          true,
        );
      });
      yield* program.pipe(
        Effect.withTracer(deliveryTracer),
        Effect.provide(
          Layer.merge(
            Logger.layer([warningLogger], { mergeWithExisting: false }),
            Layer.provideMerge(CodexLiveSessionService.layer, dependencies),
          ),
        ),
      );
    }),
);
