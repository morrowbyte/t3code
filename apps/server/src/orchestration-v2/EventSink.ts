import type {
  AgentObservatoryCommit,
  AgentObservatoryCommitResult,
} from "../observatory/AgentObservatoryPorts.ts";
import {
  AgentObservatoryPrincipal,
  AgentObservatoryRefusal,
} from "../observatory/AgentObservatoryPorts.ts";
import {
  AgentObservatoryOwner,
  AgentObservatoryUpdate,
  AgentObservatorySnapshot,
  AgentObservatoryMetadata,
  EventId,
  MessageId,
  CommandId,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";
import { makeRunOutcomeRecorder, type RunOutcome } from "./RunMetrics.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

export interface EventSinkV2Shape {
  /** Internal host-attested call only; no RPC/tool decoder may provide principal. */
  readonly commitObservatoryUpdate: (
    input: AgentObservatoryCommit,
  ) => Effect.Effect<
    AgentObservatoryCommitResult,
    EventSinkV2Error | AgentObservatoryRefusal,
    Crypto.Crypto
  >;
  readonly write: (input: {
    readonly updateToolTitleOnly?: { readonly expectedTitle: string | null };
    /** Return no events if another thread owns this native session at commit time. */
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly updateToolTitleOnly?: { readonly expectedTitle: string | null };
    /**
     * Rebuilds each run.updated from the stored row with only its delegatedCompletion replaced.
     * The batch must not also change that run's lifecycle.
     */
    readonly updateDelegatedCompletionOnly?: boolean;
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only when the provider thread is still owned by the
   * expected run attempt and ordinal. Used for late post-terminal
   * provider_thread updates so a completed or superseded attempt cannot clobber
   * a newer attempt that already claimed the thread.
   */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only while the stored provider thread still equals
   * `expected`, the row its writer read, so a read-modify-write of the row
   * cannot overwrite an update published in between. The whole row is
   * compared because not every writer moves `updatedAt`.
   */
  readonly writeIfProviderThreadUnchanged: (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const runOutcomes = makeRunOutcomeRecorder((threadId) =>
      // One payload row; unlike the shell, it still resolves a deleted child thread.
      projectionStore
        .getThread(threadId)
        .pipe(Effect.map((thread) => thread.lineage.relationshipToParent === "subagent")),
    );
    // Recorded before publication, so an interrupted publish cannot lose a committed outcome.
    const publishStoredEvents = (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
      outcomes: ReadonlyArray<RunOutcome>,
    ) =>
      runOutcomes
        .record(outcomes)
        .pipe(
          Effect.andThen(eventStore.publishCommitted(events)),
          Effect.andThen(publishLiveEvents(events)),
        );

    // Transactions commit one at a time, but each writer publishes after its
    // commit. If a writer is descheduled in between, a later commit reaches
    // subscribers first, and clients drop any event at or below the newest
    // sequence they have applied.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.suspend(() => {
        let holdsLane = false;
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        return sql
          .withTransaction(Effect.tap(transaction, () => takeLane))
          .pipe(
            Effect.tap(publish),
            Effect.ensuring(
              Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
            ),
          );
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const conversationResults = new Map(
        events.flatMap((event) =>
          event.type === "message.updated" &&
          event.payload.role === "assistant" &&
          event.payload.createdBy === "system" &&
          event.payload.creationSource === "server" &&
          event.payload.runId === null &&
          event.payload.senderThreadId !== undefined
            ? [[event.payload.id, event.threadId] as const]
            : [],
        ),
      );
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null
                    ? event.payload.type === "assistant_message" &&
                      event.payload.id.startsWith("turn-item:conversation-result:") &&
                      conversationResults.get(event.payload.messageId) === event.threadId
                      ? // Ownership stays with the child; only placement follows the
                        // proposed parent tail rather than the historical runless bucket.
                        Math.floor(event.payload.ordinal / 1_000_000)
                      : undefined
                    : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
        // Read lineage here, on the connection this transaction holds; see makeRunOutcomeRecorder.
        return yield* runOutcomes.prepare(storedEvents);
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const { committed } = yield* commitThenPublish(
        Effect.gen(function* () {
          // Check ownership in the same transaction that claims the native session.
          const imported = input.unlessNativeThreadOwned;
          if (imported?.nativeThreadRef != null) {
            const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
            if (owners.length > 0) return { committed: [], outcomes: [] };
          }
          // Checkpoint capture can finish after a cohort writer reads its parent run.
          // Merge in this transaction so the event log and projection keep that completion.
          let events = input.updateDelegatedCompletionOnly
            ? yield* Effect.forEach(input.events, (event) =>
                Effect.gen(function* () {
                  if (event.type !== "run.updated") return event;
                  const { runs } = yield* projectionStore.getThreadRecords(
                    event.threadId,
                    ["runs"],
                    { runIds: [event.payload.id] },
                  );
                  const current = runs[0];
                  return current === undefined
                    ? event
                    : {
                        ...event,
                        payload: {
                          ...current,
                          delegatedCompletion: event.payload.delegatedCompletion,
                        },
                      };
                }),
              )
            : input.events;
          if (input.updateToolTitleOnly) {
            const expectedTitle = input.updateToolTitleOnly.expectedTitle;
            const updates = yield* Effect.forEach(events, (event) =>
              Effect.gen(function* () {
                if (event.type !== "turn-item.updated") return [];
                const current = yield* projectionStore.getTurnItem({
                  threadId: event.threadId,
                  itemId: event.payload.id,
                });
                if (
                  !current ||
                  current.title !== expectedTitle ||
                  current.runId !== event.payload.runId
                )
                  return [];
                // Only the title crosses this async boundary; lifecycle and output come from this transaction.
                return [{ ...event, payload: { ...current, title: event.payload.title } }];
              }),
            );
            events = updates.flat();
          }
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(events)
              : events,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return { committed, outcomes };
        }).pipe(Effect.withTracerEnabled(false)),
        ({ committed, outcomes }) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(committed, outcomes);
          }),
      );
      return committed;
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(input.events)
                : input.events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            const outcomes = yield* applyStoredEvents(storedEvents);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents, outcomes };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents, result.outcomes);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const commitObservatoryUpdate = Effect.fn("EventSink.commitObservatoryUpdate")(
      (submitted: AgentObservatoryCommit) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const codec = Schema.fromJsonString(
            Schema.Struct({
              owner: AgentObservatoryOwner,
              principal: AgentObservatoryPrincipal,
              update: AgentObservatoryUpdate,
            }),
          );
          const canonical = yield* Schema.encodeEffect(codec)(submitted);
          const input = yield* Schema.decodeUnknownEffect(codec)(canonical);
          const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(canonical));
          const identity = `observatory.update:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          const result = yield* commitThenPublish(
            Effect.gen(function* () {
              const existing = yield* commandReceipts.getByCommandId(input.update.requestId);
              if (Option.isSome(existing)) {
                if (
                  existing.value.threadId !== input.owner.threadId ||
                  existing.value.commandType !== identity
                )
                  return {
                    status: "refused" as const,
                    reason: "request_conflict" as const,
                    events: [],
                  };
                if (existing.value.status === "rejected") {
                  const reason = existing.value.error;
                  return {
                    status: "refused" as const,
                    reason:
                      reason === "stale_owner" || reason === "revision_conflict"
                        ? reason
                        : ("request_conflict" as const),
                    events: [],
                  };
                }
                const events = yield* eventStore
                  .readByCommandId({ commandId: input.update.requestId })
                  .pipe(Stream.runCollect);
                const stored = events.find(
                  (stored) =>
                    stored.event.type === "message.updated" &&
                    stored.event.payload.observatory !== undefined,
                );
                if (stored?.event.type !== "message.updated" || !stored.event.payload.observatory)
                  return { status: "refused" as const, reason: "unavailable" as const, events: [] };
                return {
                  status: "accepted" as const,
                  snapshot: { ...stored.event.payload.observatory, sequence: stored.sequence },
                  replayed: true,
                  events: [],
                };
              }
              const now = yield* DateTime.now;
              const refuse = Effect.fn("EventSink.refuse")(
                (reason: "stale_owner" | "revision_conflict") =>
                  Effect.gen(function* () {
                    const inserted = yield* commandReceipts.insertIfAbsent({
                      commandId: input.update.requestId,
                      threadId: input.owner.threadId,
                      commandType: identity,
                      acceptedAt: now,
                      resultSequence: yield* eventStore.latestSequence({
                        threadId: input.owner.threadId,
                      }),
                      status: "rejected",
                      error: reason,
                    });
                    return {
                      status: "refused" as const,
                      reason: inserted ? reason : ("request_conflict" as const),
                      events: [],
                    };
                  }),
              );
              const thread = yield* projectionStore.getThread(input.owner.threadId);
              const current = yield* projectionStore.getRunningTurnContext(input.owner.threadId);
              const owner = input.owner;
              const run = current.run;
              const control = yield* projectionStore.getProviderControlContext(owner.threadId, {
                providerThreadId: owner.providerThreadId,
                providerTurnId: owner.providerTurnId,
                attemptId: owner.attemptId,
              });
              const attempt = control.attempt;
              const providerThread = control.providerThread;
              const turn = control.providerTurn;
              const newer = run
                ? yield* sql<{
                    readonly present: number;
                  }>`SELECT 1 AS present FROM orchestration_v2_projection_runs
              WHERE thread_id = ${owner.threadId} AND ordinal > ${run.ordinal} AND status <> 'queued' LIMIT 1`
                : [];
              if (
                newer.length > 0 ||
                thread.archivedAt !== null ||
                thread.deletedAt !== null ||
                thread.providerInstanceId !== owner.providerInstanceId ||
                !run ||
                run.id !== owner.runId ||
                run.activeAttemptId !== owner.attemptId ||
                run.rootNodeId !== owner.rootNodeId ||
                run.providerInstanceId !== owner.providerInstanceId ||
                run.providerThreadId !== owner.providerThreadId ||
                !attempt ||
                attempt.runId !== run.id ||
                attempt.status !== "running" ||
                attempt.rootNodeId !== owner.rootNodeId ||
                attempt.providerInstanceId !== owner.providerInstanceId ||
                attempt.providerThreadId !== owner.providerThreadId ||
                attempt.providerTurnId !== owner.providerTurnId ||
                !providerThread ||
                providerThread.appThreadId !== owner.threadId ||
                providerThread.providerInstanceId !== owner.providerInstanceId ||
                providerThread.ownerNodeId !== null ||
                providerThread.status !== "active" ||
                providerThread.providerSessionId !== input.principal.providerSessionId ||
                providerThread.nativeThreadRef?.strength !== "strong" ||
                providerThread.nativeThreadRef.driver !== providerThread.driver ||
                providerThread.nativeThreadRef.nativeId !== input.principal.nativeThreadId ||
                !turn ||
                turn.status !== "running" ||
                turn.runAttemptId !== owner.attemptId ||
                turn.nodeId !== owner.rootNodeId ||
                turn.providerThreadId !== owner.providerThreadId ||
                turn.nativeTurnRef?.strength !== "strong" ||
                turn.nativeTurnRef.driver !== providerThread.driver ||
                turn.nativeTurnRef.nativeId !== input.principal.nativeTurnId
              )
                return yield* refuse("stale_owner");
              const messageId = MessageId.make(`message:observatory:${owner.threadId}`);
              const records = yield* projectionStore.getThreadRecords(
                owner.threadId,
                ["messages"],
                {
                  messageIds: [messageId],
                },
              );
              const previous = records.messages[0];
              if (
                (previous && !previous.observatory) ||
                (previous?.observatory?.revision ?? 0) !== input.update.expectedRevision
              )
                return yield* refuse("revision_conflict");
              const metadata: AgentObservatoryMetadata = {
                owner,
                requestId: input.update.requestId,
                revision: input.update.expectedRevision + 1,
                provenance: "agent-authored",
                eventId: EventId.make(`event:observatory:${input.update.requestId}`),
                recordedAt: now,
                nativeFrontier: {
                  source: "observed-native",
                  sequence: yield* eventStore.latestSequence({ threadId: owner.threadId }),
                  rawEventId: null,
                },
                state: input.update.state,
              };
              const event: OrchestrationV2DomainEvent = {
                id: metadata.eventId,
                type: "message.updated",
                threadId: owner.threadId,
                occurredAt: now,
                payload: {
                  createdBy: "agent",
                  creationSource: "provider",
                  id: messageId,
                  threadId: owner.threadId,
                  runId: owner.runId,
                  nodeId: owner.rootNodeId,
                  role: "system",
                  text: "",
                  attachments: [],
                  streaming: false,
                  createdAt: previous?.createdAt ?? now,
                  updatedAt: now,
                  observatory: metadata,
                },
              };
              const events = yield* eventStore.append({
                commandId: input.update.requestId,
                events: [event],
              });
              const stored = events[0];
              if (!stored) return yield* Effect.die("Observatory append produced no event.");
              const outcomes = yield* applyStoredEvents(events);
              const inserted = yield* commandReceipts.insertIfAbsent({
                commandId: input.update.requestId,
                threadId: owner.threadId,
                commandType: identity,
                acceptedAt: now,
                resultSequence: stored.sequence,
                status: "accepted",
                error: null,
              });
              if (!inserted)
                return yield* new AgentObservatoryRefusal({ reason: "request_conflict" });
              return {
                status: "accepted" as const,
                snapshot: { ...metadata, sequence: stored.sequence },
                replayed: false,
                events,
                outcomes,
              };
            }),
            (result) =>
              publishStoredEvents(result.events, "outcomes" in result ? result.outcomes : []),
          );
          if (result.status === "refused")
            return yield* new AgentObservatoryRefusal({ reason: result.reason });
          return {
            replayed: result.replayed,
            snapshot: yield* Schema.decodeUnknownEffect(AgentObservatorySnapshot)(result.snapshot),
          };
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(AgentObservatoryRefusal)(cause)
              ? cause
              : new EventSinkWriteError({
                  eventCount: 1,
                  commandId: submitted.update.requestId,
                  cause,
                }),
          ),
        ),
    );

    const writeIfProviderThreadUnchangedEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.expected.id,
      });
      const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${input.expected.id}
            LIMIT 1
          `;
          if (rows[0]?.payload_json !== expectedJson) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({ events: normalized });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const existingCommandResult =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (commandId: CommandId) {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          // A Stop that changes nothing can still queue the stop of its delegated tasks.
          const sequence =
            storedEvents.at(-1)?.sequence ??
            (input.effects.length === 0
              ? undefined
              : yield* eventStore.latestSequence({ threadId: input.threadId }));
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          const outcomes = yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, outcomes, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents, result.outcomes);
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      commitObservatoryUpdate,
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadUnchanged: (input) =>
        writeIfProviderThreadUnchangedEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Keeping the outbox instance shared with the worker is important because enqueue notifications
 * are in-memory wakeups backed by the durable SQL queue.
 */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
