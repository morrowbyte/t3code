import type {
  LiveVoiceDiagnosticRecord,
  LiveVoiceDiagnostics,
  LiveVoiceDiagnosticEvent,
  EnvironmentId,
  LiveVoiceCallHistory,
  LiveVoiceCallTranscript,
  LiveVoiceEvent,
  LiveVoiceSession,
  LiveVoiceStatus,
  ThreadId,
} from "@t3tools/contracts";
import { LiveVoiceEvent as LiveVoiceEventSchema } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { replayLiveVoiceTranscript } from "./liveVoiceHistoryReplay.ts";

export class LiveVoiceHistoryError extends Schema.TaggedError<LiveVoiceHistoryError>()(
  "LiveVoiceHistoryError",
  {
    reason: Schema.Literals(["not_found", "storage"]),
  },
) {}

type ThreadTarget = { environmentId: EnvironmentId; threadId: ThreadId };
type CallTarget = ThreadTarget & { leaseId: string; generation: number };
type DiagnosticTarget = ThreadTarget & {
  leaseId?: string;
  generation?: number;
  after?: number;
  limit?: number;
};
const DIAGNOSTIC_CAPACITY = 5_000;
const DIAGNOSTIC_RETENTION_HOURS = 24;
const diagnosticKeys = new Set([
  "role",
  "segmentId",
  "revision",
  "final",
  "kind",
  "partIndex",
  "partCount",
  "textLength",
  "status",
  "requestId",
  "version",
  "snapshotVersion",
  "actionIndex",
  "actionType",
  "actionCount",
  "code",
  "attempt",
  "sourceCount",
  "sourceIds",
  "stopId",
  "intentId",
  "taskId",
  "targetThreadId",
  "runId",
  "projectId",
  "dispatchMode",
  "deliveryId",
  "messageId",
  "paragraphId",
  "stage",
  "outcome",
  "accepted",
  "channel",
  "reason",
  "bytes",
  "frameCount",
  "providerInstanceId",
  "providerSessionId",
  "plannerNativeThreadId",
  "providerDriver",
  "model",
  "reasoningEffort",
  "serviceTier",
  "serverVersion",
  "sourceRevision",
  "dirtySourceDigest",
  "nativeRuntimeVersion",
  "nativeUserAgent",
  "conversationPromptSha256",
  "intakePromptSha256",
  "nativeModel",
  "nativeReasoningEffort",
  "nativeServiceTier",
  "clientPhase",
  "playbackEligible",
  "playbackMuted",
  "connectionState",
  "dataChannelState",
  "durationMs",
  "failureClass",
]);

export class LiveVoiceHistory extends Context.Service<
  LiveVoiceHistory,
  {
    readonly record: (session: LiveVoiceSession, event: LiveVoiceEvent) => Effect.Effect<void>;
    readonly recordDiagnostic: (
      session: LiveVoiceSession,
      event: LiveVoiceDiagnosticRecord,
    ) => Effect.Effect<void>;
    readonly diagnosticsSettings: Effect.Effect<
      { diagnosticsEnabled: boolean },
      LiveVoiceHistoryError
    >;
    readonly setDiagnosticsEnabled: (
      enabled: boolean,
    ) => Effect.Effect<void, LiveVoiceHistoryError>;
    readonly diagnostics: (
      target: DiagnosticTarget,
    ) => Effect.Effect<LiveVoiceDiagnostics, LiveVoiceHistoryError>;
    readonly list: (
      target: ThreadTarget & { before?: number },
    ) => Effect.Effect<LiveVoiceCallHistory, LiveVoiceHistoryError>;
    readonly transcript: (
      target: CallTarget,
    ) => Effect.Effect<LiveVoiceCallTranscript, LiveVoiceHistoryError>;
  }
