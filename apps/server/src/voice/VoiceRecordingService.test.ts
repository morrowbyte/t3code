import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ThreadId,
  VOICE_RECORDING_RETENTION_MS,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as ServerConfig from "../config.ts";
import { make, type VoiceRecordingService } from "./VoiceRecordingService.ts";

const encodeFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const session: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("recording-session"),
  subject: "fixture",
  method: "browser-session-cookie",
  scopes: new Set(["orchestration:read", "orchestration:operate", "settings:write"]),
};
const other = { ...session, sessionId: AuthSessionId.make("other-session") };
const input = {
  environmentId: EnvironmentId.make("env-test"),
  threadId: ThreadId.make("thread-test"),
  leaseId: "lease-test",
  generation: 1,
  mimeType: "audio/ogg;codecs=opus" as const,
};
const chunk = (id: string, role: "user" | "assistant" = "user", sequence = 0) => ({
  id,
  role,
  sequence,
  offsetMs: 1000,
  trackStartedOffsetMs: 0,
  data: Buffer.from("synthetic-opus-fixture").toString("base64"),
});
const fixture = <A, E, R>(
  run: (service: VoiceRecordingService["Service"]) => Effect.Effect<A, E, R>,
  observeFs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE codex_live_voice_leases (lease_id TEXT, generation INTEGER, environment_id TEXT, thread_id TEXT, principal_session_id TEXT, status TEXT, updated_at TEXT)`;
    yield* sql`INSERT INTO codex_live_voice_leases VALUES ('lease-test', 1, 'env-test', 'thread-test', ${session.sessionId}, 'active', '1970-01-01T00:00:00.000Z')`;
    const fs = yield* FileSystem.FileSystem;
    return yield* run(
      yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, observeFs ? observeFs(fs) : fs),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "recording-test-" }),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  );

it.effect(
  "defaults off; opt-in, lease, environment and file ownership remain session bound",
  () => {
    const permissions = new Map<string, number | undefined>();
    return fixture(
      (service) =>
        Effect.gen(function* () {
          assert.isFalse((yield* service.settings(session)).enabled);
          assert.equal((yield* service.start(session, input).pipe(Effect.result))._tag, "Failure");
          yield* service.updateSettings(session, true);
          assert.isFalse((yield* service.settings(other)).enabled);
          assert.equal(
            (yield* service
              .start(session, { ...input, environmentId: EnvironmentId.make("wrong-env") })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          const entry = yield* service.start(session, input);
          yield* service.append(session, chunk(entry.id));
          yield* service.append(session, chunk(entry.id, "assistant"));
          assert.equal(
            (yield* service.append(other, chunk(entry.id)).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal(
            (yield* service.file(other, entry.id, "user").pipe(Effect.result))._tag,
            "Failure",
          );
          assert.deepEqual(yield* service.list(other), []);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = (yield* service.settings(session)).directory;
          const posixModes = (yield* HostProcess.Platform) !== "win32";
          for (const filename of [root, path.join(root, entry.id)]) {
            assert.equal(permissions.get(filename), 0o700);
            if (posixModes) assert.equal((yield* fs.stat(filename)).mode & 0o777, 0o700);
          }
          for (const filename of [
            "user.ogg",
            "assistant.ogg",
            "manifest.json",
            "timeline.ndjson",
          ]) {
            const file = path.join(root, entry.id, filename);
            assert.equal(permissions.get(file), 0o600);
            if (posixModes) assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
          }
          assert.equal(
            yield* fs.readFileString(path.join(root, entry.id, "user.ogg")),
            "synthetic-opus-fixture",
          );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE codex_live_voice_leases SET status = 'closed'`;
          yield* service.append(session, chunk(entry.id, "user", 1));
          yield* TestClock.adjust(30_001);
          assert.equal(
            (yield* service.append(session, chunk(entry.id, "user", 2)).pipe(Effect.result))._tag,
            "Failure",
          );
          yield* service.finish(session, entry.id);
          assert.isNotNull((yield* service.list(session))[0]?.endedAt);
          assert.equal(
            (yield* service.append(session, chunk(entry.id, "user", 1)).pipe(Effect.result))._tag,
            "Failure",
          );
        }),
      (fs) =>
        FileSystem.make({
          ...fs,
          makeDirectory: (path, options) =>
            fs.makeDirectory(path, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  permissions.set(path, options?.mode);
                }),
              ),
            ),
          writeFile: (path, bytes, options) =>
            fs.writeFile(path, bytes, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  permissions.set(path, options?.mode);
                }),
              ),
            ),
          rename: (from, to) =>
            fs.rename(from, to).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  permissions.set(to, permissions.get(from));
                }),
              ),
            ),
        }),
    );
  },
);

