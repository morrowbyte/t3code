import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect("reports and deletes only the database from before 0.1.0", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-" });
        const dbPath = path.join(userdata, "statev2.sqlite");
        const legacy = path.join(userdata, "state.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

        const openLegacy = NodeSqliteClient.layer({ filename: legacy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`CREATE TABLE v1_data (value TEXT)`;
          yield* sql`INSERT INTO v1_data VALUES ('keep until deleted')`;
        }).pipe(Effect.provide(openLegacy));
        assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

        // A version before 0.1.0 still running against it keeps it.
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM v1_data`;
          return yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
        }).pipe(Effect.provide(openLegacy));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.isTrue(yield* fs.exists(legacy));

        const removed: Array<string> = [];
        let refuseUnlink = true;
        const guardedMaintenance = Layer.fresh(DatabaseMaintenance.layer).pipe(
          Layer.provide(
            Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              remove: (file, options) =>
                Effect.gen(function* () {
                  removed.push(file);
                  assert.equal(file, legacy);
                  assert.isFalse(yield* fs.exists(`${legacy}-wal`));
                  assert.isFalse(yield* fs.exists(`${legacy}-shm`));
                  // A fresh writer can lock and read only after maintenance's
                  // exclusive connection has closed, including on Linux CI.
                  yield* Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`PRAGMA busy_timeout = 0`;
                    yield* sql`BEGIN EXCLUSIVE`;
                    assert.deepEqual(yield* sql`SELECT value FROM v1_data`, [
                      { value: "keep until deleted" },
                    ]);
                    yield* sql`COMMIT`;
                  }).pipe(Effect.provide(openLegacy));
                  if (refuseUnlink) {
                    // Windows refuses unlink if another process reopens the
                    // database after maintenance closes its own connection.
                    yield* fs.writeFileString(`${legacy}-wal`, "new writer WAL");
                    yield* fs.writeFileString(`${legacy}-shm`, "new writer SHM");
                    return yield* Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: file,
                      }),
                    );
                  }
                  yield* fs.remove(file, options);
                }),
            }),
          ),
        );
        const removeLegacy = Effect.flatMap(DatabaseMaintenance.DatabaseMaintenance, (service) =>
          service.removeLegacyDatabase(dbPath),
        ).pipe(Effect.provide(guardedMaintenance));
        const unlinkFailure = yield* Effect.flip(removeLegacy);
        assert.equal(unlinkFailure._tag, "LegacyDatabaseRemoveError");
        assert.deepEqual(removed, [legacy]);
        assert.isTrue(yield* fs.exists(legacy));
        assert.equal(yield* fs.readFileString(`${legacy}-wal`), "new writer WAL");
        assert.equal(yield* fs.readFileString(`${legacy}-shm`), "new writer SHM");
        yield* fs.remove(`${legacy}-wal`);
        yield* fs.remove(`${legacy}-shm`);

        refuseUnlink = false;
        yield* removeLegacy;
        assert.isFalse(yield* fs.exists(legacy));
        assert.isFalse(yield* fs.exists(`${legacy}-wal`));
        assert.isFalse(yield* fs.exists(`${legacy}-shm`));
        assert.isTrue(yield* fs.exists(dbPath));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
      }).pipe(Effect.scoped),
    );

    it.effect("compacts an existing database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        // A migrated database created before incremental auto_vacuum, with free pages.
        yield* Effect.flatMap(
          ProjectionMaintenance.ProjectionMaintenanceV2,
          (projections) => projections.rebuild,
        ).pipe(
          Effect.provide(
            ProjectionMaintenance.layer.pipe(
              Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        // A server that merely has the database open, like an idle one, is enough to refuse.
        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          return yield* maintenance.compact(dbPath).pipe(Effect.flip);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const result = yield* maintenance.compact(dbPath);
        // The 4 MiB of free pages are returned to the filesystem.
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );
  },
);