>()("t3/voice/LiveVoiceHistory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const persistenceAvailable = yield* Ref.make(true);
  const eventJson = Schema.fromJsonString(LiveVoiceEventSchema);
  const diagnosticJson = Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      sourceClock: Schema.Literals(["server-receipt", "client-monotonic"]),
      sourceTimestamp: Schema.NullOr(Schema.Number),
      details: Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
      ),
    }),
  );
  const ensureThread = Effect.fn("LiveVoiceHistory.ensureThread")(function* (target: ThreadTarget) {
    const rows = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${target.threadId} AND deleted_at IS NULL`;
    if (rows.length === 0) return yield* new LiveVoiceHistoryError({ reason: "not_found" });
  });
  const storageError = () => new LiveVoiceHistoryError({ reason: "storage" });
  let cachedEnabled = false;
  let settingsReadAt = Number.NEGATIVE_INFINITY;
  const loadDiagnosticsEnabled = Effect.gen(function* () {
    const rows = yield* sql<{
      enabled: number;
    }>`SELECT enabled FROM codex_live_voice_diagnostics_settings WHERE id = 1`;
    cachedEnabled = rows[0]?.enabled === 1;
    settingsReadAt = DateTime.toEpochMillis(yield* DateTime.now);
    return cachedEnabled;
  });
  const readDiagnosticsEnabled = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return now - settingsReadAt >= 1_000 ? yield* loadDiagnosticsEnabled : cachedEnabled;
  });
  const diagnosticsSettings = loadDiagnosticsEnabled.pipe(
    Effect.map((diagnosticsEnabled) => ({ diagnosticsEnabled })),
    Effect.mapError(storageError),
  );
  const setDiagnosticsEnabled = Effect.fn("LiveVoiceHistory.setDiagnosticsEnabled")(function* (
    enabled: boolean,
  ) {
    yield* sql`UPDATE codex_live_voice_diagnostics_settings SET enabled = ${enabled ? 1 : 0} WHERE id = 1`;
    cachedEnabled = enabled;
    settingsReadAt = DateTime.toEpochMillis(yield* DateTime.now);
  }, Effect.mapError(storageError));
  const pruneDiagnostics = Effect.gen(function* () {
    const cutoff = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { hours: DIAGNOSTIC_RETENTION_HOURS }),
    );
    yield* sql`DELETE FROM codex_live_voice_diagnostics WHERE recorded_at < ${cutoff}
      OR sequence <= (SELECT COALESCE(MAX(sequence), 0) - ${DIAGNOSTIC_CAPACITY} FROM codex_live_voice_diagnostics)`;
  });
  // Diagnostic metadata is per event; existing call spans own tracing.
  const recordDiagnostic = Effect.fnUntraced(
    function* (session: LiveVoiceSession, event: LiveVoiceDiagnosticRecord) {
      if (!(yield* readDiagnosticsEnabled)) return;
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const details = Object.fromEntries(
        Object.entries(event.details)
          .filter(
            ([key, value]) =>
              diagnosticKeys.has(key) &&
              (value === null ||
                typeof value === "boolean" ||
                (typeof value === "number" && Number.isFinite(value)) ||
                typeof value === "string"),
          )
          .slice(0, 32)
          .map(([key, value]) => [
            key,
            typeof value === "string" ? value.slice(0, key === "sourceIds" ? 2_048 : 256) : value,
          ]),
      );
      const json = yield* Schema.encodeEffect(diagnosticJson)({
        name: event.name.slice(0, 80),
        sourceClock: event.sourceClock ?? "server-receipt",
        sourceTimestamp: event.sourceTimestamp ?? null,
        details,
      });
      yield* sql`INSERT INTO codex_live_voice_diagnostics
      (environment_id, thread_id, lease_id, generation, recorded_at, event_json)
      SELECT ${session.environmentId}, ${session.threadId}, ${session.leaseId}, ${session.generation}, ${recordedAt}, ${json}
      WHERE (SELECT enabled FROM codex_live_voice_diagnostics_settings WHERE id = 1) = 1`;
      yield* pruneDiagnostics;
    },
    Effect.catch(() => Ref.set(persistenceAvailable, false)),
  );
  const diagnostics = Effect.fn("LiveVoiceHistory.diagnostics")(
    function* (target: DiagnosticTarget) {
      yield* ensureThread(target);
      yield* pruneDiagnostics;
      const limit = Math.max(1, Math.min(500, Math.floor(target.limit ?? 200)));
      const rows = yield* sql<{
        sequence: number;
        recorded_at: string;
        environment_id: string;
        thread_id: string;
        lease_id: string;
        generation: number;
        event_json: string;
      }>`
      SELECT * FROM codex_live_voice_diagnostics
      WHERE environment_id = ${target.environmentId} AND thread_id = ${target.threadId}
        AND (${target.leaseId ?? null} IS NULL OR lease_id = ${target.leaseId ?? null})
        AND (${target.generation ?? null} IS NULL OR generation = ${target.generation ?? null})
        AND sequence > ${target.after ?? 0}
      ORDER BY sequence LIMIT ${limit + 1}`;
      const events = yield* Effect.forEach(rows.slice(0, limit), (row) =>
        Schema.decodeEffect(diagnosticJson)(row.event_json).pipe(
          Effect.map((event): LiveVoiceDiagnosticEvent => ({
            ...event,
            sequence: row.sequence,
            recordedAt: row.recorded_at,
            environmentId: target.environmentId,
            threadId: target.threadId,
            leaseId: row.lease_id,
            generation: row.generation,
          })),
        ),
      );
      return {
        enabled: yield* loadDiagnosticsEnabled,
        retentionHours: DIAGNOSTIC_RETENTION_HOURS,
        capacity: DIAGNOSTIC_CAPACITY,
        events,
        nextAfter: events.at(-1)?.sequence ?? target.after ?? null,
        truncated: rows.length > limit,
        persistenceAvailable: yield* Ref.get(persistenceAvailable),
        capabilities: {
          nativeVad: false,
          actualPlayout: false,
          nativeCancel: false,
          modelContextConsumption: false,
        },
      };
    },
    Effect.mapError((error) => (error._tag === "LiveVoiceHistoryError" ? error : storageError())),
  );
  // Speech arrives per fragment; the call already owns the tracing boundary.
  const record = Effect.fnUntraced(
    function* (session: LiveVoiceSession, event: LiveVoiceEvent) {
      if (event.type !== "status" && event.type !== "transcript") return;
      const identity = event.type === "status" ? event.session : event;
      if (identity.leaseId !== session.leaseId || identity.generation !== session.generation)
        return;
      yield* recordDiagnostic(
        session,
        event.type === "transcript"
          ? {
              name: "transcript.received",
              details: {
                role: event.role,
                textLength: event.text.length,
                ...event.segment,
                segmentId: event.segment?.id ?? null,
              },
            }
          : {
              name: "call.status",
              details: {
                status: event.session.status,
                providerInstanceId: session.providerInstanceId,
                providerSessionId: session.providerSessionId,
                plannerNativeThreadId: session.plannerNativeThreadId,
              },
            },
      );
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const eventText = yield* Schema.encodeEffect(eventJson)(event);
      yield* sql`INSERT INTO codex_live_voice_history_events
      (environment_id, thread_id, lease_id, generation, recorded_at, event_type, status, event_json)
      VALUES (${session.environmentId}, ${session.threadId}, ${session.leaseId}, ${session.generation},
        ${recordedAt}, ${event.type}, ${event.type === "status" ? event.session.status : null}, ${eventText})`;
    },
    Effect.catch(() =>
      Ref.getAndSet(persistenceAvailable, false).pipe(
        Effect.flatMap((wasAvailable) =>
          wasAvailable
            ? Effect.logWarning(
                "Live voice history could not persist an event; history may be incomplete.",
              )
            : Effect.void,
        ),
      ),
    ),
  );

  const list = Effect.fn("LiveVoiceHistory.list")(
    function* (target: ThreadTarget & { before?: number }) {
      yield* ensureThread(target);
      const before = target.before ?? Number.MAX_SAFE_INTEGER;
      const rows = yield* sql<{
        lease_id: string;
        generation: number;
        first_id: number;
        last_id: number;
        started_at: string;
        active_at: string | null;
        ended_at: string | null;
        updated_at: string;
        status: LiveVoiceStatus;
      }>`SELECT e.lease_id, e.generation, MIN(e.event_id) AS first_id, MAX(e.event_id) AS last_id,
      MIN(e.recorded_at) AS started_at, MAX(e.recorded_at) AS updated_at,
      MIN(CASE WHEN e.status = 'active' THEN e.recorded_at END) AS active_at,
      MIN(CASE WHEN e.status IN ('closed', 'failed') THEN e.recorded_at END) AS ended_at,
      (SELECT s.status FROM codex_live_voice_history_events s
        WHERE s.environment_id = e.environment_id AND s.thread_id = e.thread_id
          AND s.lease_id = e.lease_id AND s.generation = e.generation AND s.event_type = 'status'
        ORDER BY s.event_id DESC LIMIT 1) AS status
      FROM codex_live_voice_history_events e
      WHERE e.environment_id = ${target.environmentId} AND e.thread_id = ${target.threadId}
      GROUP BY e.lease_id, e.generation
      HAVING MIN(e.event_id) < ${before}
      ORDER BY first_id DESC LIMIT 21`;
      const calls = rows.slice(0, 20).map((row) => ({
        leaseId: row.lease_id,
        generation: row.generation,
        threadId: target.threadId,
        firstEventId: row.first_id,
        lastEventId: row.last_id,
        startedAt: row.started_at,
        activeAt: row.active_at,
        endedAt: row.ended_at,
        updatedAt: row.updated_at,
        status: row.status ?? "unknown",
      }));
      return {
        calls,
        nextBefore: rows.length > 20 ? String(calls.at(-1)!.firstEventId) : null,
        persistenceAvailable: yield* Ref.get(persistenceAvailable),
      };
    },
    Effect.mapError((error) => (error._tag === "LiveVoiceHistoryError" ? error : storageError())),
  );

  const transcript = Effect.fn("LiveVoiceHistory.transcript")(
    function* (target: CallTarget) {
      yield* ensureThread(target);
      const rows = yield* sql<{ event_id: number; recorded_at: string; event_json: string }>`
      SELECT event_id, recorded_at, event_json FROM codex_live_voice_history_events
      WHERE environment_id = ${target.environmentId} AND thread_id = ${target.threadId}
        AND lease_id = ${target.leaseId} AND generation = ${target.generation} ORDER BY event_id`;
      if (rows.length === 0) return yield* new LiveVoiceHistoryError({ reason: "not_found" });
      const events = yield* Effect.forEach(rows, (row) =>
        Schema.decodeEffect(eventJson)(row.event_json).pipe(
          Effect.map((event) => ({ eventId: row.event_id, recordedAt: row.recorded_at, event })),
        ),
      );
      const replay = replayLiveVoiceTranscript(events);
      return {
        leaseId: target.leaseId,
        generation: target.generation,
        threadId: target.threadId,
        ...replay,
      };
    },
    Effect.mapError((error) => (error._tag === "LiveVoiceHistoryError" ? error : storageError())),
  );

  yield* Effect.forever(
    Effect.sleep("1 hour").pipe(Effect.andThen(pruneDiagnostics), Effect.ignoreCause),
  ).pipe(Effect.forkScoped);
  return LiveVoiceHistory.of({
    record,
    list,
    transcript,
    recordDiagnostic,
    diagnostics,
    diagnosticsSettings,
    setDiagnosticsEnabled,
  });
});

export const layer = Layer.effect(LiveVoiceHistory, make);
