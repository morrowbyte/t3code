import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import migration from "./073_ThreadMessageSearch.ts";

describe("073_ThreadMessageSearch", () => {
  it.effect.each([1, 10, 13])(
    "falls back only for unsupported SQLite options (errcode %s)",
    (errcode) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 72 });
        const error = new SqlError.SqlError({
          reason: new SqlError.UnknownError({ cause: { errcode } }),
        });
        const unavailable = new Proxy(sql, { apply: () => Effect.fail(error) });
        const result = yield* Effect.exit(
          migration.pipe(Effect.provideService(SqlClient.SqlClient, unavailable)),
        );
        assert.equal(Exit.isSuccess(result), errcode === 1);
        assert.deepEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'orchestration_v2_message_search%'`,
          [],
        );
        yield* runMigrations();
        assert.lengthOf(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_message_search'`,
          1,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("backfills what users wrote and agents answered, then follows deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      const insert = (
        id: string,
        role: string,
        streaming: number,
        text: string,
        createdBy: string | undefined = role === "user" ? "user" : "agent",
      ) => sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        )
        VALUES (
          ${id}, 'thread-1', NULL, NULL, ${role}, ${streaming},
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${JSON.stringify({ text, createdBy })}
        )
      `;
      yield* insert("user", "user", 0, "needle from the user");
      yield* insert("assistant", "assistant", 0, "needle from the agent");
      yield* insert("streaming", "assistant", 1, "needle still streaming");
      yield* insert("system", "system", 0, "needle in a system prompt");
      yield* insert("notice", "user", 0, "needle in a pull request update", "agent");
      // Older rows carry no author; they were the user's.
      yield* insert("legacy", "user", 0, "needle from before authors", undefined);
      yield* sql`UPDATE orchestration_v2_projection_messages
        SET payload_json = '{"text":"needle from before authors"}' WHERE message_id = 'legacy'`;
      yield* insert("apostrophe", "assistant", 0, "agent’s needle");
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json)
        VALUES ('child', 'project-a', 'Child', 'codex', 'full-access', 'default', 'now', 'now',
          '{"lineage":{"relationshipToParent":"subagent"}}')`;
      yield* insert("subagent", "assistant", 0, "needle from a child");
      yield* sql`UPDATE orchestration_v2_projection_messages SET thread_id = 'child'
        WHERE message_id = 'subagent'`;

      yield* runMigrations();

      const indexed = () =>
        sql<{ readonly messageId: string }>`
          SELECT messages.message_id AS "messageId"
          FROM orchestration_v2_message_search AS search
          INNER JOIN orchestration_v2_projection_messages AS messages
            ON messages.rowid = search.rowid
          WHERE orchestration_v2_message_search MATCH '"needle"'
          ORDER BY messages.message_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.messageId)));
      assert.deepEqual(yield* indexed(), ["apostrophe", "assistant", "legacy", "user"]);
      assert.lengthOf(
        yield* sql`SELECT rowid FROM orchestration_v2_message_search
          WHERE orchestration_v2_message_search MATCH ${'"agent\'s"'}`,
        1,
      );

      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0
        WHERE message_id = 'streaming'`;
      assert.deepEqual(yield* indexed(), [
        "apostrophe",
        "assistant",
        "legacy",
        "streaming",
        "user",
      ]);

      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'user'`;
      assert.deepEqual(yield* indexed(), ["apostrophe", "assistant", "legacy", "streaming"]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
