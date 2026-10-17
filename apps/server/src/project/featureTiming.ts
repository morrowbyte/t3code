import {
  FeatureTimingError,
  FeatureTimingFact,
  type FeatureTimingEvidence,
  type FeatureTimingObservation,
  type FeatureTimingRecord,
  type ProjectFeatureTiming,
  type ProjectFeatureTimingHistory,
  type ProjectId,
  type ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type CommandId,
  type MessageId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import {
  featureAcceptanceText,
  validateFeatureTimingRecords,
  projectFeatureTiming,
} from "@t3tools/shared/featureTiming";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Events from "../persistence/OrchestrationEventStore.ts";

const MAX_PROJECT_EVENTS = 2000;
const MAX_THREAD_EVENTS = 4000;
const TIMING_EVENTS: ReadonlyArray<OrchestrationV2DomainEvent["type"]> = [
  "thread.created",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "message.updated",
];
const isFact = Schema.is(FeatureTimingFact);
const encodeFact = Schema.encodeEffect(Schema.fromJsonString(FeatureTimingFact));
const invalid = () => new FeatureTimingError({ reason: "invalid_history" });
const evidenceError = () => new FeatureTimingError({ reason: "invalid_evidence" });

// This is part of ProjectService: facts use its existing command receipt, lock and event transaction.
export const makeFeatureTiming = Effect.gen(function* () {
  const store = yield* Events.OrchestrationEventStore;
  const read = Effect.fn("ProjectService.featureTiming")(function* (projectId: ProjectId) {
    const throughSequence = yield* store.latestApplicationSequence;
    const asOf = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* store
      .readProjectEvents({ projectId, throughSequence, limit: MAX_PROJECT_EVENTS + 1 })
      .pipe(Stream.runCollect);
    const empty = (
      coverage: ProjectFeatureTimingHistory["coverage"],
    ): ProjectFeatureTimingHistory => ({
      projectId,
      asOf,
      coverage,
      records: [],
      observations: [],
    });
    if (rows.length > MAX_PROJECT_EVENTS) return empty("incomplete");
    const records: FeatureTimingRecord[] = rows.flatMap((row) =>
      row.type === "project.meta-updated" && row.payload.featureTiming
        ? [{ sequence: row.sequence, at: row.occurredAt, fact: row.payload.featureTiming }]
        : [],
    );
    if (!records.length) return empty("no_feature_history");
    if (!validateFeatureTimingRecords(records)) return yield* invalid();
    const threadIds = new Set<ThreadId>();
    for (const { fact } of records) {
      if (fact.type === "registered") {
        for (const id of fact.threadIds) threadIds.add(id);
        if (fact.intake) threadIds.add(fact.intake.threadId);
      }
      if (fact.type === "thread_linked") threadIds.add(fact.threadId);
      if (fact.type === "target_accepted") threadIds.add(fact.evidence.threadId);
    }
    if (threadIds.size > 128) return empty("incomplete");
    const evidenceByThread = new Map<ThreadId, MessageId[]>();
    for (const { fact } of records) {
      const ref =
        fact.type === "registered"
          ? fact.intake
          : fact.type === "target_accepted"
            ? fact.evidence
            : null;
      if (ref)
        evidenceByThread.set(ref.threadId, [
          ...(evidenceByThread.get(ref.threadId) ?? []),
          ref.messageId,
        ]);
    }
    const observations: FeatureTimingObservation[] = [];
    const messages = new Map<string, OrchestrationV2ConversationMessage>();
    for (const threadId of threadIds) {
      const events = yield* store
        .readAgentEvents({
          threadId,
          throughSequence,
          limit: MAX_THREAD_EVENTS + 1,
          eventTypes: TIMING_EVENTS,
          messageIds: evidenceByThread.get(threadId) ?? [],
        })
        .pipe(Stream.runCollect);
      if (
        events.length > MAX_THREAD_EVENTS ||
        !events.some(
          (row) => row.event.type === "thread.created" && row.event.payload.projectId === projectId,
        )
      )
        return empty("incomplete");
      const runs = new Map<string, OrchestrationV2Run>();
      const requests = new Map<string, OrchestrationV2RuntimeRequest>();
      for (const { event } of events) {
        if (event.type === "run.created" || event.type === "run.updated")
          runs.set(event.payload.id, event.payload);
        if (event.type === "runtime-request.updated") requests.set(event.payload.id, event.payload);
        if (event.type === "message.updated" && !messages.has(`${threadId}:${event.payload.id}`))
          messages.set(`${threadId}:${event.payload.id}`, event.payload);
      }
      observations.push({
        threadId,
        runs: [...runs.values()].map((run) => ({
          id: run.id,
          requestedAt: DateTime.formatIso(run.requestedAt),
          startedAt:
            run.workStartedAt !== undefined
              ? DateTime.formatIso(run.workStartedAt)
              : run.startedAt === null
                ? null
                : DateTime.formatIso(run.startedAt),
          end: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
          status: run.status,
        })),
        waits: [...requests.values()].flatMap((request) => {
          if (
            request.kind === "dynamic_tool_call" ||
            (request.resolvedAt === null && request.status !== "pending")
          )
            return [];
          return [
            {
              id: request.id,
              start: DateTime.formatIso(request.createdAt),
              end: request.resolvedAt === null ? null : DateTime.formatIso(request.resolvedAt),
              reason: request.kind === "auth_refresh" ? "credential" : "user",
            },
          ];
        }),
      });
    }
    const enriched: FeatureTimingRecord[] = [];
    const reopenedAt = new Map<string, number>();
    for (const record of records) {
      const fact = record.fact;
      if (fact.type === "target_reopened")
        reopenedAt.set(`${fact.featureId}:${fact.targetId}`, Date.parse(record.at));
      const ref =
        fact.type === "registered"
          ? fact.intake
          : fact.type === "target_accepted"
            ? fact.evidence
            : null;
      if (!ref) {
        enriched.push(record);
        continue;
      }
      const message = messages.get(`${ref.threadId}:${ref.messageId}`);
      if (
        !message ||
        message.role !== "user" ||
        message.createdBy !== "user" ||
        !["web", "mobile", "voice"].includes(message.creationSource) ||
        message.senderThreadId ||
        message.scheduledTaskId ||
        DateTime.toEpochMillis(message.createdAt) > Date.parse(record.at) ||
        (fact.type === "target_accepted" && message.text.trim() !== featureAcceptanceText(fact))
      )
        return yield* evidenceError();
      if (fact.type === "target_accepted") {
        const reopened = reopenedAt.get(`${fact.featureId}:${fact.targetId}`);
        const intake = enriched.find(
          (r) => r.fact.featureId === fact.featureId && r.fact.type === "registered",
        )?.userEvidence;
        const acceptedAt = DateTime.toEpochMillis(message.createdAt);
        if (
          (reopened !== undefined && acceptedAt <= reopened) ||
          (intake && acceptedAt < Date.parse(intake.at))
        )
          return yield* evidenceError();
      }
      enriched.push({
        ...record,
        userEvidence: {
          actor: "user",
          at: DateTime.formatIso(message.createdAt),
          source: message.creationSource,
        },
      });
    }
    return { projectId, asOf, coverage: "complete" as const, records: enriched, observations };
  });
  const validate = Effect.fn("ProjectService.validateFeatureTiming")(function* (
    projectId: ProjectId,
    commandId: CommandId,
    fact: FeatureTimingFact,
  ) {
    if (!isFact(fact)) return yield* invalid();
    const throughSequence = yield* store.latestApplicationSequence;
    const prior = yield* store
      .readProjectEvents({ projectId, throughSequence, limit: MAX_PROJECT_EVENTS + 1 })
      .pipe(Stream.runCollect);
    if (prior.length > MAX_PROJECT_EVENTS) return yield* invalid();
    const retried = prior.find((row) => row.commandId === commandId);
    if (retried) {
      if (
        retried.type === "project.meta-updated" &&
        retried.payload.featureTiming !== undefined &&
        (yield* encodeFact(retried.payload.featureTiming)) === (yield* encodeFact(fact))
      )
        return;
      return yield* invalid();
    }
    const feed = yield* read(projectId);
    if (feed.coverage === "incomplete") return yield* invalid();
    const at = DateTime.formatIso(yield* DateTime.now);
    const candidate: FeatureTimingRecord = { sequence: throughSequence + 1, at, fact };
    if (!validateFeatureTimingRecords([...feed.records, candidate])) return yield* invalid();
    const checkThread = Effect.fnUntraced(function* (
      threadId: ThreadId,
      messageIds: readonly MessageId[] = [],
    ) {
      const events = yield* store
        .readAgentEvents({
          threadId,
          throughSequence,
          limit: MAX_THREAD_EVENTS + 1,
          eventTypes: TIMING_EVENTS,
          messageIds,
        })
        .pipe(Stream.runCollect);
      if (
        events.length > MAX_THREAD_EVENTS ||
        !events.some(
          (row) => row.event.type === "thread.created" && row.event.payload.projectId === projectId,
        )
      )
        return yield* evidenceError();
      return events;
    });
    if (fact.type === "registered" || fact.type === "thread_linked") {
      for (const threadId of fact.type === "registered" ? fact.threadIds : [fact.threadId]) {
        const events = yield* checkThread(threadId);
        if (
          fact.type === "registered" &&
          fact.originalEstimate &&
          events.some(
            (row) =>
              (row.event.type === "run.created" || row.event.type === "run.updated") &&
              (row.event.payload.workStartedAt !== undefined ||
                row.event.payload.startedAt !== null),
          )
        )
          return yield* invalid();
      }
    }
    const ref: FeatureTimingEvidence | null =
      fact.type === "registered"
        ? fact.intake
        : fact.type === "target_accepted"
          ? fact.evidence
          : null;
    if (ref) {
      const events = yield* checkThread(ref.threadId, [ref.messageId]);
      const message = events.find(
        (row) => row.event.type === "message.updated" && row.event.payload.id === ref.messageId,
      )?.event;
      if (
        message?.type !== "message.updated" ||
        message.payload.role !== "user" ||
        message.payload.createdBy !== "user" ||
        !["web", "mobile", "voice"].includes(message.payload.creationSource) ||
        message.payload.senderThreadId ||
        message.payload.scheduledTaskId ||
        DateTime.toEpochMillis(message.payload.createdAt) > Date.parse(at) ||
        (fact.type === "target_accepted" &&
          message.payload.text.trim() !== featureAcceptanceText(fact))
      )
        return yield* evidenceError();
      if (fact.type === "target_accepted") {
        const intake = feed.records.find(
          (r) => r.fact.featureId === fact.featureId && r.fact.type === "registered",
        )?.userEvidence;
        if (intake && DateTime.toEpochMillis(message.payload.createdAt) < Date.parse(intake.at))
          return yield* evidenceError();
        const reopen = feed.records.findLast(
          (r) =>
            r.fact.featureId === fact.featureId &&
            r.fact.type === "target_reopened" &&
            r.fact.targetId === fact.targetId,
        );
        if (reopen && DateTime.toEpochMillis(message.payload.createdAt) <= Date.parse(reopen.at))
          return yield* evidenceError();
      }
    }
  });
  const readSummary = Effect.fn("ProjectService.featureTimingSummary")(function* (
    projectId: ProjectId,
  ) {
    const feed = yield* read(projectId);
    return {
      projectId: feed.projectId,
      asOf: feed.asOf,
      coverage: feed.coverage,
      features: projectFeatureTiming(feed).map(
        ({ records, threadIds: _threadIds, ...feature }) => ({
          ...feature,
          records: records.map((record) => ({
            sequence: record.sequence,
            at: record.at,
            type: record.fact.type,
            reason: record.fact.type === "target_reopened" ? record.fact.reason : null,
          })),
        }),
      ),
    } satisfies ProjectFeatureTiming;
  });
  return {
    read: (projectId: ProjectId) =>
      readSummary(projectId).pipe(
        Effect.catch(() =>
          DateTime.now.pipe(
            Effect.map((now) => ({
              projectId,
              asOf: DateTime.formatIso(now),
              coverage: "unavailable" as const,
              features: [],
            })),
          ),
        ),
      ),
    validate,
  };
});
