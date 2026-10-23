import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type LiveVoiceSession,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { runMigrations } from "../persistence/Migrations.ts";
import * as LiveVoiceHistory from "./LiveVoiceHistory.ts";
import * as CodexLiveEventHub from "./CodexLiveEventHub.ts";

const session: LiveVoiceSession = {
  environmentId: EnvironmentId.make("env-history"),
  threadId: ThreadId.make("thread-history"),
  leaseId: "call-a",
  generation: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  plannerNativeThreadId: null,
  status: "active",
};
const target = { environmentId: session.environmentId, threadId: session.threadId };
const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${session.threadId}, 'project', 'Fixture', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}'),
    ('other-thread', 'project', 'Other', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`;
});
const services = Layer.mergeAll(LiveVoiceHistory.layer, CodexLiveEventHub.layer);
const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "persists only public status/speech, ends two separate calls and survives a new service instance",
  () =>
    Effect.gen(function* () {
      yield* setup;
      yield* Effect.gen(function* () {
        const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
        yield* hub.register(session);
        yield* hub.register({ ...session, status: "preparing" });
        yield* hub.publish({
          type: "answer",
          leaseId: session.leaseId,
          generation: 1,
          sdp: "private SDP",
        });
        yield* hub.publish({
          type: "error",
          leaseId: session.leaseId,
          generation: 1,
          code: "runtime_unavailable",
        });
        yield* hub.publish({
          type: "transcript",
          leaseId: session.leaseId,
          generation: 1,
          role: "user",
          text: "Only observed speech",
        });
        yield* hub.publish({ type: "status", session: { ...session, status: "closed" } });
        const second = { ...session, leaseId: "call-b", generation: 2 };
        yield* hub.register(second);
        yield* hub.publish({
          type: "transcript",
          leaseId: "call-b",
          generation: 2,
          role: "assistant",
          text: "Second call",
        });
        yield* hub.publish({ type: "status", session: { ...second, status: "closed" } });
      }).pipe(Effect.provide(services));

      yield* Effect.gen(function* () {
        const history = yield* LiveVoiceHistory.LiveVoiceHistory;
        const calls = yield* history.list(target);
        assert.deepEqual(
          calls.calls.map((call) => [call.leaseId, call.generation, call.status]),
          [
            ["call-b", 2, "closed"],
            ["call-a", 1, "closed"],
          ],
        );
        const transcript = yield* history.transcript({
          ...target,
          leaseId: "call-a",
          generation: 1,
        });
        assert.deepEqual(
          transcript.entries.map((entry) => entry.text),
          ["Only observed speech"],
        );
        assert.equal(transcript.entries[0]!.occurredAt, calls.calls[1]!.startedAt);
        const wrongThread = yield* history
          .transcript({
            ...target,
            threadId: ThreadId.make("other-thread"),
            leaseId: "call-a",
            generation: 1,
          })
          .pipe(Effect.result);
        assert.equal(wrongThread._tag, "Failure");
        const wrongEnvironment = yield* history
          .transcript({
            ...target,
            environmentId: EnvironmentId.make("wrong-env"),
            leaseId: "call-a",
            generation: 1,
          })
          .pipe(Effect.result);
        assert.equal(wrongEnvironment._tag, "Failure");
        const sql = yield* SqlClient.SqlClient;
        const events = yield* sql<{
          event_type: string;
          event_json: string;
        }>`SELECT event_type, event_json FROM codex_live_voice_history_events`;
        assert.lengthOf(events, 6);
        assert.isFalse(events.some((row) => row.event_json.includes("private SDP")));
        assert.isTrue(calls.persistenceAvailable);
      }).pipe(Effect.provide(LiveVoiceHistory.layer));
    }).pipe(Effect.provide(sqlite)),
);

it.effect("pages through earlier calls without losing or duplicating calls", () =>
  Effect.gen(function* () {
    yield* setup;
    const history = yield* LiveVoiceHistory.LiveVoiceHistory;
    for (let index = 0; index < 25; index++) {
      const call = { ...session, leaseId: `call-${index}`, status: "closed" as const };
      yield* history.record(call, { type: "status", session: call });
    }
    const recent = yield* history.list(target);
    assert.lengthOf(recent.calls, 20);
    const older = yield* history.list({ ...target, before: Number(recent.nextBefore) });
    assert.lengthOf(older.calls, 5);
    assert.equal(older.nextBefore, null);
    assert.equal(new Set([...recent.calls, ...older.calls].map((call) => call.leaseId)).size, 25);
  }).pipe(Effect.provide(LiveVoiceHistory.layer.pipe(Layer.provideMerge(sqlite)))),
);

it.effect("reports write failure while allowing live status delivery to continue", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_history_write BEFORE INSERT ON codex_live_voice_history_events
      BEGIN SELECT RAISE(ABORT, 'fixture storage unavailable'); END`;
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    yield* hub.register(session);
    const first = yield* Stream.runCollect(hub.subscribe(session).pipe(Stream.take(1)));
    assert.lengthOf(Array.from(first), 1);
    const history = yield* LiveVoiceHistory.LiveVoiceHistory;
    assert.isFalse((yield* history.list(target)).persistenceAvailable);
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(sqlite)))),
);
