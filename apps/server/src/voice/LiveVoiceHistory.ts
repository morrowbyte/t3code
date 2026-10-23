import type {
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

export class LiveVoiceHistory extends Context.Service<
  LiveVoiceHistory,
  {
    readonly record: (session: LiveVoiceSession, event: LiveVoiceEvent) => Effect.Effect<void>;
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
  const ensureThread = Effect.fn("LiveVoiceHistory.ensureThread")(function* (target: ThreadTarget) {
    const rows = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${target.threadId} AND deleted_at IS NULL`;
    if (rows.length === 0) return yield* new LiveVoiceHistoryError({ reason: "not_found" });
  });
  const storageError = () => new LiveVoiceHistoryError({ reason: "storage" });
  // Speech arrives per fragment; the call already owns the tracing boundary.
  const record = Effect.fnUntraced(
    function* (session: LiveVoiceSession, event: LiveVoiceEvent) {
      if (event.type !== "status" && event.type !== "transcript") return;
      const identity = event.type === "status" ? event.session : event;
      if (identity.leaseId !== session.leaseId || identity.generation !== session.generation)
        return;
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
        Schema.decodeUnknownEffect(eventJson)(row.event_json).pipe(
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

  return LiveVoiceHistory.of({ record, list, transcript });
});

export const layer = Layer.effect(LiveVoiceHistory, make);
