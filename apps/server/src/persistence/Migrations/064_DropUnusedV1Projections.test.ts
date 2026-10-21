import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("064_DropUnusedV1Projections", (it) => {
  it.effect("drops V1 projections nothing reads and keeps the transcript import sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-1', 'thread-1', 'user', 'hello', 0, '2026-01-01', '2026-01-01')
      `;

      yield* sql`
        INSERT INTO codex_live_voice_leases (
          lease_id, generation, environment_id, thread_id, provider_instance_id,
          model_selection_json, runtime_policy_json, principal_session_id, principal_subject,
          client_request_id, status, updated_at
        ) VALUES ('retained-voice', 1, 'env', 'thread', 'codex', '{}', '{}',
          'principal', 'subject', 'request', 'closed', '2026-10-18T00:00:00.000Z')
      `;
      const leases = yield* sql`SELECT * FROM codex_live_voice_leases`;
      const voiceHistory = yield* sql`
        SELECT * FROM effect_sql_migrations WHERE migration_id = 63
      `;
      yield* runMigrations({ toMigrationInclusive: 64 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM codex_live_voice_leases`, leases);
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM effect_sql_migrations WHERE migration_id = 63
      `,
        voiceHistory,
      );
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 65 }), [
        [65, "CanonicalizeThreadPullRequestLinks"],
      ]);

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tables = new Set(rows.map((row) => row.name));
      for (const dropped of [
        "projection_thread_activities",
        "projection_turns",
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
        "projection_state",
        "checkpoint_diff_blobs",
      ]) {
        assert.isFalse(tables.has(dropped), dropped);
      }
      for (const kept of [
        "projection_threads",
        "projection_thread_messages",
        "projection_thread_pull_requests",
      ]) {
        assert.isTrue(tables.has(kept), kept);
      }
      assert.deepEqual(yield* sql`SELECT message_id FROM projection_thread_messages`, [
        { message_id: "message-1" },
      ]);
    }),
  );
});
