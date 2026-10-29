import {
  VOICE_RECORDING_CHUNK_BYTES,
  VOICE_RECORDING_RETENTION_MS,
  VoiceRecordingChunk,
  VoiceRecordingEntry,
  VoiceRecordingError,
  VoiceRecordingStart,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A stable one-way session fingerprint keeps credentials out of filenames.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";

const Manifest = Schema.Struct({
  ...VoiceRecordingEntry.fields,
  format: Schema.Literal("t3-call-recording-v1"),
  owner: Schema.String,
  userSequence: Schema.Number,
  assistantSequence: Schema.Number,
});
type Manifest = typeof Manifest.Type;
const Prefs = Schema.Record(Schema.String, Schema.Number);
const encodePrefs = Schema.encodeEffect(Schema.fromJsonString(Prefs));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
const encodeTimeline = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isRecordingError = Schema.is(VoiceRecordingError);
type Principal = EnvironmentSessionPrincipalShape;
const fingerprint = (session: Principal) =>
  NodeCrypto.createHash("sha256").update(session.sessionId).digest("hex");
const MAX_CALL_BYTES = 256 * 1024 * 1024;
const MAX_STORE_BYTES = 1024 * 1024 * 1024;
const MAX_CALL_MS = 12 * 60 * 60 * 1000;
const extension = (mime: string) => (mime.startsWith("audio/ogg") ? "ogg" : "webm");
const storageError = () => new VoiceRecordingError({ reason: "storage" });
const publicEntry = ({
  format: _format,
  owner: _owner,
  userSequence: _u,
  assistantSequence: _a,
  ...entry
}: Manifest) => entry;

export class VoiceRecordingService extends Context.Service<
  VoiceRecordingService,
  {
    readonly settings: (
      session: Principal,
    ) => Effect.Effect<
      { enabled: boolean; hostLabel: string; directory: string; retentionDays: number },
      VoiceRecordingError
    >;
    readonly updateSettings: (
      session: Principal,
      enabled: boolean,
    ) => Effect.Effect<
      { enabled: boolean; hostLabel: string; directory: string; retentionDays: number },
      VoiceRecordingError
    >;
    readonly start: (
      session: Principal,
      input: typeof VoiceRecordingStart.Type,
    ) => Effect.Effect<typeof VoiceRecordingEntry.Type, VoiceRecordingError>;
    readonly append: (
      session: Principal,
      input: typeof VoiceRecordingChunk.Type,
    ) => Effect.Effect<void, VoiceRecordingError>;
    readonly finish: (session: Principal, id: string) => Effect.Effect<void, VoiceRecordingError>;
    readonly list: (
      session: Principal,
    ) => Effect.Effect<ReadonlyArray<typeof VoiceRecordingEntry.Type>, VoiceRecordingError>;
    readonly file: (
      session: Principal,
      id: string,
      role: "user" | "assistant",
    ) => Effect.Effect<
      {
        stream: Stream.Stream<Uint8Array, VoiceRecordingError>;
        mimeType: string;
        filename: string;
      },
      VoiceRecordingError
    >;
    readonly cleanup: Effect.Effect<void, VoiceRecordingError>;
  }
>()("t3/voice/VoiceRecordingService") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "voice-recordings");
  const preferences = path.join(directory, "opt-ins.json");
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.catch(() => Effect.logWarning("Voice recording storage unavailable")));
  const readPrefs = Effect.fn("VoiceRecordingService.readPrefs")(function* () {
    return (yield* fs.exists(preferences))
      ? yield* fs
          .readFileString(preferences)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Prefs))))
      : {};
  });
  const save = Effect.fn("VoiceRecordingService.save")(function* (manifest: Manifest) {
    const filename = path.join(directory, manifest.id, "manifest.json");
    yield* fs.writeFileString(`${filename}.tmp`, yield* encodeManifest(manifest), { mode: 0o600 });
    yield* fs.rename(`${filename}.tmp`, filename);
  });
  const read = Effect.fn("VoiceRecordingService.read")(function* (id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      return yield* new VoiceRecordingError({ reason: "session_mismatch" });
    const folder = path.join(directory, id);
    const canonicalRoot = yield* fs.realPath(directory);
    const canonicalFolder = yield* fs.realPath(folder);
    if (
      canonicalFolder !== path.join(canonicalRoot, id) ||
      (yield* fs.realPath(path.join(folder, "manifest.json"))) !==
        path.join(canonicalFolder, "manifest.json")
    )
      return yield* new VoiceRecordingError({ reason: "session_mismatch" });
    return yield* fs
      .readFileString(path.join(folder, "manifest.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
  });
  const entries = Effect.fn("VoiceRecordingService.entries")(function* () {
    const found: Manifest[] = [];
    for (const id of yield* fs.readDirectory(directory)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const entry = yield* read(id).pipe(Effect.option);
      if (entry._tag === "Some" && entry.value.id === id) found.push(entry.value);
    }
    return found;
  });
  const settings = Effect.fn("VoiceRecordingService.settings")(function* (session: Principal) {
    const enabledUntil = (yield* readPrefs())[fingerprint(session)];
    const now = yield* Clock.currentTimeMillis;
    return {
      enabled: enabledUntil !== undefined && now < enabledUntil,
      hostLabel: "Connected environment host",
      directory,
      retentionDays: 3,
    };
  }, Effect.mapError(storageError));
  const owned = Effect.fn("VoiceRecordingService.owned")(function* (
    session: Principal,
    id: string,
  ) {
    const manifest = yield* read(id);
    if (
      manifest.owner !== fingerprint(session) ||
      (yield* Clock.currentTimeMillis) - manifest.startedAt >= VOICE_RECORDING_RETENTION_MS
    )
      return yield* new VoiceRecordingError({ reason: "session_mismatch" });
    return manifest;
  });
  const requireEnabled = Effect.fn("VoiceRecordingService.requireEnabled")(function* (
    session: Principal,
  ) {
    if (!(yield* settings(session)).enabled)
      return yield* new VoiceRecordingError({ reason: "disabled" });
  });
  const verifyLease = Effect.fn("VoiceRecordingService.verifyLease")(function* (
    session: Principal,
    input: typeof VoiceRecordingStart.Type,
  ) {
    const rows = yield* sql<{
      status: string;
    }>`SELECT status FROM codex_live_voice_leases WHERE lease_id = ${input.leaseId} AND generation = ${input.generation} AND environment_id = ${input.environmentId} AND thread_id = ${input.threadId} AND principal_session_id = ${session.sessionId}`;
    if (!rows[0] || !["starting", "active"].includes(rows[0].status))
      return yield* new VoiceRecordingError({ reason: "session_mismatch" });
  });
  const verifyAppendLease = Effect.fn("VoiceRecordingService.verifyAppendLease")(function* (
    session: Principal,
    manifest: Manifest,
  ) {
    const rows = yield* sql<{
      status: string;
      updated_at: string;
    }>`SELECT status, updated_at FROM codex_live_voice_leases WHERE lease_id = ${manifest.leaseId} AND generation = ${manifest.generation} AND environment_id = ${manifest.environmentId} AND thread_id = ${manifest.threadId} AND principal_session_id = ${session.sessionId}`;
    const row = rows[0];
    // The controller releases its lease before final browser events reach the host.
    const finalChunkWindow =
      row && (yield* Clock.currentTimeMillis) - Date.parse(row.updated_at) <= 30_000;
    if (!row || (!["starting", "active"].includes(row.status) && !finalChunkWindow))
      return yield* new VoiceRecordingError({ reason: "session_mismatch" });
  });
  const normalize = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => (isRecordingError(cause) ? cause : storageError())));
  const cleanup = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const entry of yield* entries()) {
          if (now - entry.startedAt < VOICE_RECORDING_RETENTION_MS) continue;
          const folder = path.join(directory, entry.id);
          // Never recursively remove a directory: unknown neighboring files remain untouched.
          for (const name of [
            "user.ogg",
            "assistant.ogg",
            "user.webm",
            "assistant.webm",
            "timeline.ndjson",
            "manifest.json.tmp",
            "manifest.json",
          ]) {
            yield* fs.remove(path.join(folder, name), { force: true });
          }
          yield* fs.remove(folder).pipe(Effect.ignore());
        }
        const prefs = yield* readPrefs();
        const current = Object.fromEntries(
          Object.entries(prefs).filter(([, until]) => now < until),
        );
        yield* fs.writeFileString(`${preferences}.tmp`, yield* encodePrefs(current), {
          mode: 0o600,
        });
        yield* fs.rename(`${preferences}.tmp`, preferences);
      }),
    )
    .pipe(normalize);
  const service = VoiceRecordingService.of({
    settings,
    updateSettings: Effect.fn("VoiceRecordingService.updateSettings")((session, enabled) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const prefs = { ...(yield* readPrefs()) };
            if (enabled) {
              if (Object.keys(prefs).length >= 100 && prefs[fingerprint(session)] === undefined)
                return yield* new VoiceRecordingError({ reason: "limit" });
              prefs[fingerprint(session)] =
                session.expiresAt?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER;
            } else delete prefs[fingerprint(session)];
            yield* fs.writeFileString(`${preferences}.tmp`, yield* encodePrefs(prefs), {
              mode: 0o600,
            });
            yield* fs.rename(`${preferences}.tmp`, preferences);
            return yield* settings(session);
          }),
        )
        .pipe(normalize),
    ),
    start: Effect.fn("VoiceRecordingService.start")((session, input) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* requireEnabled(session);
            yield* verifyLease(session, input);
            const previous = yield* entries();
            if (
              previous.length >= 100 ||
              previous.reduce((sum, e) => sum + e.bytes, 0) >= MAX_STORE_BYTES
            )
              return yield* new VoiceRecordingError({ reason: "limit" });
            const id = yield* crypto.randomUUIDv4();
            const manifest: Manifest = {
              ...input,
              id,
              format: "t3-call-recording-v1",
              owner: fingerprint(session),
              startedAt: yield* Clock.currentTimeMillis,
              endedAt: null,
              bytes: 0,
              userSequence: 0,
              assistantSequence: 0,
            };
            yield* fs.makeDirectory(path.join(directory, id), { mode: 0o700 });
            yield* save(manifest);
            return publicEntry(manifest);
          }),
        )
        .pipe(normalize),
    ),
    append: Effect.fn("VoiceRecordingService.append")((session, input) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* requireEnabled(session);
            const manifest = yield* owned(session, input.id);
            yield* verifyAppendLease(session, manifest);
            if (manifest.endedAt !== null)
              return yield* new VoiceRecordingError({ reason: "session_mismatch" });
            const key = input.role === "user" ? "userSequence" : "assistantSequence";
            const bytes = Buffer.from(input.data, "base64");
            if (
              input.sequence !== manifest[key] ||
              bytes.length === 0 ||
              bytes.length > VOICE_RECORDING_CHUNK_BYTES ||
              bytes.toString("base64") !== input.data ||
              input.offsetMs > MAX_CALL_MS
            )
              return yield* new VoiceRecordingError({ reason: "invalid_chunk" });
            if (
              manifest.bytes + bytes.length > MAX_CALL_BYTES ||
              (yield* entries()).reduce((sum, e) => sum + e.bytes, 0) + bytes.length >
                MAX_STORE_BYTES ||
              (yield* Clock.currentTimeMillis) - manifest.startedAt >= MAX_CALL_MS
            )
              return yield* new VoiceRecordingError({ reason: "limit" });
            const folder = path.join(directory, manifest.id);
            yield* fs.writeFile(
              path.join(folder, `${input.role}.${extension(manifest.mimeType)}`),
              bytes,
              { flag: "a", mode: 0o600 },
            );
            yield* fs.writeFileString(
              path.join(folder, "timeline.ndjson"),
              `${yield* encodeTimeline({ role: input.role, sequence: input.sequence, offsetMs: input.offsetMs, trackStartedOffsetMs: input.trackStartedOffsetMs, byteLength: bytes.length })}\n`,
              { flag: "a", mode: 0o600 },
            );
            yield* save({
              ...manifest,
              [key]: input.sequence + 1,
              bytes: manifest.bytes + bytes.length,
            });
          }),
        )
        .pipe(normalize),
    ),
    finish: Effect.fn("VoiceRecordingService.finish")((session, id) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const manifest = yield* owned(session, id);
            if (manifest.endedAt === null)
              yield* save({ ...manifest, endedAt: yield* Clock.currentTimeMillis });
          }),
        )
        .pipe(normalize),
    ),
    list: Effect.fn("VoiceRecordingService.list")(function* (session) {
      const now = yield* Clock.currentTimeMillis;
      return (yield* entries())
        .filter(
          (e) =>
            e.owner === fingerprint(session) && now - e.startedAt < VOICE_RECORDING_RETENTION_MS,
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(publicEntry);
    }, normalize),
    file: Effect.fn("VoiceRecordingService.file")(function* (session, id, role) {
      const manifest = yield* owned(session, id);
      const filename = `${role}.${extension(manifest.mimeType)}`;
      const filenamePath = path.join(directory, id, filename);
      if (!(yield* fs.exists(filenamePath)))
        return yield* new VoiceRecordingError({ reason: "session_mismatch" });
      return {
        mimeType: manifest.mimeType,
        filename: `${id}-${filename}`,
        stream: fs.stream(filenamePath).pipe(Stream.mapError(storageError)),
      };
    }, normalize),
    cleanup,
  });
  // Retention runs at startup and while idle, independently of call activity.
  yield* cleanup.pipe(Effect.catch(() => Effect.logWarning("Voice recording retention failed")));
  yield* cleanup.pipe(
    Effect.catch(() => Effect.logWarning("Voice recording retention failed")),
    Effect.repeat({ schedule: Schedule.spaced("1 hour") }),
    Effect.delay("1 hour"),
    Effect.forkScoped({ startImmediately: true }),
  );
  return service;
});
export const layer = Layer.effect(VoiceRecordingService, make);
