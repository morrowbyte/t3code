import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect.each([63, 64, 65, 68, 69, 70, 71, 72])(
    "appends upstream migrations after the shipped fork prefix %s",
    (id) =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: id });
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([migrationId]) => migrationId > id),
        );
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("preserves fork Voice and host authority data when appending migrations 73–76", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json)
        VALUES ('thread-a', 'project-a', 'Voice', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
      yield* sql`INSERT INTO codex_live_voice_leases
        (lease_id, generation, environment_id, thread_id, provider_instance_id,
          model_selection_json, runtime_policy_json, principal_session_id, principal_subject,
          client_request_id, status, updated_at)
        VALUES ('lease-a', 1, 'env-a', 'thread-a', 'codex', '{}', '{}',
          'principal-a', 'subject-a', 'request-a', 'active', 'now')`;
      yield* sql`INSERT INTO codex_live_voice_intents
        (lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
          call_id, message, command_id, message_id, dispatch_state, updated_at)
        VALUES ('lease-a', 1, 'planner-a', 'turn-a', 0, 'call-a', 'Keep this transcript',
          'command-a', 'message-a', 'reserved', 'now')`;
      yield* sql`INSERT INTO codex_live_voice_history_events
        (environment_id, thread_id, lease_id, generation, recorded_at, event_type, event_json)
        VALUES ('env-a', 'thread-a', 'lease-a', 1, 'now', 'transcript', '{"text":"Keep my voice"}')`;
      yield* sql`INSERT INTO approval_review_host_orders
        (order_id, human_session_id, client_request_id, source_json, channel_json,
          state, expires_at, created_at)
        VALUES ('order-a', 'human-a', 'request-a', '{}', '{}', 'active', 100, 1)`;
      yield* sql`INSERT INTO approval_review_order_proposals
        (order_id, submission_id, request_id, package_hash)
        VALUES ('order-a', 'submission-a', 'review-a', 'hash-a')`;
      yield* sql`INSERT INTO approval_review_order_deliveries
        (host_session_id, order_id, payload_hash, state)
        VALUES ('host-a', 'order-a', 'hash-a', 'received')`;
      const retained = Effect.all([
        sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 72 ORDER BY migration_id`,
        sql`SELECT * FROM codex_live_voice_leases`,
        sql`SELECT * FROM codex_live_voice_intents`,
        sql`SELECT * FROM codex_live_voice_history_events`,
        sql`SELECT * FROM approval_review_host_orders`,
        sql`SELECT * FROM approval_review_order_proposals`,
        sql`SELECT * FROM approval_review_order_deliveries`,
      ]);
      const before = yield* retained;
      assert.deepStrictEqual(yield* runMigrations(), [
        [73, "ThreadMessageSearch"],
        [74, "PeerLinks"],
        [75, "PeerLinkFence"],
        [76, "WaitingLinkRequestIndex"],
      ]);
      assert.deepStrictEqual(yield* retained, before);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`UPDATE approval_review_host_orders SET source_json = '{"changed":true}'`,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses the separate upstream migration lineage without changing it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (63, 'DropUnusedV1Projections')`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, schema);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back the appended batch if search backfill fails, then retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('broken', 'thread-a', 'user', 0, 'now', 'now', 'invalid json')`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master
          WHERE name LIKE 'orchestration_v2_message_search%' OR name = 'peer_environment_links'`,
        [],
      );
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"text":"valid"}'`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 72),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("fences existing and new peer links with the migration default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('peer-a', 'secret-a', 'Peer', '["https://peer.example"]', 'read-only', 'then', 'later')`;
      const before = yield* sql`SELECT * FROM peer_environment_links`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM peer_environment_links`,
        before.map((row) => ({ ...row, fenced: 0 })),
      );
      yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('peer-b', 'secret-b', 'Second', '[]', 'read-only', 'now', 'later')`;
      assert.deepStrictEqual(
        yield* sql`SELECT fenced FROM peer_environment_links ORDER BY environment_id`,
        [{ fenced: 0 }, { fenced: 0 }],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
