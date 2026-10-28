import {
  AuthOrchestrationOperateScope,
  CommandId,
  ThreadId,
  VoiceIntakeIntent,
  VoiceIntakeProvenance,
  LiveVoiceError,
  latestProviderTurnForAttempt,
  MessageId,
  NodeId,
  ProjectId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  type LiveVoiceEvent,
  type LiveVoicePrepareInput,
  type LiveVoiceSession,
  type LiveVoiceStartInput,
  type LiveVoiceStopInput,
  type LiveVoiceSubscribeInput,
  type LiveVoiceContextInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import { makeVoiceIntake, transferVoiceIntakeClaim } from "./VoiceIntake.ts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  OrchestratorDispatchError,
  OrchestratorSteerTemporarilyUnavailableError,
} from "../orchestration-v2/Orchestrator.ts";
import type { DispatchRuntimeOptions } from "../orchestration-v2/DispatchRuntimeOptions.ts";
import * as ConversationWorkCoordinator from "../orchestration-v2/ConversationWorkCoordinator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CodexLiveEventHub from "./CodexLiveEventHub.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import { isVoiceWorkActive, voiceRunStatus } from "./voiceWorkStatus.ts";
import { voiceAnswerParagraphs } from "./voiceAnswerParagraphs.ts";
import { voiceStartupHistory } from "./voiceStartupHistory.ts";
import { voiceIntakeInstruction } from "./voiceIntakeInstruction.ts";

type LeaseRow = {
  lease_id: string;
  generation: number;
  environment_id: string;
  thread_id: string;
  provider_instance_id: string;
  model_selection_json: string;
  runtime_policy_json: string;
  provider_session_id: string | null;
  planner_native_thread_id: string | null;
  principal_session_id: string;
  principal_subject: string;
  client_request_id: string;
  start_client_request_id: string | null;
  stop_client_request_id: string | null;
  status: LiveVoiceSession["status"];
  native_started: number;
  native_sdp_received: number;
  updated_at: string;
};

const leaseKey = (leaseId: string, generation: number) => `${leaseId}:${generation}`;
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeRuntimePolicy = Schema.encodeSync(
  Schema.fromJsonString(ProviderAdapter.ProviderAdapterV2RuntimePolicy),
);
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeReceipt = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const isLiveVoiceError = Schema.is(LiveVoiceError);
const isDispatchError = Schema.is(OrchestratorDispatchError);
const isTransientSteerError = Schema.is(OrchestratorSteerTemporarilyUnavailableError);
const isProviderAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);
const isIntakeTimeout = (error: unknown, depth = 0): boolean => {
  if (depth > 6 || typeof error !== "object" || error === null) return false;
  if (
    ("_tag" in error && error._tag === "TimeoutError") ||
    ("name" in error && error.name === "TimeoutError")
  )
    return true;
  if (Cause.isCause(error)) {
    const failure = Cause.findErrorOption(error);
    return Option.isSome(failure) && isIntakeTimeout(failure.value, depth + 1);
  }
  return "cause" in error && isIntakeTimeout(error.cause, depth + 1);
};
const intakeFailureClass = (cause: Cause.Cause<unknown>) => {
  if (isIntakeTimeout(cause)) return "TimeoutError";
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    if (isProviderAdapterError(error.value)) return error.value._tag;
    if (isLiveVoiceError(error.value)) return `LiveVoiceError:${error.value.code}`;
  }
  return Cause.hasInterruptsOnly(cause) ? "Interrupted" : Cause.hasDies(cause) ? "Defect" : "Error";
};

const isIntakeIntent = Schema.is(VoiceIntakeIntent);
const isIntakeProvenance = Schema.is(VoiceIntakeProvenance);
const encodeIntakeProvenance = Schema.encodeSync(Schema.fromJsonString(VoiceIntakeProvenance));
const readbackContextMatches = (
  row: LeaseRow,
  projection: OrchestrationV2ThreadProjection,
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
) =>
  projection.thread.id === row.thread_id &&
  projection.thread.archivedAt === null &&
  projection.thread.deletedAt === null &&
  projection.thread.providerInstanceId === row.provider_instance_id &&
  encodeModelSelection(projection.thread.modelSelection) === row.model_selection_json &&
  encodeRuntimePolicy(policy) === row.runtime_policy_json;
const sessionFromRow = (row: LeaseRow): LiveVoiceSession => ({
  leaseId: row.lease_id,
  generation: row.generation,
  environmentId: row.environment_id as LiveVoiceSession["environmentId"],
  threadId: row.thread_id as LiveVoiceSession["threadId"],
  providerInstanceId: row.provider_instance_id as LiveVoiceSession["providerInstanceId"],
  providerSessionId: row.provider_session_id as LiveVoiceSession["providerSessionId"],
  plannerNativeThreadId: row.planner_native_thread_id,
  status: row.status,
});

const liveError = (code: LiveVoiceError["code"]) => new LiveVoiceError({ code });
const withPreviewContext = (message: string, context: string | null | undefined) =>
  context ? `${message}\n\nSelected preview context (reference data):\n${context}` : message;

export class CodexLiveSessionService extends Context.Service<
  CodexLiveSessionService,
  {
    readonly prepare: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoicePrepareInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly start: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceStartInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly stop: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceStopInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly status: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceSubscribeInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly subscribe: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceSubscribeInput,
    ) => Stream.Stream<LiveVoiceEvent, LiveVoiceError>;
    readonly context: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceContextInput,
    ) => Effect.Effect<void, LiveVoiceError>;
  }
>()("t3/voice/CodexLiveSessionService") {}