it.effect("opt-out rejects further bytes and sequence/size limits reject before writing", () =>
  fixture((service) =>
    Effect.gen(function* () {
      yield* service.updateSettings(session, true);
      const entry = yield* service.start(session, input);
      assert.equal(
        (yield* service.append(session, chunk(entry.id, "user", 2)).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* service
          .append(session, {
            ...chunk(entry.id),
            data: Buffer.alloc(256 * 1024 + 1).toString("base64"),
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* service.append(session, chunk(entry.id));
      yield* service.updateSettings(session, false);
      assert.equal(
        (yield* service.append(session, chunk(entry.id, "user", 1)).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* service.finish(session, entry.id);
      assert.equal(
        (yield* service.list(session))[0]?.bytes,
        Buffer.byteLength("synthetic-opus-fixture"),
      );
    }),
  ),
);

it.effect("retention expires at three days and removes only owned names", () =>
  fixture((service) =>
    Effect.gen(function* () {
      yield* service.updateSettings(session, true);
      const entry = yield* service.start(session, input);
      yield* service.append(session, chunk(entry.id));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = (yield* service.settings(session)).directory;
      const neighbor = path.join(root, entry.id, "unrelated.txt");
      yield* fs.writeFileString(neighbor, "preserve");
      yield* fs.makeDirectory(path.join(root, "unowned"));
      yield* fs.writeFileString(path.join(root, "unowned", "user.ogg"), "preserve");
      const linkedId = "22222222-2222-2222-2222-222222222222";
      const external = path.join(path.dirname(root), "unrelated-recordings");
      yield* fs.makeDirectory(external);
      yield* fs.writeFileString(path.join(external, "user.ogg"), "external-preserve");
      const manifest = yield* fs
        .readFileString(path.join(root, entry.id, "manifest.json"))
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
            ),
          ),
        );
      yield* fs.writeFileString(
        path.join(external, "manifest.json"),
        yield* encodeFixture({
          ...manifest,
          id: linkedId,
        }),
      );
      yield* fs.symlink(external, path.join(root, linkedId));
      yield* TestClock.adjust(VOICE_RECORDING_RETENTION_MS - 1);
      yield* service.cleanup;
      assert.isTrue(yield* fs.exists(path.join(root, entry.id, "user.ogg")));
      yield* TestClock.adjust(1);
      yield* service.cleanup;
      assert.isFalse(yield* fs.exists(path.join(root, entry.id, "user.ogg")));
      assert.equal(yield* fs.readFileString(neighbor), "preserve");
      assert.equal(yield* fs.readFileString(path.join(root, "unowned", "user.ogg")), "preserve");
      assert.equal(yield* fs.readFileString(path.join(external, "user.ogg")), "external-preserve");
      assert.isTrue((yield* service.settings(session)).enabled);
    }),
  ),
);

it.effect("startup and the idle hourly worker clean expired files without another call", () =>
  Effect.gen(function* () {
    const removed = yield* Deferred.make<void>();
    yield* TestClock.adjust(VOICE_RECORDING_RETENTION_MS - 60 * 60 * 1000);
    yield* fixture(
      (service) =>
        Effect.gen(function* () {
          yield* service.updateSettings(session, true);
          const entry = yield* service.start(session, input);
          yield* service.append(session, chunk(entry.id));
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = (yield* service.settings(session)).directory;
          const target = path.join(root, entry.id, "user.ogg");
          const manifestPath = path.join(root, entry.id, "manifest.json");
          const manifest = yield* fs
            .readFileString(manifestPath)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
                ),
              ),
            );
          yield* fs.writeFileString(
            manifestPath,
            yield* encodeFixture({
              ...manifest,
              startedAt: 0,
            }),
          );
          yield* TestClock.adjust("1 hour");
          yield* Deferred.await(removed);
          assert.isFalse(yield* fs.exists(target));
          const orphanId = "11111111-1111-1111-1111-111111111111";
          yield* fs.makeDirectory(path.join(root, orphanId));
          yield* fs.writeFileString(
            path.join(root, orphanId, "manifest.json"),
            yield* encodeFixture({
              ...entry,
              id: orphanId,
              format: "t3-call-recording-v1",
              owner: "fixture",
              userSequence: 0,
              assistantSequence: 0,
              startedAt: (yield* Clock.currentTimeMillis) - VOICE_RECORDING_RETENTION_MS,
            }),
          );
          yield* fs.writeFileString(path.join(root, orphanId, "user.ogg"), "fixture");
          yield* make;
          assert.isFalse(yield* fs.exists(path.join(root, orphanId, "user.ogg")));
        }),
      (fs) => ({
        ...fs,
        remove: (filename, options) =>
          fs
            .remove(filename, options)
            .pipe(
              Effect.tap(() =>
                /[\\/]user\.ogg$/.test(filename)
                  ? Deferred.succeed(removed, undefined)
                  : Effect.void,
              ),
            ),
      }),
    );
  }),
);