export const layer: Layer.Layer<
  CodexLiveSessionService,
  never,
  | SqlClient.SqlClient
  | SessionStore.SessionStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | RuntimePolicy.RuntimePolicyV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ThreadManagementService.ThreadManagementService
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | Crypto.Crypto
> = Layer.effect(
  CodexLiveSessionService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const authSessions = yield* SessionStore.SessionStore;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const runtimePolicies = yield* RuntimePolicy.RuntimePolicyV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const conversationWork = yield* ConversationWorkCoordinator.ConversationWorkCoordinator;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const eventHub = yield* CodexLiveEventHub.CodexLiveEventHub;
    const crypto = yield* Crypto.Crypto;
    const serviceScope = yield* Effect.scope;
    const leaseLocks = yield* KeyedLock.make<string>();
    // Native append acknowledgements must not hold admission, steering or End.
    const outputLocks = yield* KeyedLock.make<string>();
    const intakes = new Map<string, ReturnType<typeof makeVoiceIntake>>();
    const intakeWakes = new Map<string, Queue.Queue<void>>();
    const intakeSourceStops = new WeakMap<LiveVoiceEvent, string | null>();
    const readIntakeStopId = Effect.fn("CodexLiveSessionService.readIntakeStopId")(
      function* (threadId: string) {
        const rows = yield* sql<{
          marker_type: string | null;
          stop_id: string | null;
          unavailable: number;
        }>`
        SELECT json_type(payload_json, '$.voiceIntakeStopId') AS marker_type,
          json_extract(payload_json, '$.voiceIntakeStopId') AS stop_id,
          (json_extract(payload_json, '$.deletedAt') IS NOT NULL OR json_extract(payload_json, '$.archivedAt') IS NOT NULL) AS unavailable
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
        const row = rows[0];
        if (!row || row.unavailable) return undefined;
        if (row.marker_type === null) return null;
        return row.marker_type === "text" && row.stop_id?.trim() ? row.stop_id : undefined;
      },
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const readbackWorkers = new Map<string, Fiber.Fiber<void, never>>();
    const nativeEventRuntimes = new Set<ProviderAdapter.ProviderAdapterV2SessionRuntime>();
    let transcriptSequence = 0;
    const active = new Map<
      string,
      {
        readonly leaseId: string;
        readonly generation: number;
        previewContext?: string | null;
        contextRevision?: number;
        acceptingWork?: boolean;
        sourceSemaphore?: Semaphore.Semaphore;
        lastSpeechAt?: number;
        lastQuietStatusAt?: number;
        userSpeaking?: boolean;
        assistantSpeaking?: boolean;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly plannerNativeThreadId: string;
      }
    >();

    const getLease = (leaseId: string, generation: number) =>
      sql<LeaseRow>`
        SELECT * FROM codex_live_voice_leases WHERE lease_id = ${leaseId} AND generation = ${generation}
      `.pipe(Effect.map((rows) => rows[0]));

    const getOwnedLease = Effect.fn("CodexLiveSessionService.getOwnedLease")(function* (
      principalSessionId: string,
      leaseId: string,
      generation: number,
    ) {
      const row = yield* getLease(leaseId, generation);
      if (row === undefined || row.principal_session_id !== principalSessionId) {
        return yield* liveError("session_not_found");
      }
      return row;
    });

    const ensurePrincipal = Effect.fn("CodexLiveSessionService.ensurePrincipal")(function* (
      session: EnvironmentAuth.AuthenticatedSession,
    ) {
      if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
        return yield* liveError("session_not_found");
      }
      const activeSessions = yield* authSessions
        .listActive()
        .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
      const principal = activeSessions.find(
        (candidate) => candidate.sessionId === session.sessionId,
      );
      if (
        principal === undefined ||
        principal.subject !== session.subject ||
        !principal.scopes.includes(AuthOrchestrationOperateScope)
      ) {
        return yield* liveError("session_not_found");
      }
    });

    const updateStatus = Effect.fn("CodexLiveSessionService.updateStatus")(
      (
        row: LeaseRow,
        status: LiveVoiceSession["status"],
        additionalSql?: (now: string) => Effect.Effect<unknown, SqlError.SqlError>,
      ) =>
        Effect.gen(function* () {
          if (["stopping", "closed", "failed", "unknown"].includes(status)) {
            const lease = active.get(leaseKey(row.lease_id, row.generation));
            if (lease) {
              const invalidate = Effect.sync(() => {
                lease.acceptingWork = false;
              });
              yield* lease.sourceSemaphore
                ? lease.sourceSemaphore.withPermits(1)(invalidate)
                : invalidate;
            }
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const next = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE codex_live_voice_leases SET status = ${status}, updated_at = ${now}
              WHERE lease_id = ${row.lease_id} AND generation = ${row.generation}
            `;
              if (additionalSql !== undefined) yield* additionalSql(now);
              return yield* getLease(row.lease_id, row.generation);
            }),
          );
          if (next === undefined) return yield* liveError("session_not_found");
          const session = sessionFromRow(next);
          yield* eventHub.publish({ type: "status", session });
          return { row: next, session };
        }),
    );

    const readbackWorkerKey = (leaseId: string, generation: number, runId: string) =>
      `${leaseId}:${generation}:${runId}`;

    const readbackResult = (projection: OrchestrationV2ThreadProjection, runId: string) => {
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.status !== "completed" || run.rootNodeId === null)
        return undefined;
      const attempt = projection.attempts.find(
        (candidate) =>
          candidate.id === run.activeAttemptId &&
          candidate.runId === runId &&
          candidate.rootNodeId === run.rootNodeId &&
          candidate.status === "completed",
      );
      if (attempt === undefined) return undefined;
      // A run can span several native turns, and its attempt need not store a
      // providerTurnId. The provider turn's runAttemptId is the canonical link.
      const providerTurn = latestProviderTurnForAttempt(projection.providerTurns, attempt.id);
      if (providerTurn !== undefined && providerTurn.status !== "completed") return undefined;
      const providerTurnId = providerTurn?.id ?? attempt.providerTurnId;
      if (providerTurnId === null) return undefined;
      const resultNodeIds = new Set(
        projection.nodes
          .filter(
            (node) =>
              node.rootNodeId === run.rootNodeId &&
              node.providerTurnId === providerTurnId &&
              node.kind === "assistant_message" &&
              node.status === "completed",
          )
          .map((node) => node.id),
      );
      const finalItems = projection.turnItems.filter(
        (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> =>
          item.type === "assistant_message" &&
          item.runId === runId &&
          item.nodeId !== null &&
          resultNodeIds.has(item.nodeId) &&
          item.providerTurnId === providerTurnId &&
          item.status === "completed" &&
          !item.streaming,
      );
      if (finalItems.length === 0) return undefined;
      const terminalOrdinal = Math.max(...finalItems.map((item) => item.ordinal));
      const terminalItems = finalItems.filter((item) => item.ordinal === terminalOrdinal);
      if (terminalItems.length !== 1) return undefined;
      const finalItem = terminalItems[0]!;
      const finalMessages = projection.messages.filter(
        (message) =>
          message.id === finalItem.messageId &&
          message.runId === runId &&
          message.role === "assistant" &&
          message.nodeId === finalItem.nodeId &&
          !message.streaming &&
          message.text === finalItem.text,
      );
      if (finalMessages.length !== 1) return undefined;
      if (finalMessages[0]!.text.trim().length === 0) return undefined;
      // Git snapshots support undo, not conversation delivery. Research in a
      // non-repository workspace legitimately completes with a missing snapshot.
      if (
        projection.subagents.some((child) => child.runId === runId && child.status !== "completed")
      )
        return undefined;
      return {
        attemptId: attempt.id,
        finalMessageId: finalMessages[0]!.id,
        text: finalMessages[0]!.text,
      };
    };

    const publicReadbackResults = (projection: OrchestrationV2ThreadProjection, runId: string) => {
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (
        run &&
        ["failed", "interrupted", "cancelled"].includes(run.status) &&
        run.activeAttemptId !== null
      ) {
        return [
          {
            attemptId: run.activeAttemptId,
            messageId: run.userMessageId,
            deliveryId: `state:${run.id}:${run.status}`,
            text: encodeReceipt({
              type: "background_task_state",
              runId: run.id,
              status: run.status,
              resultReady: false,
            }),
          },
        ];
      }
      if (!run || !["running", "waiting"].includes(run.status) || run.rootNodeId === null)
        return [];
      const attempt = projection.attempts.find(
        (candidate) =>
          candidate.id === run.activeAttemptId &&
          candidate.rootNodeId === run.rootNodeId &&
          candidate.runId === runId,
      );
      if (!attempt) return [];
      const latestTurn = latestProviderTurnForAttempt(projection.providerTurns, attempt.id);
      if (!latestTurn) return [];
      const turns = new Map(
        projection.providerTurns
          .filter(
            (turn) =>
              turn.runAttemptId === attempt.id &&
              (turn.status === "completed" ||
                (turn.id === latestTurn.id && turn.status === "running")),
          )
          .map((turn) => [turn.id, turn]),
      );
      const items = projection.turnItems
        .filter(
          (item) =>
            item.threadId === projection.thread.id &&
            item.runId === runId &&
            item.providerTurnId !== null &&
            turns.has(item.providerTurnId),
        )
        .sort(
          (a, b) =>
            turns.get(a.providerTurnId!)!.ordinal - turns.get(b.providerTurnId!)!.ordinal ||
            a.ordinal - b.ordinal,
        );
      const lastOrdinals = new Map<string, number>();
      for (const item of items) {
        if (
          [
            "assistant_message",
            "command_execution",
            "dynamic_tool",
            "web_search",
            "file_search",
            "file_change",
            "user_input_request",
            "approval_request",
          ].includes(item.type)
        )
          lastOrdinals.set(
            item.providerTurnId!,
            Math.max(lastOrdinals.get(item.providerTurnId!) ?? -1, item.ordinal),
          );
      }
      return items.flatMap((item) => {
        const turn = turns.get(item.providerTurnId!)!;
        if (
          item.type === "user_input_request" &&
          item.questions.length &&
          projection.runtimeRequests.some(
            (request) =>
              request.id === item.requestId &&
              request.status === "pending" &&
              request.nodeId === item.nodeId &&
              request.providerTurnId === item.providerTurnId,
          )
        ) {
          return [
            {
              attemptId: attempt.id,
              messageId: run.userMessageId,
              deliveryId: `question:${item.requestId}`,
              text: encodeReceipt({
                type: "background_task_question",
                runId,
                questions: item.questions.slice(0, 3).map((question) => ({
                  question: question.question.slice(0, 1_000),
                  options: question.options.slice(0, 5).map((option) => option.label.slice(0, 200)),
                })),
              }),
            },
          ];
        }
        if (item.type === "assistant_message" && item.streaming && item.status === "running") {
          const node = projection.nodes.find((candidate) => candidate.id === item.nodeId);
          if (
            !node ||
            node.kind !== "assistant_message" ||
            node.status !== "running" ||
            node.rootNodeId !== run.rootNodeId ||
            node.providerTurnId !== turn.id ||
            item.text.length > 16_384
          )
            return [];
          return voiceAnswerParagraphs(item.text).map((paragraph) => ({
            attemptId: attempt.id,
            messageId: item.messageId,
            deliveryId: `${item.messageId}:paragraph:${paragraph.offset}`,
            text: paragraph.text,
          }));
        }
        // A later native turn also proves the previous completed turn's last answer is
        // intermediate. The latest turn's last answer still belongs to the final path.
        if (
          item.type !== "assistant_message" ||
          item.streaming ||
          item.status !== "completed" ||
          (turn.ordinal === latestTurn.ordinal &&
            item.ordinal >= (lastOrdinals.get(turn.id) ?? -1)) ||
          !item.text.trim() ||
          item.text.length > 16_384
        )
          return [];
        const node = projection.nodes.find((candidate) => candidate.id === item.nodeId);
        if (
          !node ||
          node.kind !== "assistant_message" ||
          node.status !== "completed" ||
          node.rootNodeId !== run.rootNodeId ||
          node.providerTurnId !== turn.id
        )
          return [];
        const message = projection.messages.find(
          (candidate) =>
            candidate.id === item.messageId &&
            candidate.threadId === projection.thread.id &&
            candidate.runId === runId &&
            candidate.nodeId === node.id &&
            candidate.role === "assistant" &&
            !candidate.streaming &&
            candidate.text === item.text,
        );
        return message
          ? [
              {
                attemptId: attempt.id,
                messageId: message.id,
                deliveryId: message.id,
                text: message.text,
              },
            ]
          : [];
      });
    };

    const inspectReadback = (projection: OrchestrationV2ThreadProjection, runId: string) => {
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (
        run === undefined ||
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)
      )
        return { type: "pending" } as const;
      if (run.status !== "completed" || run.rootNodeId === null) {
        return { type: "blocked" } as const;
      }
      const children = projection.subagents.filter((child) => child.runId === runId);
      if (children.some((child) => child.status !== "completed")) {
        return children.some((child) =>
          ["idle", "pending", "running", "waiting"].includes(child.status),
        )
          ? ({ type: "pending" } as const)
          : ({ type: "blocked" } as const);
      }
      const result = readbackResult(projection, runId);
      if (result === undefined) return { type: "pending" } as const;
      return { type: "ready", ...result } as const;
    };

    const quietStatus = (
      projection: OrchestrationV2ThreadProjection,
      runId: string,
      now: DateTime.Utc,
    ) => {
      const run = projection.runs.find((run) => run.id === runId);
      if (!run || !["running", "waiting"].includes(run.status) || run.activeAttemptId === null)
        return;
      const status = voiceRunStatus(projection, run, now);
      const detail = status.currentStep ?? status.lastUpdate;
      return {
        attemptId: run.activeAttemptId,
        messageId: run.userMessageId,
        deliveryId: `quiet:${run.id}:${run.activeAttemptId}:${run.status}:${status.evidenceAt ?? "no-update"}`,
        text: detail ? `Die Arbeit läuft noch. ${detail.slice(-500)}` : "Die Arbeit läuft noch.",
      };
    };
    const canSpeakQuietStatus = (
      lease: {
        readonly userSpeaking?: boolean;
        readonly assistantSpeaking?: boolean;
        readonly lastSpeechAt?: number;
        readonly lastQuietStatusAt?: number;
      },
      now: number,
    ) =>
      !lease.userSpeaking &&
      !lease.assistantSpeaking &&
      now - (lease.lastSpeechAt ?? 0) >= 45_000 &&
      (lease.lastQuietStatusAt === undefined || now - lease.lastQuietStatusAt >= 90_000);

    const startReadbackWorker = Effect.fn("CodexLiveSessionService.startReadbackWorker")((input: {
      readonly leaseId: string;
      readonly generation: number;
      readonly threadId: LiveVoiceSession["threadId"];
      readonly projectId: OrchestrationV2ThreadProjection["thread"]["projectId"];
      readonly plannerNativeThreadId: string;
      readonly plannerTurnId: string;
      readonly runId: string;
      readonly replace?: boolean;
    }): Effect.Effect<void> => {
      return Effect.gen(function* () {
        const key = readbackWorkerKey(input.leaseId, input.generation, input.runId);
        const existing = readbackWorkers.get(key);
        if (existing && !input.replace) return;
        if (existing) {
          readbackWorkers.delete(key);
          yield* Fiber.interrupt(existing).pipe(Effect.forkIn(serviceScope));
        }
        const worker = Effect.gen(function* () {
          const afterSequence = yield* threads.getThreadEventSequence(input.threadId);
          const readProjection = () =>
            threads.getProjectThread({ projectId: input.projectId, threadId: input.threadId });
          yield* Effect.forever(
            Effect.sleep("45 seconds").pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const lease = active.get(leaseKey(input.leaseId, input.generation));
                  const now = yield* DateTime.now;
                  if (!lease || !canSpeakQuietStatus(lease, DateTime.toEpochMillis(now))) return;
                  const update = quietStatus(yield* readProjection(), input.runId, now);
                  if (update)
                    yield* appendDurableOutput({ ...input, ...update, kind: "status" }).pipe(
                      Effect.timeout("5 seconds"),
                    );
                }).pipe(Effect.ignoreCause),
              ),
            ),
          ).pipe(Effect.forkScoped);
          const appendPublic = (projection: OrchestrationV2ThreadProjection) =>
            Effect.forEach(
              publicReadbackResults(projection, input.runId),
              (update) => appendDurableOutput({ ...input, ...update, kind: "context" }),
              { discard: true },
            );
          const initial = yield* readProjection();
          yield* appendPublic(initial);
          const first = inspectReadback(initial, input.runId);
          if (first.type === "ready") {
            yield* appendDurableOutput({
              ...input,
              kind: "final",
              attemptId: first.attemptId,
              messageId: first.finalMessageId,
              text: first.text,
            });
            return;
          }
          if (first.type === "blocked") return;
          const eventTypes = [
            "run.updated",
            "subagent.updated",
            "checkpoint.captured",
            "message.updated",
            "turn-item.updated",
          ] as const;
          const result = yield* Stream.mergeAll(
            eventTypes.map((eventType) =>
              threads.streamStoredEventsFrom({
                threadId: input.threadId,
                afterSequence,
                eventType,
              }),
            ),
            { concurrency: "unbounded" },
          ).pipe(
            Stream.filter((stored) => {
              const event = stored.event;
              switch (event.type) {
                case "run.updated":
                  return event.payload.id === input.runId;
                case "checkpoint.captured":
                case "message.updated":
                case "turn-item.updated":
                case "subagent.updated":
                  return event.payload.runId === input.runId;
                default:
                  return false;
              }
            }),
            Stream.tap(() => {
              const wake = intakeWakes.get(leaseKey(input.leaseId, input.generation));
              return wake ? Queue.offer(wake, undefined) : Effect.void;
            }),
            Stream.mapEffect(() =>
              readProjection().pipe(
                Effect.tap(appendPublic),
                Effect.map((projection) => inspectReadback(projection, input.runId)),
              ),
            ),
            Stream.filter((gate) => gate.type !== "pending"),
            Stream.runHead,
          );
          if (Option.isNone(result) || result.value.type !== "ready") return;
          yield* appendDurableOutput({
            ...input,
            kind: "final",
            attemptId: result.value.attemptId,
            messageId: result.value.finalMessageId,
            text: result.value.text,
          });
        }).pipe(
          Effect.scoped,
          Effect.withSpan("CodexLiveSessionService.readbackWorker"),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("Live task readback stopped", {
                  leaseId: input.leaseId,
                  generation: input.generation,
                  runId: input.runId,
                }),
          ),
        );
        const fiber = yield* Effect.forkIn(worker, serviceScope);
        readbackWorkers.set(key, fiber);
        yield* Effect.forkIn(
          Fiber.await(fiber).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (readbackWorkers.get(key) === fiber) readbackWorkers.delete(key);
              }),
            ),
          ),
          serviceScope,
        );
      });
    });

    const stopReadbackWorkers = (leaseId: string, generation: number) =>
      Effect.forEach(
        [...readbackWorkers.entries()].filter(([key]) =>
          key.startsWith(`${leaseId}:${generation}:`),
        ),
        ([key, fiber]) =>
          Fiber.interrupt(fiber).pipe(
            Effect.tap(() => Effect.sync(() => readbackWorkers.delete(key))),
          ),
        { discard: true },
      );

    const appendDurableOutput = Effect.fn("CodexLiveSessionService.appendOutput")(
      (input: {
        readonly leaseId: string;
        readonly generation: number;
        readonly threadId: LiveVoiceSession["threadId"];
        readonly projectId: OrchestrationV2ThreadProjection["thread"]["projectId"];
        readonly plannerNativeThreadId: string;
        readonly plannerTurnId: string;
        readonly runId: string;
        readonly attemptId: string;
        readonly messageId: string;
        readonly deliveryId?: string;
        readonly kind: "final" | "context" | "status";
        readonly text: string;
      }) =>
        outputLocks.withLock(
          leaseKey(input.leaseId, input.generation),
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              "voice.output.kind": input.kind,
              "voice.output.message_id": input.messageId,
            });
            const row = yield* getLease(input.leaseId, input.generation);
            const lease = active.get(leaseKey(input.leaseId, input.generation));
            if (
              row === undefined ||
              row.planner_native_thread_id !== input.plannerNativeThreadId ||
              (row.status !== "active" && row.status !== "starting") ||
              lease?.plannerNativeThreadId !== input.plannerNativeThreadId ||
              lease.runtime.liveVoice === undefined ||
              lease.runtime.driver !== "codex" ||
              lease.runtime.instanceId !== row.provider_instance_id ||
              lease.runtime.providerSessionId !== row.provider_session_id
            )
              return;
            const intents = yield* sql<{ receipt_json: string | null }>`
            SELECT receipt_json FROM codex_live_voice_intents
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
              AND planner_native_thread_id = ${input.plannerNativeThreadId}
              AND planner_turn_id = ${input.plannerTurnId} AND dispatch_state = 'admitted'
          `;
            const stored = intents[0]?.receipt_json;
            if (stored === undefined || stored === null) return;
            const receipt = decodeReceipt(stored) as Record<string, unknown>;
            if (receipt.runId !== input.runId) return;
            const publicReadbacks =
              typeof receipt.publicReadbacks === "object" &&
              receipt.publicReadbacks !== null &&
              !Array.isArray(receipt.publicReadbacks)
                ? (receipt.publicReadbacks as Record<string, unknown>)
                : {};
            const deliveryId = input.deliveryId ?? input.messageId;
            if (
              input.kind === "status" &&
              !canSpeakQuietStatus(lease, DateTime.toEpochMillis(yield* DateTime.now))
            )
              return;
            if (
              input.kind === "final"
                ? receipt.readback !== undefined
                : Object.hasOwn(publicReadbacks, deliveryId) ||
                  (input.kind === "context" && lease.runtime.liveVoice.appendContext === undefined)
            )
              return;
            const receiptWithState = (state: "claimed" | "refused" | "sent" | "unknown") => {
              const delivery = { state, runId: input.runId, attemptId: input.attemptId };
              return encodeReceipt(
                input.kind === "final"
                  ? { ...receipt, readback: { ...delivery, finalMessageId: input.messageId } }
                  : {
                      ...receipt,
                      publicReadbacks: { ...publicReadbacks, [deliveryId]: delivery },
                    },
              );
            };
            const activePrincipals = yield* authSessions
              .listActive()
              .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
            if (
              !activePrincipals.some(
                (principal) =>
                  principal.sessionId === row.principal_session_id &&
                  principal.subject === row.principal_subject &&
                  principal.scopes.includes(AuthOrchestrationOperateScope),
              )
            )
              return;
            const latestProjection = yield* threads.getProjectThread({
              projectId: input.projectId,
              threadId: input.threadId,
            });
            const sourceProjection =
              input.threadId === row.thread_id
                ? latestProjection
                : yield* threads.getThreadProjection(row.thread_id as LiveVoiceSession["threadId"]);
            const policy = yield* runtimePolicies.resolve({
              thread: sourceProjection.thread,
              modelSelection: sourceProjection.thread.modelSelection,
            });
            const targetMatches = (
              projection: OrchestrationV2ThreadProjection,
              source: OrchestrationV2ThreadProjection,
            ) =>
              receipt.taskId === undefined
                ? projection.thread.id === row.thread_id
                : receipt.threadId === projection.thread.id &&
                  receipt.projectId === projection.thread.projectId &&
                  projection.thread.archivedAt === null &&
                  projection.thread.deletedAt === null &&
                  projection.thread.lineage.parentThreadId === row.thread_id &&
                  projection.thread.lineage.relationshipToParent === "subagent" &&
                  projection.thread.forkedFrom?.type === "node" &&
                  projection.thread.forkedFrom.nodeId === receipt.taskId &&
                  source.subagents.some(
                    (task) =>
                      task.id === receipt.taskId &&
                      task.origin === "app_owned" &&
                      task.childThreadId === projection.thread.id &&
                      task.runId === receipt.admissionRunId,
                  );
            if (
              !readbackContextMatches(row, sourceProjection, policy) ||
              !targetMatches(latestProjection, sourceProjection)
            )
              return;
            const finalResult = readbackResult(latestProjection, input.runId);
            const latestFinal =
              input.kind === "final"
                ? finalResult && { ...finalResult, messageId: finalResult.finalMessageId }
                : input.kind === "status"
                  ? quietStatus(latestProjection, input.runId, yield* DateTime.now)
                  : publicReadbackResults(latestProjection, input.runId).find(
                      (message) => message.deliveryId === deliveryId,
                    );
            if (
              latestFinal === undefined ||
              latestFinal.attemptId !== input.attemptId ||
              latestFinal.messageId !== input.messageId ||
              latestFinal.text !== input.text
            )
              return;
            const beforeClaim = yield* getLease(input.leaseId, input.generation);
            const leaseBeforeClaim = active.get(leaseKey(input.leaseId, input.generation));
            if (
              beforeClaim === undefined ||
              beforeClaim.status !== "active" ||
              beforeClaim.planner_native_thread_id !== input.plannerNativeThreadId ||
              leaseBeforeClaim?.plannerNativeThreadId !== input.plannerNativeThreadId ||
              leaseBeforeClaim.runtime.liveVoice === undefined ||
              leaseBeforeClaim.runtime.driver !== "codex" ||
              leaseBeforeClaim.runtime.instanceId !== beforeClaim.provider_instance_id ||
              leaseBeforeClaim.runtime.providerSessionId !== beforeClaim.provider_session_id
            )
              return;
            const deliveryPath = input.kind === "final" ? "$.readback" : "$.publicReadbacks";
            const claimed = receiptWithState("claimed");
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
            UPDATE codex_live_voice_intents SET receipt_json = json_set(receipt_json, ${deliveryPath}, json_extract(${claimed}, ${deliveryPath})), updated_at = ${now}
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
              AND planner_native_thread_id = ${input.plannerNativeThreadId}
              AND planner_turn_id = ${input.plannerTurnId} AND dispatch_state = 'admitted'
              AND json_remove(receipt_json, '$.intakeIntent') = json_remove(${stored}, '$.intakeIntent')
          `;
            const afterClaim = yield* sql<{ receipt_json: string | null }>`
            SELECT receipt_json FROM codex_live_voice_intents
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
              AND planner_native_thread_id = ${input.plannerNativeThreadId}
              AND planner_turn_id = ${input.plannerTurnId} AND dispatch_state = 'admitted'
          `;
            if (afterClaim[0]?.receipt_json == null) return;
            const observedClaim = decodeReceipt(afterClaim[0].receipt_json) as Record<
              string,
              unknown
            >;
            const expectedClaim = decodeReceipt(claimed) as Record<string, unknown>;
            delete observedClaim.intakeIntent;
            delete expectedClaim.intakeIntent;
            if (encodeReceipt(observedClaim) !== encodeReceipt(expectedClaim)) return;
            const dispatchPrincipals = yield* authSessions
              .listActive()
              .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
            // Refresh after the principal lookup: native error/closed events can
            // commit while that lookup is suspended, without taking this lease lock.
            const stillPublic = yield* Effect.gen(function* () {
              const currentProjection = yield* threads.getProjectThread({
                projectId: input.projectId,
                threadId: input.threadId,
              });
              const currentSource =
                input.threadId === row.thread_id
                  ? currentProjection
                  : yield* threads.getThreadProjection(
                      row.thread_id as LiveVoiceSession["threadId"],
                    );
              const currentPolicy = yield* runtimePolicies.resolve({
                thread: currentSource.thread,
                modelSelection: currentSource.thread.modelSelection,
              });
              if (
                !readbackContextMatches(row, currentSource, currentPolicy) ||
                !targetMatches(currentProjection, currentSource)
              )
                return false;
              if (input.kind === "final") {
                const current = readbackResult(currentProjection, input.runId);
                return (
                  current?.attemptId === input.attemptId &&
                  current.finalMessageId === input.messageId &&
                  current.text === input.text
                );
              }
              if (input.kind === "status") {
                const update = quietStatus(currentProjection, input.runId, yield* DateTime.now);
                return (
                  update?.deliveryId === deliveryId &&
                  update.text === input.text &&
                  update.attemptId === input.attemptId
                );
              }
              return publicReadbackResults(currentProjection, input.runId).some(
                (message) =>
                  message.messageId === input.messageId &&
                  message.deliveryId === deliveryId &&
                  message.attemptId === input.attemptId &&
                  message.text === input.text,
              );
            });
            const beforeDispatch = yield* getLease(input.leaseId, input.generation);
            const currentLease = active.get(leaseKey(input.leaseId, input.generation));
            if (
              !stillPublic ||
              beforeDispatch === undefined ||
              beforeDispatch.status !== "active" ||
              beforeDispatch.planner_native_thread_id !== input.plannerNativeThreadId ||
              currentLease?.plannerNativeThreadId !== input.plannerNativeThreadId ||
              currentLease.runtime.liveVoice === undefined ||
              (input.kind === "context" &&
                currentLease.runtime.liveVoice.appendContext === undefined) ||
              currentLease.runtime.driver !== "codex" ||
              currentLease.runtime.instanceId !== beforeDispatch.provider_instance_id ||
              currentLease.runtime.providerSessionId !== beforeDispatch.provider_session_id ||
              (input.kind === "status" &&
                !canSpeakQuietStatus(currentLease, DateTime.toEpochMillis(yield* DateTime.now))) ||
              !dispatchPrincipals.some(
                (principal) =>
                  principal.sessionId === beforeDispatch.principal_session_id &&
                  principal.subject === beforeDispatch.principal_subject &&
                  principal.scopes.includes(AuthOrchestrationOperateScope),
              )
            ) {
              const refused = receiptWithState("refused");
              yield* sql`
              UPDATE codex_live_voice_intents SET receipt_json = json_set(receipt_json, ${deliveryPath}, json_extract(${refused}, ${deliveryPath})), updated_at = ${now}
              WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
                AND planner_native_thread_id = ${input.plannerNativeThreadId}
                AND planner_turn_id = ${input.plannerTurnId} AND json_remove(receipt_json, '$.intakeIntent') = json_remove(${claimed}, '$.intakeIntent')
            `;
              yield* Effect.annotateCurrentSpan("voice.output.delivery", "refused");
              return;
            }
            const state = yield* Effect.exit(
              (input.kind !== "context"
                ? currentLease.runtime.liveVoice.appendSpeech
                : currentLease.runtime.liveVoice.appendContext!)({
                plannerNativeThreadId: input.plannerNativeThreadId,
                text:
                  receipt.taskId === undefined || input.kind === "status"
                    ? input.text
                    : encodeReceipt({
                        type: "background_task_output",
                        taskId: receipt.taskId,
                        requestId: receipt.requestId,
                        runId: input.runId,
                        kind: input.kind === "final" ? "result" : "update",
                        resultReady: input.kind === "final",
                        text: input.text,
                      }),
              }),
            );
            if (input.kind === "status")
              currentLease.lastQuietStatusAt = DateTime.toEpochMillis(yield* DateTime.now);
            // Neither append has an idempotency key. This records transport acceptance,
            // not audible playback, and ambiguous outcomes are never blindly replayed.
            const settled = receiptWithState(Exit.isSuccess(state) ? "sent" : "unknown");
            yield* sql`
            UPDATE codex_live_voice_intents SET receipt_json = json_set(receipt_json, ${deliveryPath}, json_extract(${settled}, ${deliveryPath})), updated_at = ${now}
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
              AND planner_native_thread_id = ${input.plannerNativeThreadId}
              AND planner_turn_id = ${input.plannerTurnId} AND json_remove(receipt_json, '$.intakeIntent') = json_remove(${claimed}, '$.intakeIntent')
          `;
            yield* Effect.annotateCurrentSpan(
              "voice.output.delivery",
              Exit.isSuccess(state) ? "sent" : "unknown",
            );
          }),
        ),
    );

    const markUnknown = Effect.fn("CodexLiveSessionService.markUnknown")(
      (leaseId: string, generation: number) =>
        Effect.gen(function* () {
          const row = yield* getLease(leaseId, generation);
          if (row !== undefined) yield* updateStatus(row, "unknown");
        }),
    );

    const toLiveError = (error: unknown) =>
      Schema.is(LiveVoiceError)(error) ? error : liveError("runtime_unavailable");

    const prepare: CodexLiveSessionService["Service"]["prepare"] = (session, input) =>
      leaseLocks
        .withLock(
          `request:${session.sessionId}:${input.clientRequestId}`,
          Effect.gen(function* () {
            yield* ensurePrincipal(session);
            const environmentId = yield* environment.getEnvironmentId;
            const existing = yield* sql<LeaseRow>`
          SELECT * FROM codex_live_voice_leases
          WHERE environment_id = ${environmentId}
            AND principal_session_id = ${session.sessionId}
            AND client_request_id = ${input.clientRequestId}
        `.pipe(Effect.map((rows) => rows[0]));
            if (existing !== undefined) {
              if (existing.thread_id !== input.threadId) {
                return yield* liveError("dispatch_conflict");
              }
              yield* recoverPendingIntents(existing.lease_id, existing.generation);
              const key = leaseKey(existing.lease_id, existing.generation);
              if (
                !active.has(key) &&
                ["preparing", "prepared", "starting", "active", "stopping"].includes(
                  existing.status,
                )
              ) {
                const reconciled = yield* updateStatus(existing, "unknown");
                return reconciled.session;
              }
              return sessionFromRow(existing);
            }

            const projection = yield* threads
              .getThreadProjection(input.threadId)
              .pipe(Effect.mapError(() => liveError("session_not_found")));
            if (projection.thread.archivedAt !== null) return yield* liveError("session_not_found");
            const providerInstance = yield* providerInstances.getInstance(
              projection.thread.providerInstanceId,
            );
            if (providerInstance?.driverKind !== "codex") {
              return yield* liveError("unsupported_provider");
            }
            const runtimePolicy = yield* runtimePolicies
              .resolve({
                thread: projection.thread,
                modelSelection: projection.thread.modelSelection,
              })
              .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
            const previousLease = yield* sql<LeaseRow>`
          SELECT * FROM codex_live_voice_leases
          WHERE thread_id = ${input.threadId}
            AND status IN ('preparing', 'prepared', 'starting', 'active', 'stopping', 'unknown')
          ORDER BY updated_at DESC LIMIT 1
        `.pipe(Effect.map((rows) => rows[0]));
            if (previousLease !== undefined) {
              if (previousLease.principal_subject !== session.subject) {
                return yield* liveError("dispatch_conflict");
              }
              let currentPreviousLease: LeaseRow | undefined = previousLease;
              if (previousLease.status === "preparing") {
                // A previous client can leave an empty reservation. Its original
                // request must finish before checking whether anything was bound.
                currentPreviousLease = yield* leaseLocks.withLock(
                  `request:${previousLease.principal_session_id}:${previousLease.client_request_id}`,
                  Effect.gen(function* () {
                    const pending = yield* getLease(
                      previousLease.lease_id,
                      previousLease.generation,
                    );
                    if (
                      pending?.status === "preparing" &&
                      pending.principal_session_id === previousLease.principal_session_id &&
                      pending.principal_subject === session.subject &&
                      pending.environment_id === environmentId &&
                      pending.thread_id === input.threadId &&
                      pending.provider_session_id === null &&
                      pending.planner_native_thread_id === null &&
                      pending.start_client_request_id === null &&
                      pending.stop_client_request_id === null &&
                      pending.native_started === 0 &&
                      pending.native_sdp_received === 0 &&
                      !active.has(leaseKey(pending.lease_id, pending.generation))
                    ) {
                      const retired = yield* sql<LeaseRow>`
                        UPDATE codex_live_voice_leases
                        SET status = 'failed', updated_at = ${DateTime.formatIso(yield* DateTime.now)}
                        WHERE lease_id = ${pending.lease_id} AND generation = ${pending.generation}
                          AND environment_id = ${environmentId} AND thread_id = ${input.threadId}
                          AND principal_session_id = ${pending.principal_session_id}
                          AND principal_subject = ${session.subject}
                          AND client_request_id = ${pending.client_request_id}
                          AND updated_at = ${pending.updated_at} AND status = 'preparing'
                          AND provider_session_id IS NULL AND planner_native_thread_id IS NULL
                          AND start_client_request_id IS NULL AND stop_client_request_id IS NULL
                          AND native_started = 0 AND native_sdp_received = 0
                          AND NOT EXISTS (
                            SELECT 1 FROM codex_live_voice_intents
                            WHERE lease_id = ${pending.lease_id} AND generation = ${pending.generation}
                          )
                        RETURNING *
                      `.pipe(Effect.map((rows) => rows[0]));
                      if (retired !== undefined) {
                        yield* eventHub.publish({
                          type: "status",
                          session: sessionFromRow(retired),
                        });
                      }
                    }
                    // The old prepare can fail while this request waits for its lock.
                    return yield* getLease(previousLease.lease_id, previousLease.generation);
                  }),
                );
              }
              if (
                currentPreviousLease !== undefined &&
                !["closed", "failed"].includes(currentPreviousLease.status)
              ) {
                if (
                  currentPreviousLease.principal_session_id !== session.sessionId ||
                  currentPreviousLease.principal_subject !== session.subject
                ) {
                  return yield* liveError("dispatch_conflict");
                }
                const retired = yield* stopLease(
                  session,
                  {
                    leaseId: currentPreviousLease.lease_id,
                    generation: currentPreviousLease.generation,
                    clientRequestId: yield* crypto.randomUUIDv4(),
                  },
                  true,
                );
                if (retired.status !== "failed") return yield* liveError("dispatch_conflict");
              }
            }

            const leaseId = yield* crypto.randomUUIDv4();
            const generation = 1;
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
          INSERT INTO codex_live_voice_leases (
            lease_id, generation, environment_id, thread_id, provider_instance_id,
            model_selection_json, runtime_policy_json,
            provider_session_id, planner_native_thread_id, principal_session_id, principal_subject,
            client_request_id, status, updated_at
          ) VALUES (
            ${leaseId}, ${generation}, ${environmentId}, ${input.threadId},
            ${projection.thread.providerInstanceId}, ${encodeModelSelection(projection.thread.modelSelection)},
            ${encodeRuntimePolicy(runtimePolicy)}, NULL, NULL, ${session.sessionId}, ${session.subject},
            ${input.clientRequestId}, 'preparing', ${now}
          )
        `.pipe(Effect.catch(() => Effect.fail(liveError("dispatch_conflict"))));
            const initial: LiveVoiceSession = {
              leaseId,
              generation,
              environmentId,
              threadId: input.threadId,
              providerInstanceId: projection.thread.providerInstanceId,
              providerSessionId: null,
              plannerNativeThreadId: null,
              status: "preparing",
            };
            yield* eventHub.register(initial);

            const providerThread = projection.providerThreads.find(
              (candidate) => candidate.id === projection.thread.activeProviderThreadId,
            );
            const providerSession = projection.providerSessions.find(
              (candidate) => candidate.providerInstanceId === projection.thread.providerInstanceId,
            );
            const candidateSessionId = providerSession?.id ?? null;
            const fallbackSessionId = ProviderSessionId.make(
              `provider-session-live-${yield* crypto.randomUUIDv4()}`,
            );
            // Claim inside one SQLite statement before any async runtime lookup.
            // Forks sharing a text runtime must never reserve the same voice slot.
            const bound = yield* sql<{ provider_session_id: string }>`
              UPDATE codex_live_voice_leases SET provider_session_id = CASE
                WHEN ${candidateSessionId} IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM codex_live_voice_leases
                  WHERE provider_session_id = ${candidateSessionId}
                    AND status IN ('preparing', 'prepared', 'starting', 'active', 'stopping', 'unknown')
                ) THEN ${candidateSessionId} ELSE ${fallbackSessionId} END,
                updated_at = ${DateTime.formatIso(yield* DateTime.now)}
              WHERE lease_id = ${leaseId} AND generation = ${generation}
              RETURNING provider_session_id
            `.pipe(
              Effect.catch((error) =>
                markUnknown(leaseId, generation).pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            const binding = bound[0];
            if (binding === undefined) return yield* liveError("session_not_found");
            const providerSessionId = ProviderSessionId.make(binding.provider_session_id);
            const runtimeOption = yield* providerSessions.get(providerSessionId).pipe(
              Effect.mapError(() => liveError("runtime_unavailable")),
              Effect.catch((error) =>
                markUnknown(leaseId, generation).pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            const runtime = Option.isSome(runtimeOption)
              ? runtimeOption.value
              : yield* providerSessions
                  .open({
                    threadId: input.threadId,
                    providerSessionId,
                    modelSelection: projection.thread.modelSelection,
                    runtimePolicy,
                    ...(providerSession === undefined
                      ? {}
                      : { resumeFromSession: providerSession }),
                    ...(providerThread?.nativeThreadRef?.nativeId == null
                      ? {}
                      : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
                  })
                  .pipe(
                    Effect.mapError(() => liveError("runtime_unavailable")),
                    Effect.catch((error) =>
                      markUnknown(leaseId, generation).pipe(Effect.andThen(Effect.fail(error))),
                    ),
                  );
            if (
              runtime.instanceId !== projection.thread.providerInstanceId ||
              runtime.providerSessionId !== providerSessionId ||
              runtime.driver !== "codex"
            ) {
              const lease = yield* getLease(leaseId, generation);
              if (lease !== undefined) yield* updateStatus(lease, "failed");
              return yield* liveError("unsupported_provider");
            }
            if (runtime.liveVoice === undefined) {
              const lease = yield* getLease(leaseId, generation);
              if (lease !== undefined) yield* updateStatus(lease, "failed");
              return yield* liveError("unsupported_provider");
            }

            const exclusiveAdmission = runtime.liveVoice.decideIntake !== undefined;
            const serviceTier = getCodexServiceTierOptionValue(projection.thread.modelSelection);
            const reasoningEffort = getModelSelectionStringOptionValue(
              projection.thread.modelSelection,
              "reasoningEffort",
            );
            const prepared = yield* runtime.liveVoice
              .preparePlanner({
                ...(!exclusiveAdmission ? {} : { newTaskAdmission: "intake" as const }),
                modelSelection: projection.thread.modelSelection,
                ...(serviceTier == null ? {} : { serviceTier }),
                ...(reasoningEffort == null ? {} : { reasoningEffort }),
                onSubmitWork: (work) =>
                  (!exclusiveAdmission
                    ? submitWork({
                        ...work,
                        principalSessionId: session.sessionId,
                        leaseId,
                        generation,
                      })
                    : Effect.fail(liveError("invalid_state"))
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterProtocolError({
                          driver: ProviderDriverKind.make("codex"),
                          detail: "Live work could not be submitted.",
                          cause,
                        }),
                    ),
                  ),
                onWorkControl: (input) =>
                  (exclusiveAdmission && input.action !== "status"
                    ? Effect.fail(liveError("invalid_state"))
                    : controlWork({ ...input, principal: session, leaseId, generation })
                  ).pipe(
                    Effect.flatMap((json) =>
                      Effect.gen(function* () {
                        const intake = intakes.get(leaseKey(leaseId, generation));
                        if (!intake || input.action !== "status") return json;
                        const state = yield* intake.state;
                        const value = decodeReceipt(json) as Record<string, unknown>;
                        return encodeReceipt({
                          ...value,
                          intake: {
                            enabled: state.enabled,
                            deciding: state.running,
                            reason: state.reason,
                          },
                        });
                      }),
                    ),
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterProtocolError({
                          driver: ProviderDriverKind.make("codex"),
                          detail: "Live work control is not available.",
                          cause,
                        }),
                    ),
                  ),
              })
              .pipe(
                Effect.mapError((error) =>
                  Schema.is(ProviderAdapter.ProviderAdapterProtocolError)(error) &&
                  error.detail === "Managed ChatGPT account is required for Codex Live."
                    ? liveError("managed_account_required")
                    : liveError("planner_restriction_failed"),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const failed = yield* getLease(leaseId, generation);
                    if (failed !== undefined) yield* updateStatus(failed, "failed");
                    return yield* Effect.fail(error);
                  }),
                ),
              );
            const row = yield* getLease(leaseId, generation);
            if (row === undefined) return yield* liveError("session_not_found");
            yield* sql`
          UPDATE codex_live_voice_leases SET provider_session_id = ${providerSessionId},
            planner_native_thread_id = ${prepared.plannerNativeThreadId}, status = 'prepared',
            updated_at = ${DateTime.formatIso(yield* DateTime.now)}
          WHERE lease_id = ${leaseId} AND generation = ${generation}
        `;
            const ready = yield* getLease(leaseId, generation);
            if (ready === undefined) return yield* liveError("session_not_found");
            active.set(leaseKey(leaseId, generation), {
              leaseId,
              generation,
              runtime,
              plannerNativeThreadId: prepared.plannerNativeThreadId,
            });
            yield* eventHub.publish({ type: "status", session: sessionFromRow(ready) });
            if (exclusiveAdmission)
              yield* startIntake(session, ready, runtime).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    active.delete(leaseKey(leaseId, generation));
                    yield* updateStatus(ready, "failed");
                    yield* runtime
                      .liveVoice!.stop(prepared.plannerNativeThreadId)
                      .pipe(Effect.ignore);
                    return yield* error;
                  }),
                ),
              );
            // The adapter exposes one consuming queue per runtime. A worker per
            // lease would let an ended call steal a later call's notifications.
            if (!nativeEventRuntimes.has(runtime)) {
              nativeEventRuntimes.add(runtime);
              yield* Effect.forkIn(
                runtime.liveVoice.events.pipe(
                  Stream.runForEach((event) => {
                    const entry = [...active.values()].find(
                      (candidate) =>
                        candidate.runtime === runtime &&
                        candidate.plannerNativeThreadId === event.plannerNativeThreadId,
                    );
                    if (entry === undefined) return Effect.void;
                    const handling = handleNativeEvent(entry.leaseId, entry.generation, event);
                    // Readiness cannot race Stop; failures must still invalidate
                    // readback while its principal lookup is in flight.
                    return event.type === "started" || event.type === "sdp"
                      ? leaseLocks.withLock(leaseKey(entry.leaseId, entry.generation), handling)
                      : handling;
                  }),
                ),
                serviceScope,
              );
            }
            return sessionFromRow(ready);
          }),
        )
        .pipe(Effect.mapError(toLiveError));

    const start: CodexLiveSessionService["Service"]["start"] = (session, input) =>
      leaseLocks
        .withLock(
          leaseKey(input.leaseId, input.generation),
          Effect.gen(function* () {
            yield* ensurePrincipal(session);
            let row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
            if (row.start_client_request_id === input.clientRequestId) return sessionFromRow(row);
            const plannerNativeThreadId = row.planner_native_thread_id;
            if (row.status !== "prepared" || plannerNativeThreadId === null) {
              return yield* liveError("invalid_state");
            }
            const projection = yield* threads
              .getThreadProjection(row.thread_id as LiveVoiceSession["threadId"])
              .pipe(Effect.mapError(() => liveError("session_not_found")));
            const providerInstance = yield* providerInstances.getInstance(
              projection.thread.providerInstanceId,
            );
            const runtimePolicy = yield* runtimePolicies
              .resolve({
                thread: projection.thread,
                modelSelection: projection.thread.modelSelection,
              })
              .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
            if (
              projection.thread.archivedAt !== null ||
              projection.thread.providerInstanceId !== row.provider_instance_id ||
              providerInstance?.driverKind !== "codex" ||
              encodeModelSelection(projection.thread.modelSelection) !== row.model_selection_json ||
              encodeRuntimePolicy(runtimePolicy) !== row.runtime_policy_json
            ) {
              yield* updateStatus(row, "failed");
              return yield* liveError("stale_lease");
            }
            const next = yield* updateStatus(
              row,
              "starting",
              (now) =>
                sql`
            UPDATE codex_live_voice_leases SET start_client_request_id = ${input.clientRequestId},
              native_started = 0, native_sdp_received = 0, updated_at = ${now}
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
          `,
            );
            row = next.row;
            const lease = active.get(leaseKey(input.leaseId, input.generation));
            if (lease === undefined) {
              yield* updateStatus(row, "unknown");
              return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? row);
            }
            yield* lease.runtime
              .liveVoice!.start({
                plannerNativeThreadId,
                realtimeSessionId: `${input.leaseId}:${input.generation}`,
                offerSdp: input.offerSdp,
                initialItems: voiceStartupHistory(projection.messages),
              })
              .pipe(
                Effect.mapError(() => liveError("runtime_unavailable")),
                Effect.catch((error) =>
                  updateStatus(row, "unknown").pipe(Effect.andThen(Effect.fail(error))),
                ),
              );
            return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? row);
          }),
        )
        .pipe(Effect.mapError(toLiveError));

    const stopLease = (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceStopInput,
      recoverNeverStartedOrphan = false,
    ) =>
      leaseLocks
        .withLock(
          leaseKey(input.leaseId, input.generation),
          Effect.gen(function* () {
            yield* ensurePrincipal(session);
            const row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
            // Recheck after acquiring the lease lock: a new prepare must never
            // stop a native call or a lease belonging to another subject.
            if (
              recoverNeverStartedOrphan &&
              (row.principal_subject !== session.subject ||
                row.status !== "unknown" ||
                row.planner_native_thread_id !== null ||
                row.native_started !== 0 ||
                row.native_sdp_received !== 0 ||
                row.start_client_request_id !== null ||
                active.has(leaseKey(input.leaseId, input.generation)))
            ) {
              return yield* liveError("dispatch_conflict");
            }
            if (
              row.stop_client_request_id === input.clientRequestId ||
              row.status === "closed" ||
              row.status === "stopping"
            ) {
              return sessionFromRow(row);
            }
            if (row.status === "failed") return sessionFromRow(row);
            if (row.planner_native_thread_id === null || row.provider_session_id === null) {
              if (row.status === "unknown") {
                if (row.planner_native_thread_id === null) {
                  return (yield* updateStatus(row, "failed")).session;
                }
                return sessionFromRow(row);
              }
              return yield* liveError("invalid_state");
            }
            const next = yield* updateStatus(
              row,
              "stopping",
              (now) =>
                sql`
            UPDATE codex_live_voice_leases SET stop_client_request_id = ${input.clientRequestId},
              updated_at = ${now}
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
          `,
            );
            yield* stopReadbackWorkers(input.leaseId, input.generation);
            const lease = active.get(leaseKey(input.leaseId, input.generation));
            const runtime =
              lease?.runtime ??
              Option.getOrUndefined(
                yield* providerSessions.get(ProviderSessionId.make(row.provider_session_id)),
              );
            if (runtime?.liveVoice === undefined) {
              yield* updateStatus(next.row, "unknown");
              return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? next.row);
            }
            yield* runtime.liveVoice.stop(row.planner_native_thread_id).pipe(
              Effect.mapError(() => liveError("runtime_unavailable")),
              Effect.catch((error) =>
                updateStatus(next.row, "unknown").pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? next.row);
          }),
        )
        .pipe(Effect.mapError(toLiveError));

    const stop: CodexLiveSessionService["Service"]["stop"] = (session, input) =>
      stopLease(session, input);

    const status: CodexLiveSessionService["Service"]["status"] = Effect.fn(
      "CodexLiveSessionService.status",
    )((session, input) =>
      Effect.gen(function* () {
        yield* ensurePrincipal(session);
        let row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
        yield* recoverPendingIntents(input.leaseId, input.generation);
        row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
        if (
          !active.has(leaseKey(input.leaseId, input.generation)) &&
          ["preparing", "prepared", "starting", "active", "stopping"].includes(row.status)
        ) {
          return (yield* updateStatus(row, "unknown")).session;
        }
        return sessionFromRow(row);
      }).pipe(Effect.mapError(toLiveError)),
    );

    const subscribe: CodexLiveSessionService["Service"]["subscribe"] = (session, input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* ensurePrincipal(session);
          let row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
          yield* recoverPendingIntents(input.leaseId, input.generation);
          row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
          yield* eventHub.register(sessionFromRow(row));
          return eventHub.subscribe(input);
        }),
      ).pipe(Stream.mapError(toLiveError));

    const controlWork = Effect.fn("CodexLiveSessionService.controlWork")(function (input: {
      readonly principal: EnvironmentAuth.AuthenticatedSession;
      readonly leaseId: string;
      readonly generation: number;
      readonly plannerNativeThreadId: string;
      readonly plannerTurnId: string;
      readonly callId: string;
      readonly action: "status" | "steer";
      readonly runId?: string;
      readonly taskId?: string;
      readonly message?: string;
    }) {
      const operation = Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("voice.work.action", input.action);
        yield* ensurePrincipal(input.principal);
        const environmentId = yield* environment.getEnvironmentId;
        const row = yield* getOwnedLease(
          input.principal.sessionId,
          input.leaseId,
          input.generation,
        );
        const matchesRuntime = (current: LeaseRow) => {
          const live = active.get(leaseKey(input.leaseId, input.generation));
          return (
            current.environment_id === environmentId &&
            current.principal_subject === input.principal.subject &&
            (current.status === "starting" || current.status === "active") &&
            current.planner_native_thread_id === input.plannerNativeThreadId &&
            live?.plannerNativeThreadId === input.plannerNativeThreadId &&
            live.runtime.driver === "codex" &&
            live.runtime.liveVoice !== undefined &&
            live.runtime.instanceId === current.provider_instance_id &&
            live.runtime.providerSessionId === current.provider_session_id
          );
        };
        if (!matchesRuntime(row) || !input.plannerTurnId.trim() || !input.callId.trim())
          return yield* liveError("stale_lease");
        const projection = yield* threads
          .getThreadProjection(row.thread_id as LiveVoiceSession["threadId"])
          .pipe(Effect.mapError(() => liveError("session_not_found")));
        const instance = yield* providerInstances.getInstance(projection.thread.providerInstanceId);
        const policy = yield* runtimePolicies
          .resolve({
            thread: projection.thread,
            modelSelection: projection.thread.modelSelection,
          })
          .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
        if (
          projection.thread.id !== row.thread_id ||
          projection.thread.archivedAt !== null ||
          projection.thread.providerInstanceId !== row.provider_instance_id ||
          instance?.driverKind !== "codex" ||
          encodeModelSelection(projection.thread.modelSelection) !== row.model_selection_json ||
          encodeRuntimePolicy(policy) !== row.runtime_policy_json
        )
          return yield* liveError("stale_lease");
        const current = yield* getOwnedLease(
          input.principal.sessionId,
          input.leaseId,
          input.generation,
        );
        if (!matchesRuntime(current)) return yield* liveError("stale_lease");
        const runs = projection.runs.filter(
          (run) =>
            run.threadId === row.thread_id &&
            run.providerInstanceId === row.provider_instance_id &&
            run.delegationAdmission === undefined,
        );
        if (input.taskId !== undefined) {
          const taskId = NodeId.make(input.taskId);
          const target = yield* conversationWork
            .read({
              threadId: projection.thread.id,
              taskId,
              ...(input.runId === undefined ? {} : { runId: RunId.make(input.runId) }),
            })
            .pipe(Effect.mapError(() => liveError("session_not_found")));
          yield* ensurePrincipal(input.principal);
          if (
            !matchesRuntime(
              yield* getOwnedLease(input.principal.sessionId, input.leaseId, input.generation),
            )
          )
            return yield* liveError("stale_lease");
          if (input.action === "status") {
            if (input.message !== undefined) return yield* liveError("invalid_state");
            const result = inspectReadback(target.projection, target.run.id);
            return encodeReceipt({
              environmentId,
              threadId: row.thread_id,
              leaseId: input.leaseId,
              generation: input.generation,
              visibility: "available",
              tasks: [],
              delegatedTasks: [
                {
                  taskId,
                  parentRunId: target.task.runId,
                  childThreadId: target.projection.thread.id,
                  projectId: target.projection.thread.projectId,
                  ...voiceRunStatus(target.projection, target.run, yield* DateTime.now),
                  resultReady: result.type === "ready",
                  result: result.type === "ready" ? result.text.slice(0, 16_384) : null,
                  resultTruncated: result.type === "ready" && result.text.length > 16_384,
                },
              ],
            });
          }
          if (!input.runId || !input.message?.trim() || input.message.length > 8_000)
            return yield* liveError("invalid_state");
          const key = `live-voice-control:${encodeURIComponent(input.leaseId)}:${input.generation}:${encodeURIComponent(input.plannerTurnId)}:${encodeURIComponent(input.callId)}`;
          return yield* conversationWork
            .steer({
              threadId: projection.thread.id,
              taskId,
              runId: RunId.make(input.runId),
              commandId: CommandId.make(`command:${key}`),
              messageId: MessageId.make(`message:${key}`),
              message: input.message.trim(),
              creationSource: "voice",
            })
            .pipe(
              Effect.map((steered) =>
                encodeReceipt({ accepted: true, delivery: "steered", ...steered }),
              ),
              Effect.catchTags({
                ConversationWorkError: (error) =>
                  Effect.gen(function* () {
                    if (error.reason !== "inactive") return yield* liveError("dispatch_conflict");
                    const latest = yield* conversationWork.read({
                      threadId: projection.thread.id,
                      taskId,
                      runId: RunId.make(input.runId!),
                    });
                    yield* ensurePrincipal(input.principal);
                    if (
                      !matchesRuntime(
                        yield* getOwnedLease(
                          input.principal.sessionId,
                          input.leaseId,
                          input.generation,
                        ),
                      )
                    )
                      return yield* liveError("stale_lease");
                    const result = inspectReadback(latest.projection, latest.run.id);
                    return encodeReceipt({
                      accepted: false,
                      reason: "task_inactive",
                      delivery: "not_steered",
                      taskId,
                      threadId: latest.projection.thread.id,
                      ...voiceRunStatus(latest.projection, latest.run, yield* DateTime.now),
                      resultReady: result.type === "ready",
                      result: result.type === "ready" ? result.text.slice(0, 16_384) : null,
                      resultTruncated: result.type === "ready" && result.text.length > 16_384,
                    });
                  }),
              }),
              Effect.mapError((error) =>
                isLiveVoiceError(error) ? error : liveError("dispatch_conflict"),
              ),
            );
        }
        const run =
          input.runId === undefined
            ? undefined
            : runs.find((candidate) => candidate.id === input.runId);
        if (input.runId !== undefined && run === undefined)
          return yield* liveError("session_not_found");
        if (input.action === "status") {
          if (input.message !== undefined) return yield* liveError("invalid_state");
          const observedAt = yield* DateTime.now;
          const resultLimit = input.runId === undefined ? 1_000 : 16_384;
          const selected = run
            ? [run]
            : [...runs]
                .sort(
                  (a, b) =>
                    Number(isVoiceWorkActive(b.status)) - Number(isVoiceWorkActive(a.status)) ||
                    b.ordinal - a.ordinal,
                )
                .slice(0, 8);
          const children = projection.subagents
            .filter(
              (child) =>
                child.threadId === row.thread_id &&
                (input.runId === undefined || child.runId === input.runId),
            )
            .sort(
              (a, b) =>
                Number(isVoiceWorkActive(b.status)) - Number(isVoiceWorkActive(a.status)) ||
                DateTime.toEpochMillis(DateTime.makeUnsafe(b.updatedAt)) -
                  DateTime.toEpochMillis(DateTime.makeUnsafe(a.updatedAt)),
            )
            .slice(0, 8);
          const delegatedTasks = yield* Effect.forEach(
            children,
            (child) =>
              Effect.gen(function* () {
                const base = {
                  taskId: child.id,
                  parentRunId: child.runId,
                  title: child.title,
                  request: child.prompt.slice(0, 2_000),
                  status: child.status,
                  observedAt: DateTime.formatIso(observedAt),
                  evidenceAt: DateTime.formatIso(DateTime.makeUnsafe(child.updatedAt)),
                  lastUpdate: child.progress?.slice(-2_000) ?? null,
                  currentStep: null,
                  visibility: "unknown",
                  resultReady: false,
                  result: null,
                };
                if (child.origin !== "app_owned" || child.childThreadId === null) return base;
                const snapshot = yield* threads.getThreadProjection(child.childThreadId).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.catch(() => Effect.succeed(Option.none())),
                );
                if (Option.isNone(snapshot)) return base;
                const target = snapshot.value;
                if (
                  target.thread.id !== child.childThreadId ||
                  target.thread.lineage.parentThreadId !== row.thread_id ||
                  target.thread.lineage.relationshipToParent !== "subagent" ||
                  target.thread.deletedAt !== null ||
                  target.thread.archivedAt !== null
                )
                  return base;
                const latest = ConversationWorkCoordinator.conversationTaskRuns(
                  target,
                  child.id,
                ).sort(
                  (a, b) =>
                    Number(isVoiceWorkActive(b.status)) - Number(isVoiceWorkActive(a.status)) ||
                    b.ordinal - a.ordinal,
                )[0];
                if (!latest) return base;
                const result = inspectReadback(target, latest.id);
                return {
                  ...base,
                  childThreadId: target.thread.id,
                  projectId: target.thread.projectId,
                  ...voiceRunStatus(target, latest, observedAt),
                  request: child.prompt.slice(0, 2_000),
                  resultReady: result.type === "ready",
                  resultTruncated: result.type === "ready" && result.text.length > resultLimit,
                  result: result.type === "ready" ? result.text.slice(0, resultLimit) : null,
                };
              }),
            { concurrency: 4 },
          );
          yield* ensurePrincipal(input.principal);
          if (
            !matchesRuntime(
              yield* getOwnedLease(input.principal.sessionId, input.leaseId, input.generation),
            )
          )
            return yield* liveError("stale_lease");
          return encodeReceipt({
            environmentId,
            threadId: row.thread_id,
            leaseId: input.leaseId,
            generation: input.generation,
            observedAt: DateTime.formatIso(observedAt),
            visibility: "available",
            delegatedTasks,
            tasks: selected.map((task) => {
              const result = inspectReadback(projection, task.id);
              return {
                ...voiceRunStatus(projection, task, observedAt),
                resultReady: result.type === "ready",
                resultTruncated: result.type === "ready" && result.text.length > resultLimit,
                result: result.type === "ready" ? result.text.slice(0, resultLimit) : null,
              };
            }),
          });
        }
        if (
          !run ||
          typeof input.message !== "string" ||
          !input.message.trim() ||
          input.message.length > 8_000
        )
          return yield* liveError("invalid_state");
        const key = `live-voice-control:${encodeURIComponent(input.leaseId)}:${input.generation}:${encodeURIComponent(input.plannerTurnId)}:${encodeURIComponent(input.callId)}`;
        const commandId = CommandId.make(`command:${key}`);
        const messageId = MessageId.make(`message:${key}`);
        const prior = projection.messages.find((message) => message.id === messageId);
        if (prior) {
          if (
            prior.threadId !== row.thread_id ||
            prior.runId !== run.id ||
            prior.text !== input.message.trim()
          )
            return yield* liveError("dispatch_conflict");
          return encodeReceipt({
            accepted: true,
            delivery: "steered",
            threadId: row.thread_id,
            runId: run.id,
          });
        }
        if (!["starting", "running", "waiting"].includes(run.status))
          return yield* liveError("invalid_state");
        yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId,
            messageId,
            threadId: projection.thread.id,
            text: input.message.trim(),
            attachments: [],
            dispatchMode: {
              type: "steer_active",
              targetRunId: RunId.make(run.id),
              onInactive: "reject",
            },
            createdBy: "user",
            creationSource: "voice",
          })
          .pipe(Effect.mapError(() => liveError("dispatch_conflict")));
        return encodeReceipt({
          accepted: true,
          delivery: "steered",
          threadId: row.thread_id,
          runId: run.id,
        });
      });
      // Reads revalidate ownership and must not wait behind native speech or admission.
      return input.action === "status"
        ? operation.pipe(
            Effect.timeoutOrElse({
              duration: "6 seconds",
              orElse: () =>
                Effect.succeed(
                  encodeReceipt({
                    visibility: "unavailable",
                    reason: "status_timeout",
                    tasks: [],
                    delegatedTasks: [],
                  }),
                ),
            }),
          )
        : leaseLocks.withLock(leaseKey(input.leaseId, input.generation), operation);
    });

    const context: CodexLiveSessionService["Service"]["context"] = (session, input) =>
      leaseLocks
        .withLock(
          leaseKey(input.leaseId, input.generation),
          Effect.gen(function* () {
            yield* ensurePrincipal(session);
            const row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
            const lease = active.get(leaseKey(input.leaseId, input.generation));
            if (
              !lease ||
              !["prepared", "starting", "active"].includes(row.status) ||
              lease.plannerNativeThreadId !== row.planner_native_thread_id
            )
              return yield* liveError("stale_lease");
            if (
              !Number.isSafeInteger(input.revision) ||
              input.revision < 1 ||
              (input.context !== null && input.context.length > 24_000)
            )
              return yield* liveError("invalid_state");
            if (input.revision <= (lease.contextRevision ?? 0)) return;
            if (!lease.runtime.liveVoice?.appendContext)
              return yield* liveError("unsupported_provider");
            lease.contextRevision = input.revision;
            lease.previewContext = input.context;
            // Native output is independently serialized; an acknowledgement must
            // never hold work admission or End behind the lease lock.
            yield* Effect.forkIn(
              outputLocks
                .withLock(
                  leaseKey(input.leaseId, input.generation),
                  Effect.gen(function* () {
                    const current = active.get(leaseKey(input.leaseId, input.generation));
                    const row = yield* getLease(input.leaseId, input.generation);
                    if (
                      current !== lease ||
                      current.contextRevision !== input.revision ||
                      !row ||
                      !["prepared", "starting", "active"].includes(row.status)
                    )
                      return;
                    yield* lease.runtime.liveVoice!.appendContext!({
                      plannerNativeThreadId: lease.plannerNativeThreadId,
                      text:
                        input.context === null
                          ? "Selected preview context cleared."
                          : `Selected preview context (reference data):\n${input.context}`,
                    }).pipe(Effect.timeout("5 seconds"));
                  }),
                )
                .pipe(Effect.ignoreCause),
              serviceScope,
            );
          }),
        )
        .pipe(Effect.mapError(toLiveError));

    function submitWork(input: {
      readonly principalSessionId: string;
      readonly leaseId: string;
      readonly generation: number;
      readonly plannerNativeThreadId: string;
      readonly plannerTurnId: string;
      readonly callId: string;
      readonly message: string;
      readonly requestId?: string;
      readonly projectId?: string;
      readonly voiceIntake?: VoiceIntakeProvenance;
      readonly validateSource?: Effect.Effect<boolean>;
      readonly previewContext?: string | null;
      readonly dispatchOptions?: DispatchRuntimeOptions;
      readonly sourceTransfer?: {
        readonly intentId: string;
        readonly requestIds: ReadonlyArray<string>;
      };
    }) {
      const intentTurnId =
        input.requestId === undefined ? input.plannerTurnId : `request:${input.requestId}`;
      return leaseLocks.withLock(
        leaseKey(input.leaseId, input.generation),
        Effect.gen(function* () {
          const sessions = yield* authSessions
            .listActive()
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          const principal = sessions.find(
            (candidate) => candidate.sessionId === input.principalSessionId,
          );
          const currentRow = yield* getOwnedLease(
            input.principalSessionId,
            input.leaseId,
            input.generation,
          );
          if (
            principal === undefined ||
            principal.subject !== currentRow.principal_subject ||
            !principal.scopes.includes(AuthOrchestrationOperateScope)
          ) {
            return yield* liveError("session_not_found");
          }
          if (currentRow.planner_native_thread_id !== input.plannerNativeThreadId) {
            return yield* liveError("stale_lease");
          }
          const commandId = CommandId.make(
            `command:live-voice:${encodeURIComponent(input.leaseId)}:${input.generation}:${encodeURIComponent(intentTurnId)}:submit-0`,
          );
          const messageId = MessageId.make(
            `message:live-voice:${encodeURIComponent(input.leaseId)}:${input.generation}:${encodeURIComponent(intentTurnId)}:submit-0`,
          );
          if (input.validateSource && !(yield* input.validateSource))
            return yield* liveError("stale_lease");
          let transfer:
            | {
                before: VoiceIntakeIntent;
                after: VoiceIntakeIntent;
                completedSources: VoiceIntakeProvenance["sources"];
                pending: ReadonlyArray<NonNullable<VoiceIntakeIntent["pendingSteer"]>>;
              }
            | undefined;
          if (input.voiceIntake) {
            const claimed = yield* sql<{
              receipt_json: string;
              planner_turn_id: string;
            }>`SELECT receipt_json, planner_turn_id FROM codex_live_voice_intents WHERE lease_id = ${input.leaseId} AND generation = ${input.generation} AND planner_turn_id <> ${intentTurnId} AND dispatch_state IN ('reserved','admitted') AND receipt_json IS NOT NULL`;
            if (input.sourceTransfer) {
              const existing = yield* sql<{
                receipt_json: string | null;
              }>`SELECT receipt_json FROM codex_live_voice_intents
                WHERE lease_id = ${input.leaseId} AND generation = ${input.generation} AND planner_turn_id = ${intentTurnId}`;
              const reserved = existing[0]?.receipt_json
                ? (decodeReceipt(existing[0].receipt_json) as Record<string, unknown>)
                : undefined;
              const priorTransfer = reserved?.sourceTransfer;
              const replay =
                typeof priorTransfer === "object" &&
                priorTransfer !== null &&
                "intentId" in priorTransfer &&
                priorTransfer.intentId === input.sourceTransfer.intentId &&
                (("requestIds" in priorTransfer &&
                  Array.isArray(priorTransfer.requestIds) &&
                  priorTransfer.requestIds.length === input.sourceTransfer.requestIds.length &&
                  priorTransfer.requestIds.every(
                    (id, index) => id === input.sourceTransfer!.requestIds[index],
                  )) ||
                  ("requestId" in priorTransfer &&
                    input.sourceTransfer.requestIds.length === 1 &&
                    priorTransfer.requestId === input.sourceTransfer.requestIds[0]));
              if (existing.length && !replay) return yield* liveError("dispatch_conflict");
              if (!replay) {
                const record = claimed.find(
                  (record) =>
                    record.planner_turn_id === `request:${input.sourceTransfer!.intentId}`,
                );
                const receipt = record
                  ? (decodeReceipt(record.receipt_json) as Record<string, unknown>)
                  : undefined;
                if (
                  !isIntakeIntent(receipt?.intakeIntent) ||
                  !isIntakeProvenance(receipt.voiceIntake)
                )
                  return yield* liveError("dispatch_conflict");
                const owner = receipt.intakeIntent;
                const transferred = transferVoiceIntakeClaim(
                  owner,
                  input.sourceTransfer.requestIds,
                  input.voiceIntake.sources,
                );
                if (!transferred) return yield* liveError("dispatch_conflict");
                const actual = yield* threads.getThreadProjection(ThreadId.make(owner.threadId));
                const run = actual.runs.find((run) => run.id === owner.runId);
                if (
                  !run ||
                  !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                    run.status,
                  ) ||
                  actual.messages.some(
                    (message) =>
                      input.sourceTransfer!.requestIds.some(
                        (requestId) => message.id === `message:intake-steer:${requestId}`,
                      ) && message.runId === owner.runId,
                  )
                )
                  return yield* liveError("dispatch_conflict");
                transfer = {
                  before: owner,
                  after: transferred,
                  completedSources: receipt.voiceIntake.sources,
                  pending: [owner.pendingSteer, ...(owner.queuedSteers ?? [])].filter(
                    (item): item is NonNullable<VoiceIntakeIntent["pendingSteer"]> =>
                      item !== null && input.sourceTransfer!.requestIds.includes(item.requestId),
                  ),
                };
              }
            }
            for (const record of claimed) {
              const value = decodeReceipt(record.receipt_json) as Record<string, unknown>;
              const sources =
                transfer && record.planner_turn_id === `request:${transfer.before.id}`
                  ? transfer.after.claimedSources
                  : isIntakeIntent(value.intakeIntent)
                    ? value.intakeIntent.claimedSources
                    : isIntakeProvenance(value.voiceIntake)
                      ? value.voiceIntake.sources
                      : [];
              if (
                input.voiceIntake.sources.some((source) =>
                  sources.some(
                    (prior) =>
                      prior.segmentId === source.segmentId &&
                      prior.start < source.end &&
                      source.start < prior.end,
                  ),
                )
              )
                return yield* liveError("dispatch_conflict");
            }
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const frozenPreview =
            input.previewContext === undefined
              ? (active.get(leaseKey(input.leaseId, input.generation))?.previewContext ?? null)
              : input.previewContext;
          const sourceInstruction =
            input.voiceIntake === undefined
              ? undefined
              : transfer
                ? (() => {
                    const groups = transfer.pending.map((pending, index) =>
                      voiceIntakeInstruction(
                        pending.sources,
                        pending.previewContext,
                        index === 0 ? transfer.completedSources : undefined,
                      ),
                    );
                    return groups.every((group) => group !== undefined)
                      ? groups.join("\n\n")
                      : undefined;
                  })()
                : voiceIntakeInstruction(input.voiceIntake.sources, frozenPreview);
          if (input.voiceIntake && sourceInstruction === undefined)
            return yield* liveError("invalid_state");
          const priorIntents = yield* sql<{
            dispatch_state: "reserved" | "admitted" | "conflict";
          }>`
            SELECT dispatch_state FROM codex_live_voice_intents
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
              AND planner_native_thread_id = ${input.plannerNativeThreadId}
              AND planner_turn_id = ${intentTurnId} AND submit_slot = 0
          `;
          if (
            (priorIntents.length === 0 || input.voiceIntake !== undefined) &&
            currentRow.status !== "starting" &&
            currentRow.status !== "active"
          ) {
            return yield* liveError("stale_lease");
          }
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (transfer) {
                const changed =
                  yield* sql`UPDATE codex_live_voice_intents SET receipt_json = json_set(receipt_json, '$.intakeIntent', json(${encodeReceipt(transfer.after)}))
                WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
                  AND planner_turn_id = ${`request:${transfer.before.id}`} AND dispatch_state = 'admitted'
                  AND json_extract(receipt_json, '$.intakeIntent') = json(${encodeReceipt(transfer.before)}) RETURNING planner_turn_id`;
                if (changed.length !== 1) return yield* liveError("dispatch_conflict");
              }
              yield* sql`
          INSERT OR IGNORE INTO codex_live_voice_intents (
            lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
            call_id, message, command_id, message_id, dispatch_state, receipt_json, updated_at
          ) VALUES (
            ${input.leaseId}, ${input.generation}, ${input.plannerNativeThreadId},
            ${intentTurnId}, 0, ${input.callId}, ${input.message.trim()},
            ${commandId}, ${messageId}, 'reserved', ${input.requestId === undefined ? null : encodeReceipt({ requestedProjectId: input.projectId ?? null, previewContext: frozenPreview, ...(input.voiceIntake === undefined ? {} : { voiceIntake: input.voiceIntake, sourceInstruction }), ...(input.sourceTransfer === undefined ? {} : { sourceTransfer: input.sourceTransfer }) })}, ${now}
          )
        `;
            }),
          );
          const intents = yield* sql<{
            message: string;
            command_id: string;
            message_id: string;
            dispatch_state: "reserved" | "admitted" | "conflict";
            receipt_json: string | null;
          }>`
          SELECT message, command_id, message_id, dispatch_state, receipt_json
          FROM codex_live_voice_intents
          WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
            AND planner_native_thread_id = ${input.plannerNativeThreadId}
            AND planner_turn_id = ${intentTurnId} AND submit_slot = 0
        `;
          const intent = intents[0];
          if (intent === undefined) return yield* liveError("runtime_unavailable");
          if (intent.message !== input.message.trim()) {
            return yield* liveError("dispatch_conflict");
          }
          if (
            input.requestId !== undefined &&
            intent.receipt_json !== null &&
            (decodeReceipt(intent.receipt_json) as Record<string, unknown>).requestedProjectId !==
              (input.projectId ?? null)
          )
            return yield* liveError("dispatch_conflict");
          if (intent.dispatch_state === "conflict") {
            return yield* liveError("dispatch_conflict");
          }
          const reserved =
            intent.receipt_json === null
              ? undefined
              : (decodeReceipt(intent.receipt_json) as Record<string, unknown>);
          const previewContext =
            reserved && "previewContext" in reserved
              ? typeof reserved.previewContext === "string"
                ? reserved.previewContext
                : null
              : input.previewContext;
          if (
            input.voiceIntake &&
            (!isIntakeProvenance(reserved?.voiceIntake) ||
              encodeIntakeProvenance(reserved.voiceIntake) !==
                encodeIntakeProvenance(input.voiceIntake))
          )
            return yield* liveError("dispatch_conflict");
          const executionText = input.voiceIntake
            ? typeof reserved?.sourceInstruction === "string"
              ? reserved.sourceInstruction
              : voiceIntakeInstruction(input.voiceIntake.sources, previewContext)
            : withPreviewContext(input.message.trim(), previewContext);
          if (executionText === undefined) return yield* liveError("invalid_state");
          if (intent.dispatch_state === "admitted" && intent.receipt_json !== null) {
            const priorReceipt = decodeReceipt(intent.receipt_json) as Record<string, unknown>;
            if (
              input.requestId !== undefined &&
              priorReceipt.requestedProjectId !== (input.projectId ?? null)
            )
              return yield* liveError("dispatch_conflict");
            return encodeReceipt({
              accepted: priorReceipt.accepted,
              delivery: priorReceipt.delivery,
              runId: priorReceipt.runId,
              ...(input.requestId === undefined
                ? {}
                : {
                    requestId: priorReceipt.requestId,
                    requestedProjectId: priorReceipt.requestedProjectId,
                    previewContext: priorReceipt.previewContext ?? null,
                    taskId: priorReceipt.taskId,
                    threadId: priorReceipt.threadId,
                    projectId: priorReceipt.projectId,
                    admissionRunId: priorReceipt.admissionRunId,
                    status: priorReceipt.status,
                    resultReady: false,
                  }),
            });
          }
          const projection = yield* threads
            .getProjectThread({
              projectId: (yield* threads.getThreadProjection(
                currentRow.thread_id as LiveVoiceSession["threadId"],
              )).thread.projectId,
              threadId: currentRow.thread_id as LiveVoiceSession["threadId"],
            })
            .pipe(Effect.mapError(() => liveError("session_not_found")));
          const providerInstance = yield* providerInstances.getInstance(
            projection.thread.providerInstanceId,
          );
          const currentRuntimePolicy = yield* runtimePolicies
            .resolve({
              thread: projection.thread,
              modelSelection: projection.thread.modelSelection,
            })
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          if (
            projection.thread.providerInstanceId !== currentRow.provider_instance_id ||
            providerInstance?.driverKind !== "codex" ||
            projection.thread.archivedAt !== null ||
            encodeModelSelection(projection.thread.modelSelection) !==
              currentRow.model_selection_json ||
            encodeRuntimePolicy(currentRuntimePolicy) !== currentRow.runtime_policy_json
          ) {
            yield* sql`
              UPDATE codex_live_voice_intents SET dispatch_state = 'conflict',
                updated_at = ${DateTime.formatIso(yield* DateTime.now)}
              WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
                AND planner_native_thread_id = ${input.plannerNativeThreadId}
                AND planner_turn_id = ${intentTurnId} AND submit_slot = 0
                AND dispatch_state = 'reserved'
            `;
            return yield* liveError("stale_lease");
          }
          if (input.validateSource && !(yield* input.validateSource)) {
            yield* sql`UPDATE codex_live_voice_intents SET dispatch_state = 'conflict'
              WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
                AND planner_turn_id = ${intentTurnId} AND dispatch_state = 'reserved'`;
            return yield* liveError("stale_lease");
          }
          const result =
            input.requestId === undefined ||
            (input.voiceIntake !== undefined &&
              !input.voiceIntake.provisional &&
              (input.projectId === undefined || input.projectId === projection.thread.projectId))
              ? yield* threads
                  .sendToThread(
                    {
                      projectId: projection.thread.projectId,
                      threadId: projection.thread.id,
                      commandId: CommandId.make(intent.command_id),
                      messageId: MessageId.make(intent.message_id),
                      text: executionText,
                      attachments: [],
                      mode: "auto",
                      ...(input.voiceIntake === undefined
                        ? {}
                        : {
                            voiceIntakeSource: input.voiceIntake,
                            voiceIntakeSourceThreadId: projection.thread.id,
                          }),
                      createdBy: "user",
                      creationSource: "voice",
                    },
                    input.dispatchOptions,
                  )
                  .pipe(
                    Effect.map((sent) => ({
                      delivery: sent.delivery,
                      runId: sent.run.id,
                      threadId: projection.thread.id,
                      projectId: projection.thread.projectId,
                      ...(input.requestId === undefined
                        ? {}
                        : {
                            requestId: input.requestId,
                            requestedProjectId: input.projectId ?? null,
                            status: sent.run.status,
                            resultReady: false,
                          }),
                    })),
                    Effect.mapError(() => liveError("runtime_unavailable")),
                  )
              : yield* conversationWork
                  .delegate(
                    {
                      projectId: projection.thread.projectId,
                      threadId: projection.thread.id,
                      commandId: CommandId.make(intent.command_id),
                      messageId: MessageId.make(intent.message_id),
                      text: executionText,
                      createdBy: "user",
                      creationSource: "voice",
                      delegation: {
                        modelSelection: projection.thread.modelSelection,
                        ...(input.voiceIntake === undefined
                          ? {}
                          : { voiceIntake: input.voiceIntake }),
                        ...(input.projectId === undefined
                          ? {}
                          : { projectId: ProjectId.make(input.projectId) }),
                      },
                    },
                    input.dispatchOptions,
                  )
                  .pipe(
                    Effect.map((admitted) => ({
                      delivery: "delegated",
                      runId: admitted.childRunId,
                      threadId: admitted.childThreadId,
                      projectId: admitted.projectId,
                      taskId: admitted.taskId,
                      admissionRunId: admitted.admissionRunId,
                      status: admitted.status,
                      requestId: input.requestId,
                      requestedProjectId: input.projectId ?? null,
                      resultReady: false,
                    })),
                    Effect.mapError(() => liveError("dispatch_conflict")),
                  );
          const receipt = encodeReceipt({
            ...reserved,
            accepted: true,
            ...(input.voiceIntake === undefined ? {} : { voiceIntake: input.voiceIntake }),
            ...(input.requestId === undefined
              ? { delivery: result.delivery, runId: result.runId }
              : result),
          });
          yield* sql`
          UPDATE codex_live_voice_intents SET dispatch_state = 'admitted', receipt_json = ${receipt},
            updated_at = ${DateTime.formatIso(yield* DateTime.now)}
          WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
            AND planner_native_thread_id = ${input.plannerNativeThreadId}
            AND planner_turn_id = ${intentTurnId} AND submit_slot = 0
        `.pipe(
            Effect.catch(() =>
              Effect.logWarning("Accepted voice admission receipt awaits reconciliation."),
            ),
          );
          yield* startReadbackWorker({
            leaseId: input.leaseId,
            generation: input.generation,
            threadId: result.threadId,
            projectId: result.projectId,
            plannerNativeThreadId: input.plannerNativeThreadId,
            plannerTurnId: intentTurnId,
            runId: result.runId,
          });
          return receipt;
        }),
      );
    }

    const startIntake = Effect.fn("CodexLiveSessionService.startIntake")(
      (
        principal: EnvironmentAuth.AuthenticatedSession,
        row: LeaseRow,
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      ) =>
        Effect.gen(function* () {
          const decide = runtime.liveVoice?.decideIntake;
          if (!decide || !row.planner_native_thread_id) return;
          const instance = yield* providerInstances.getInstance(
            ProviderInstanceId.make(row.provider_instance_id),
          );
          const catalog = instance ? yield* instance.snapshot.getSnapshot : undefined;
          const model = catalog?.models.find((candidate) => candidate.slug === "gpt-6-luna");
          const hasOption = (id: string, value: string) =>
            model?.capabilities?.optionDescriptors?.some(
              (option) =>
                option.id === id &&
                option.type === "select" &&
                option.options.some((choice) => choice.id === value),
            );
          if (
            !model ||
            !hasOption("reasoningEffort", "medium") ||
            !hasOption("serviceTier", "priority")
          )
            return yield* liveError("planner_restriction_failed");
          const selection: ModelSelection = {
            instanceId: runtime.instanceId,
            model: model.slug,
            options: [
              { id: "reasoningEffort", value: "medium" },
              { id: "serviceTier", value: "priority" },
            ],
          };
          const current = ensurePrincipal(principal).pipe(
            Effect.andThen(getOwnedLease(principal.sessionId, row.lease_id, row.generation)),
            Effect.map(
              (lease) =>
                ["starting", "active"].includes(lease.status) &&
                lease.planner_native_thread_id === row.planner_native_thread_id,
            ),
            Effect.catch(() => Effect.succeed(false)),
          );
          const saved = yield* sql<{ receipt_json: string; message: string }>`
          SELECT i.receipt_json, i.message FROM codex_live_voice_intents i
          JOIN codex_live_voice_leases l ON l.lease_id = i.lease_id AND l.generation = i.generation
          WHERE l.thread_id = ${row.thread_id} AND l.principal_session_id = ${principal.sessionId}
            AND i.dispatch_state = 'admitted' AND i.receipt_json IS NOT NULL
          ORDER BY i.updated_at DESC LIMIT 128
        `;
          const restored = saved.flatMap((record) => {
            const value = decodeReceipt(record.receipt_json) as Record<string, unknown>;
            if (isIntakeIntent(value.intakeIntent)) return [value.intakeIntent];
            if (
              !isIntakeProvenance(value.voiceIntake) ||
              (typeof value.taskId !== "string" && value.threadId !== row.thread_id) ||
              typeof value.threadId !== "string" ||
              typeof value.runId !== "string"
            )
              return [];
            return [
              {
                id: value.voiceIntake.intentId,
                request: record.message,
                sources: value.voiceIntake.sources,
                claimedSources: value.voiceIntake.sources,
                provisional: value.voiceIntake.provisional,
                startedProvisional: value.voiceIntake.provisional,
                pendingSteer: null,
                taskId:
                  typeof value.taskId === "string" ? value.taskId : value.voiceIntake.intentId,
                threadId: value.threadId,
                runId: value.runId,
                status: String(value.status),
                result: null,
              },
            ];
          });
          // Main intents have no subagent node; the intent ID is their internal
          // locator. Keep actual child task IDs for isolated/provisional work.
          const isMainIntent = (intent: VoiceIntakeIntent) =>
            intent.threadId === row.thread_id && intent.taskId === intent.id;
          const read = (intent: VoiceIntakeIntent) =>
            (isMainIntent(intent)
              ? threads.getThreadProjection(ThreadId.make(row.thread_id)).pipe(
                  Effect.flatMap((projection) => {
                    const run = projection.runs.find((run) => run.id === intent.runId);
                    return run
                      ? Effect.succeed({ projection, run })
                      : Effect.fail(liveError("session_not_found"));
                  }),
                  Effect.mapError(() => liveError("session_not_found")),
                )
              : conversationWork
                  .read({
                    threadId: ThreadId.make(row.thread_id),
                    taskId: NodeId.make(intent.taskId),
                    runId: RunId.make(intent.runId),
                  })
                  .pipe(
                    Effect.map(({ projection, run }) => ({ projection, run })),
                    Effect.mapError(() => liveError("session_not_found")),
                  )
            ).pipe(
              Effect.map(({ projection, run }) => {
                const result = inspectReadback(projection, run.id);
                const unhandled = [intent.pendingSteer, ...(intent.queuedSteers ?? [])]
                  .filter(
                    (pending): pending is NonNullable<VoiceIntakeIntent["pendingSteer"]> =>
                      pending !== null,
                  )
                  .filter(
                    (pending) =>
                      !projection.messages.some(
                        (message) =>
                          message.id === `message:intake-steer:${pending.requestId}` &&
                          message.runId === intent.runId &&
                          message.threadId === projection.thread.id &&
                          (message.text ===
                            voiceIntakeInstruction(pending.sources, pending.previewContext) ||
                            // Recognize accepted pre-formatter commands after upgrading.
                            message.text ===
                              withPreviewContext(pending.message, pending.previewContext)),
                      ),
                  );
                return {
                  ...intent,
                  pendingSteer: unhandled[0] ?? null,
                  queuedSteers: unhandled.slice(1),
                  runId: run.id,
                  projectId: projection.thread.projectId,
                  status: run.status,
                  result: result.type === "ready" ? result.text.slice(0, 8_000) : null,
                };
              }),
              Effect.catch(() =>
                Effect.succeed({ ...intent, status: "unavailable", result: null }),
              ),
            );
          const projectCatalog = (yield* projects.listShells())
            .slice(0, 24)
            .map((project) => ({ id: project.id, title: project.title }));
          const source = yield* threads.getThreadProjection(ThreadId.make(row.thread_id));
          // The admission commit is authoritative even if a later receipt update failed.
          for (const task of source.subagents) {
            const provenance = source.runs.find((run) => run.id === task.runId)?.delegationAdmission
              ?.voiceIntake;
            if (
              !provenance ||
              task.childThreadId === null ||
              restored.some((intent) => intent.id === provenance.intentId)
            )
              continue;
            const observed = yield* conversationWork
              .read({ threadId: source.thread.id, taskId: task.id })
              .pipe(Effect.option);
            if (Option.isNone(observed)) continue;
            restored.push({
              id: provenance.intentId,
              request: task.prompt,
              sources: provenance.sources,
              claimedSources: provenance.sources,
              provisional:
                observed.value.projection.thread.voiceIntake?.provisional ?? provenance.provisional,
              startedProvisional: provenance.provisional,
              pendingSteer: null,
              taskId: task.id,
              threadId: task.childThreadId,
              runId: observed.value.run.id,
              status: observed.value.run.status,
              result: null,
            });
          }
          const sourceSemaphore = yield* Semaphore.make(1);
          const intakeLease = active.get(leaseKey(row.lease_id, row.generation));
          if (!intakeLease) return yield* liveError("stale_lease");
          intakeLease.sourceSemaphore = sourceSemaphore;
          function commitOptions(
            sources: VoiceIntakeProvenance["sources"],
            originalGroups: ReadonlyArray<VoiceIntakeProvenance["sources"]> = [],
          ): DispatchRuntimeOptions {
            return {
              voiceIntakeCommitGuard: {
                semaphore: sourceSemaphore,
                isCurrent: () =>
                  active.get(leaseKey(row.lease_id, row.generation)) === intakeLease &&
                  intakeLease!.acceptingWork !== false &&
                  engine.validateSourcesNow(sources) &&
                  originalGroups.every((group) => engine.validateSourcesNow(group)),
              },
            };
          }
          const engine = makeVoiceIntake({
            defaultProjectId: source.thread.projectId,
            projects: projectCatalog,
            leaseId: row.lease_id,
            generation: row.generation,
            restored,
            getPreviewContext: () =>
              active.get(leaseKey(row.lease_id, row.generation))?.previewContext ?? null,
            current,
            stopId: readIntakeStopId(row.thread_id),
            provisionalAllowed:
              runtime.liveVoice?.canStartProvisionalWork === undefined
                ? false
                : yield* runtime.liveVoice.canStartProvisionalWork,
            decide: (snapshot) =>
              decide({ snapshot, modelSelection: selection }).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (!isIntakeTimeout(error)) return yield* Effect.fail(error);
                    const latest = yield* engine.state;
                    if (
                      !latest.enabled ||
                      latest.version !== snapshot.version ||
                      intakeLease.acceptingWork === false
                    )
                      return yield* Effect.fail(error);
                    yield* Effect.logWarning("Voice intake decision retrying.", {
                      failureClass: "TimeoutError",
                      version: snapshot.version,
                      attempt: 2,
                    });
                    // Exactly one retry of this frozen snapshot; newer speech wins.
                    return yield* decide({ snapshot, modelSelection: selection });
                  }),
                ),
              ),
            admit: Effect.fn("CodexLiveSessionService.admitIntake")(function* (
              voiceIntake: VoiceIntakeProvenance,
              request: string,
              projectId?: string,
              previewContext?: string | null,
              sourceTransfer?: {
                readonly intentId: string;
                readonly requestIds: ReadonlyArray<string>;
              },
            ) {
              const originals = sourceTransfer
                ? (yield* engine.state).intents.flatMap((intent) =>
                    intent.id === sourceTransfer.intentId
                      ? [intent.pendingSteer, ...(intent.queuedSteers ?? [])]
                          .filter(
                            (pending): pending is NonNullable<VoiceIntakeIntent["pendingSteer"]> =>
                              pending !== null &&
                              sourceTransfer.requestIds.includes(pending.requestId),
                          )
                          .map((pending) => pending.sources)
                      : [],
                  )
                : [];
              if (sourceTransfer && originals.length !== sourceTransfer.requestIds.length)
                return yield* liveError("dispatch_conflict");
              // A reclassification may quote pieces separately. The original
              // pending anchor groups still fence the exact transferred work.
              const json = yield* submitWork({
                principalSessionId: principal.sessionId,
                leaseId: row.lease_id,
                generation: row.generation,
                plannerNativeThreadId: row.planner_native_thread_id!,
                plannerTurnId: voiceIntake.intentId,
                callId: voiceIntake.intentId,
                requestId: voiceIntake.intentId,
                message: request,
                voiceIntake,
                previewContext: previewContext ?? null,
                validateSource: engine
                  .validateSources(voiceIntake.sources)
                  .pipe(
                    Effect.map(
                      (valid) =>
                        valid && originals.every((group) => engine.validateSourcesNow(group)),
                    ),
                  ),
                dispatchOptions: commitOptions(voiceIntake.sources, originals),
                ...(sourceTransfer ? { sourceTransfer } : {}),
                ...(projectId === undefined ? {} : { projectId }),
              });
              const receipt = decodeReceipt(json) as Record<string, unknown>;
              return {
                id: voiceIntake.intentId,
                request,
                sources: voiceIntake.sources,
                claimedSources: voiceIntake.sources,
                provisional: voiceIntake.provisional,
                startedProvisional: voiceIntake.provisional,
                pendingSteer: null,
                projectId: String(receipt.projectId),
                taskId: typeof receipt.taskId === "string" ? receipt.taskId : voiceIntake.intentId,
                threadId: String(receipt.threadId),
                runId: String(receipt.runId),
                status: String(receipt.status),
                result: null,
              };
            }),
            read,
            steer: (intent, _message, requestId, readOnly, previewContext) =>
              leaseLocks.withLock(
                leaseKey(row.lease_id, row.generation),
                Effect.gen(function* () {
                  if (!(yield* current)) return yield* liveError("stale_lease");
                  if (
                    intent.pendingSteer &&
                    !(yield* engine.validateSources(intent.pendingSteer.sources))
                  )
                    return yield* liveError("stale_lease");
                  const instruction = intent.pendingSteer
                    ? voiceIntakeInstruction(intent.pendingSteer.sources, previewContext)
                    : undefined;
                  if (instruction === undefined) return yield* liveError("invalid_state");
                  if (isMainIntent(intent)) {
                    const sources = intent.pendingSteer?.sources;
                    if (!sources?.length) return yield* liveError("dispatch_conflict");
                    yield* threads.dispatch(
                      {
                        type: "message.dispatch",
                        threadId: source.thread.id,
                        commandId: CommandId.make(`command:intake-steer:${requestId}`),
                        messageId: MessageId.make(`message:intake-steer:${requestId}`),
                        text: instruction,
                        attachments: [],
                        dispatchMode: {
                          type: "steer_active",
                          targetRunId: RunId.make(intent.runId),
                          onInactive: "reject",
                        },
                        createdBy: "user",
                        creationSource: "voice",
                        voiceIntakeSource: {
                          leaseId: row.lease_id,
                          generation: row.generation,
                          intentId: intent.id,
                          provisional: false,
                          sources,
                          stopId: sources[0]!.stopId,
                        },
                        voiceIntakeSourceThreadId: source.thread.id,
                      },
                      commitOptions(sources),
                    );
                    return { intent: yield* read(intent), delivered: true };
                  }
                  const exact = yield* conversationWork.read({
                    threadId: ThreadId.make(row.thread_id),
                    taskId: NodeId.make(intent.taskId),
                    runId: RunId.make(intent.runId),
                  });
                  const provenance = exact.projection.thread.voiceIntake;
                  const sources = intent.pendingSteer?.sources;
                  if (!provenance || provenance.intentId !== intent.id || !sources?.length)
                    return yield* liveError("dispatch_conflict");
                  const restart = intent.startedProvisional && !readOnly;
                  if (restart && (provenance.provisional || exact.run.status !== "running"))
                    return yield* liveError("invalid_state");
                  yield* threads.dispatch(
                    {
                      type: "message.dispatch",
                      threadId: exact.projection.thread.id,
                      commandId: CommandId.make(`command:intake-steer:${requestId}`),
                      messageId: MessageId.make(`message:intake-steer:${requestId}`),
                      text: instruction,
                      attachments: [],
                      createdBy: "user",
                      creationSource: "voice",
                      voiceIntakeSource: { ...provenance, sources, stopId: sources[0]!.stopId },
                      dispatchMode: restart
                        ? { type: "restart_active", targetRunId: exact.run.id }
                        : { type: "steer_active", targetRunId: exact.run.id, onInactive: "reject" },
                    },
                    commitOptions(sources),
                  );
                  return {
                    intent: yield* read({
                      ...intent,
                      startedProvisional: intent.startedProvisional && readOnly,
                    }),
                    delivered: true,
                  };
                }).pipe(
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      const latest = yield* read(intent);
                      const unavailable =
                        isDispatchError(error) &&
                        isTransientSteerError(error.cause) &&
                        error.cause.runId === intent.runId;
                      const terminal = [
                        "completed",
                        "failed",
                        "interrupted",
                        "cancelled",
                        "rolled_back",
                      ].includes(latest.status);
                      if (!unavailable && !terminal) return yield* Effect.fail(error);
                      const stillPending = [
                        latest.pendingSteer,
                        ...(latest.queuedSteers ?? []),
                      ].some((pending) => pending?.requestId === requestId);
                      return { intent: latest, delivered: !stillPending };
                    }),
                  ),
                ),
              ),
            confirm: (intent) =>
              leaseLocks.withLock(
                leaseKey(row.lease_id, row.generation),
                Effect.gen(function* () {
                  if (!(yield* current)) return yield* liveError("stale_lease");
                  if (!(yield* engine.validateSources(intent.sources)))
                    return yield* liveError("stale_lease");
                  if (isMainIntent(intent)) return;
                  const child = yield* threads.getThreadProjection(ThreadId.make(intent.threadId));
                  const provenance = child.thread.voiceIntake;
                  if (!provenance || provenance.intentId !== intent.id)
                    return yield* liveError("dispatch_conflict");
                  yield* threads.dispatch(
                    {
                      type: "thread.runtime-mode.set",
                      threadId: child.thread.id,
                      commandId: CommandId.make(`command:intake-confirm:${intent.id}`),
                      runtimeMode: child.thread.runtimeMode,
                      voiceIntakeConfirmation: {
                        ...provenance,
                        provisional: false,
                        sources: intent.sources,
                      },
                    },
                    commitOptions(intent.sources),
                  );
                }),
              ),
            store: Effect.fn("CodexLiveSessionService.storeIntake")(function* (
              intent: VoiceIntakeIntent,
            ) {
              const rows = yield* sql<{
                receipt_json: string;
                dispatch_state: string;
                lease_id: string;
                generation: number;
                message_id: string;
              }>`SELECT receipt_json, dispatch_state, lease_id, generation, message_id FROM codex_live_voice_intents WHERE planner_turn_id = ${`request:${intent.id}`} AND dispatch_state IN ('reserved','admitted')`;
              const record = rows[0];
              if (!record) return yield* liveError("dispatch_conflict");
              if (record.dispatch_state === "reserved") {
                if (isMainIntent(intent)) {
                  const actual = yield* threads.getThreadProjection(ThreadId.make(row.thread_id));
                  if (
                    !actual.messages.some(
                      (message) =>
                        message.id === record.message_id && message.runId === intent.runId,
                    ) ||
                    !actual.runs.some((run) => run.id === intent.runId)
                  )
                    return yield* liveError("dispatch_conflict");
                  const stored = decodeReceipt(record.receipt_json) as Record<string, unknown>;
                  yield* sql`UPDATE codex_live_voice_intents SET dispatch_state = 'admitted', receipt_json = ${encodeReceipt(
                    {
                      ...stored,
                      accepted: true,
                      delivery: "accepted",
                      requestId: intent.id,
                      threadId: intent.threadId,
                      runId: intent.runId,
                      projectId: actual.thread.projectId,
                      status: intent.status,
                      resultReady: false,
                      intakeIntent: intent,
                    },
                  )} WHERE planner_turn_id = ${`request:${intent.id}`} AND dispatch_state = 'reserved'`;
                  return;
                }
                const actual = yield* conversationWork.read({
                  threadId: ThreadId.make(row.thread_id),
                  taskId: NodeId.make(intent.taskId),
                  runId: RunId.make(intent.runId),
                });
                if (actual.task.runId === null || actual.projection.thread.id !== intent.threadId)
                  return yield* liveError("dispatch_conflict");
                const stored = decodeReceipt(record.receipt_json) as Record<string, unknown>;
                const receipt = {
                  ...stored,
                  accepted: true,
                  delivery: "delegated",
                  requestId: intent.id,
                  taskId: actual.task.id,
                  threadId: actual.projection.thread.id,
                  runId: actual.run.id,
                  projectId: actual.projection.thread.projectId,
                  admissionRunId: actual.task.runId,
                  status: actual.run.status,
                  resultReady: false,
                  intakeIntent: intent,
                };
                yield* sql`UPDATE codex_live_voice_intents SET dispatch_state = 'admitted', receipt_json = ${encodeReceipt(receipt)} WHERE planner_turn_id = ${`request:${intent.id}`} AND dispatch_state = 'reserved'`;
                if (record.lease_id === row.lease_id && record.generation === row.generation)
                  yield* startReadbackWorker({
                    leaseId: row.lease_id,
                    generation: row.generation,
                    threadId: actual.projection.thread.id,
                    projectId: actual.projection.thread.projectId,
                    plannerNativeThreadId: row.planner_native_thread_id!,
                    plannerTurnId: `request:${intent.id}`,
                    runId: actual.run.id,
                    replace: true,
                  });
              } else
                yield* sql`UPDATE codex_live_voice_intents SET receipt_json = json_set(receipt_json, '$.intakeIntent', json(${encodeReceipt(intent)})) WHERE planner_turn_id = ${`request:${intent.id}`} AND dispatch_state = 'admitted'`;
            }),
          });
          intakes.set(leaseKey(row.lease_id, row.generation), engine);
          const wake = yield* Queue.sliding<void>(1);
          intakeWakes.set(leaseKey(row.lease_id, row.generation), wake);
          const subscribed = yield* Deferred.make<void>();
          const output = yield* Queue.sliding<Effect.Success<typeof engine.state>>(1);
          let lastNotice = 0;
          let lastRejection = 0;
          const outputWorker = yield* Effect.forever(
            Effect.gen(function* () {
              const state = yield* Queue.take(output);
              yield* outputLocks.withLock(
                leaseKey(row.lease_id, row.generation),
                Effect.gen(function* () {
                  if (!(yield* current) || !runtime.liveVoice?.appendContext) return;
                  const projection = yield* threads.getThreadProjection(
                    ThreadId.make(row.thread_id),
                  );
                  const policy = yield* runtimePolicies.resolve({
                    thread: projection.thread,
                    modelSelection: projection.thread.modelSelection,
                  });
                  const lease = yield* getLease(row.lease_id, row.generation);
                  if (!lease || !readbackContextMatches(lease, projection, policy)) return;
                  yield* runtime.liveVoice.appendContext({
                    plannerNativeThreadId: row.planner_native_thread_id!,
                    text: encodeReceipt({
                      type: "voice_intake_state",
                      version: state.noticeVersion,
                      reason: state.reason,
                      tasks: state.intents.slice(-12).map((intent) => ({
                        ...(isMainIntent(intent)
                          ? { threadId: intent.threadId }
                          : { taskId: intent.taskId }),
                        runId: intent.runId,
                        request: intent.request.slice(0, 300),
                        status: intent.status,
                        provisional: intent.provisional,
                        result: intent.result?.slice(0, 1200) ?? null,
                      })),
                    }),
                  });
                }),
              );
            }).pipe(Effect.ignoreCause),
          ).pipe(Effect.forkIn(serviceScope));
          const worker = yield* Effect.gen(function* () {
            while ((yield* engine.state).enabled) {
              yield* Queue.take(wake);
              const attemptVersion = (yield* engine.state).version;
              let failed = false;
              yield* engine.processLatest().pipe(
                Effect.catchCause((cause) => {
                  failed = true;
                  return engine.refused.pipe(
                    Effect.andThen(
                      Effect.logWarning("Voice intake decision refused.", {
                        failureClass: intakeFailureClass(cause),
                        version: attemptVersion,
                      }),
                    ),
                  );
                }),
              );
              const state = yield* engine.state;
              if (state.rejectionVersion > lastRejection && state.rejections.length) {
                lastRejection = state.rejectionVersion;
                yield* Effect.logInfo("Voice intake action rejected.", {
                  version: state.version,
                  noticeVersion: state.noticeVersion,
                  rejections: state.rejections,
                });
              }
              if (
                state.recheckPending ||
                (failed && state.enabled && state.version > attemptVersion)
              )
                yield* Queue.offer(wake, undefined);
              if (state.noticeVersion > lastNotice) {
                lastNotice = state.noticeVersion;
                yield* Queue.offer(output, state);
              }
            }
          }).pipe(Effect.forkIn(serviceScope));
          yield* eventHub.subscribe({ leaseId: row.lease_id, generation: row.generation }).pipe(
            Stream.takeUntil(
              (event) =>
                event.type === "status" &&
                ["stopping", "closed", "failed", "unknown"].includes(event.session.status),
            ),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                // Public transcripts are already published; only intake source
                // invalidation shares the short commit permit, never model I/O.
                yield* sourceSemaphore.withPermits(1)(
                  engine.observe(event, intakeSourceStops.get(event)),
                );
                yield* Deferred.succeed(subscribed, undefined);
                if (!(yield* engine.state).enabled) {
                  yield* Effect.all([Fiber.interrupt(worker), Fiber.interrupt(outputWorker)], {
                    concurrency: "unbounded",
                  }).pipe(Effect.forkIn(serviceScope));
                  if (event.type === "status") {
                    intakes.delete(leaseKey(row.lease_id, row.generation));
                    intakeWakes.delete(leaseKey(row.lease_id, row.generation));
                  }
                } else if (event.type === "transcript" && event.role === "user")
                  yield* Queue.offer(wake, undefined);
              }),
            ),
            Effect.forkIn(serviceScope),
          );
          yield* Deferred.await(subscribed);
        }).pipe(Effect.mapError(toLiveError)),
    );

    const handleNativeEvent = Effect.fn("CodexLiveSessionService.handleNativeEvent")((
      leaseId: string,
      generation: number,
      event: ProviderAdapter.ProviderAdapterV2LiveVoiceEvent,
    ): Effect.Effect<void> => {
      return Effect.gen(function* () {
        const row = yield* getLease(leaseId, generation);
        if (
          row === undefined ||
          row.planner_native_thread_id === null ||
          row.planner_native_thread_id !== event.plannerNativeThreadId
        )
          return;
        switch (event.type) {
          case "started": {
            if (row.status !== "starting" && row.status !== "active") return;
            if (
              event.realtimeSessionId != null &&
              event.realtimeSessionId !== `${leaseId}:${generation}`
            ) {
              yield* updateStatus(row, "unknown");
              return;
            }
            yield* updateStatus(
              row,
              row.native_sdp_received === 1 ? "active" : "starting",
              (now) => sql`
                UPDATE codex_live_voice_leases SET native_started = 1, updated_at = ${now}
                WHERE lease_id = ${leaseId} AND generation = ${generation}
              `,
            );
            return;
          }
          case "sdp": {
            if (row.status !== "starting" && row.status !== "active") return;
            yield* updateStatus(
              row,
              row.native_started === 1 ? "active" : "starting",
              (now) => sql`
                UPDATE codex_live_voice_leases SET native_sdp_received = 1, updated_at = ${now}
                WHERE lease_id = ${leaseId} AND generation = ${generation}
              `,
            );
            yield* eventHub.publish({
              type: "answer",
              leaseId,
              generation,
              sdp: event.sdp.slice(0, 256_000),
            });
            return;
          }
          case "error":
            yield* eventHub.publish({
              type: "error",
              leaseId,
              generation,
              code: "runtime_unavailable",
            });
            yield* updateStatus(row, "failed");
            return;
          case "closed":
            yield* updateStatus(row, "closed");
            yield* stopReadbackWorkers(leaseId, generation);
            active.delete(leaseKey(leaseId, generation));
            return;
          case "transcript": {
            if (
              (row.status !== "active" && row.status !== "starting") ||
              (event.realtimeSessionId !== undefined &&
                event.realtimeSessionId !== `${leaseId}:${generation}`)
            )
              return;
            const speakingLease = active.get(leaseKey(leaseId, generation));
            if (speakingLease) {
              speakingLease.lastSpeechAt = DateTime.toEpochMillis(yield* DateTime.now);
              if (event.role === "user")
                speakingLease.userSpeaking = event.segment?.final === false;
              else speakingLease.assistantSpeaking = event.segment?.final === false;
            }
            const partCount = Math.max(1, Math.ceil(event.text.length / 16_384));
            if (partCount > 256) {
              yield* eventHub.publish({
                type: "error",
                leaseId,
                generation,
                code: "runtime_unavailable",
              });
              return;
            }
            const segment =
              event.segment ??
              (partCount > 1
                ? {
                    id: `legacy:${leaseId}:${++transcriptSequence}`,
                    revision: 1,
                    kind: "snapshot" as const,
                    final: true,
                  }
                : undefined);
            const stopId =
              event.role === "user" &&
              segment !== undefined &&
              intakes.has(leaseKey(leaseId, generation))
                ? yield* readIntakeStopId(row.thread_id)
                : undefined;
            for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
              const published: LiveVoiceEvent = {
                type: "transcript",
                leaseId,
                generation,
                role: event.role,
                text: event.text.slice(partIndex * 16_384, (partIndex + 1) * 16_384),
                ...(segment === undefined ? {} : { segment: { ...segment, partIndex, partCount } }),
              };
              if (stopId !== undefined) intakeSourceStops.set(published, stopId);
              yield* eventHub.publish(published);
            }
            return;
          }
        }
      }).pipe(Effect.catchCause(() => markUnknown(leaseId, generation).pipe(Effect.orDie)));
    });

    const recoverPendingIntents = Effect.fn("CodexLiveSessionService.recoverPendingIntents")((
      leaseId: string,
      generation: number,
    ) => {
      return Effect.gen(function* () {
        const pendingIntents = yield* sql<{
          planner_native_thread_id: string;
          planner_turn_id: string;
          call_id: string;
          message: string;
          receipt_json: string | null;
          principal_session_id: string;
        }>`
          SELECT i.planner_native_thread_id, i.planner_turn_id, i.call_id, i.message, i.receipt_json,
            l.principal_session_id
          FROM codex_live_voice_intents i
          JOIN codex_live_voice_leases l USING (lease_id, generation)
          WHERE i.lease_id = ${leaseId} AND i.generation = ${generation}
            AND i.dispatch_state = 'reserved'
          ORDER BY i.updated_at, i.planner_turn_id
        `;
        yield* Effect.forEach(
          pendingIntents,
          (intent) => {
            const stored =
              intent.receipt_json === null
                ? undefined
                : (decodeReceipt(intent.receipt_json) as Record<string, unknown>);
            if (stored?.voiceIntake !== undefined) return Effect.void;
            return submitWork({
              principalSessionId: intent.principal_session_id,
              leaseId,
              generation,
              plannerNativeThreadId: intent.planner_native_thread_id,
              plannerTurnId: intent.planner_turn_id,
              callId: intent.call_id,
              message: intent.message,
              ...(intent.planner_turn_id.startsWith("request:")
                ? {
                    requestId: intent.planner_turn_id.slice("request:".length),
                    ...(intent.receipt_json !== null &&
                    typeof (decodeReceipt(intent.receipt_json) as Record<string, unknown>)
                      .requestedProjectId === "string"
                      ? {
                          projectId: (
                            decodeReceipt(intent.receipt_json) as { requestedProjectId: string }
                          ).requestedProjectId,
                        }
                      : {}),
                  }
                : {}),
            }).pipe(Effect.ignore);
          },
          { concurrency: 1, discard: true },
        );
      });
    });

    return CodexLiveSessionService.of({ prepare, start, stop, status, subscribe, context });
  }),
).pipe(
  Layer.provideMerge(CodexLiveEventHub.layer),
  Layer.provide(ConversationWorkCoordinator.layer),
  Layer.provide(ProjectStore.layer),
);
