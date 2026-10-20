import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  YaziPickerError,
  type YaziPickerFile,
  type YaziPickerOpenInput,
  type YaziPickerOpened,
  type YaziPickerPollResult,
  type YaziPickerReadInput,
  type YaziPickerReadResult,
  type YaziPickerResizeInput,
  type YaziPickerSessionInput,
  type YaziPickerWriteInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_CHOOSER_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

interface SelectedFile {
  readonly metadata: YaziPickerFile;
  readonly path: string;
}

interface Session {
  readonly owner: string;
  readonly directory: string;
  readonly chooserPath: string;
  readonly process: PtyAdapter.PtyProcess;
  readonly unsubscribe: Array<() => void>;
  output: string;
  state: YaziPickerPollResult["state"];
  error?: string;
  exitCode?: number;
  files: SelectedFile[];
  lastAccess: number;
}

export class YaziPicker extends Context.Service<
  YaziPicker,
  {
    readonly open: (
      owner: string,
      input: YaziPickerOpenInput,
    ) => Effect.Effect<YaziPickerOpened, YaziPickerError>;
    readonly poll: (
      owner: string,
      input: YaziPickerSessionInput,
    ) => Effect.Effect<YaziPickerPollResult, YaziPickerError>;
    readonly write: (
      owner: string,
      input: YaziPickerWriteInput,
    ) => Effect.Effect<void, YaziPickerError>;
    readonly resize: (
      owner: string,
      input: YaziPickerResizeInput,
    ) => Effect.Effect<void, YaziPickerError>;
    readonly read: (
      owner: string,
      input: YaziPickerReadInput,
    ) => Effect.Effect<YaziPickerReadResult, YaziPickerError>;
    readonly close: (
      owner: string,
      input: YaziPickerSessionInput,
    ) => Effect.Effect<void, YaziPickerError>;
  }
>()("t3/attachments/YaziPicker") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pty = yield* PtyAdapter.PtyAdapter;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const sessions = new Map<string, Session>();
  const lock = Semaphore.makeUnsafe(1);

  const dispose = Effect.fn(function* (id: string, session: Session) {
    sessions.delete(id);
    for (const unsubscribe of session.unsubscribe) unsubscribe();
    if (session.exitCode === undefined) {
      yield* Effect.try(() => session.process.kill()).pipe(Effect.ignore);
    }
    yield* fs.remove(session.directory, { recursive: true, force: true }).pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions, ([id, session]) => dispose(id, session), { discard: true }),
  );
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("1 minute");
      const now = yield* Clock.currentTimeMillis;
      yield* lock.withPermits(1)(
        Effect.forEach(
          [...sessions].filter(([, session]) => now - session.lastAccess >= IDLE_TIMEOUT_MS),
          ([id, session]) => dispose(id, session),
          { discard: true },
        ),
      );
    }
  }).pipe(Effect.forkScoped);

  const getSession = Effect.fn(function* (owner: string, sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.owner !== owner)
      return yield* new YaziPickerError({ reason: "session" });
    session.lastAccess = yield* Clock.currentTimeMillis;
    return session;
  });

  const finish = Effect.fn(function* (session: Session) {
    if (session.state !== "running" || session.exitCode === undefined) return;
    if (session.exitCode !== 0) {
      session.state = "failed";
      session.error = "Yazi exited before completing the file selection.";
      return;
    }
    if (!(yield* fs.exists(session.chooserPath))) {
      session.state = "cancelled";
      return;
    }
    const info = yield* fs.stat(session.chooserPath);
    if (info.type !== "File" || info.size > MAX_CHOOSER_BYTES) {
      return yield* new YaziPickerError({ reason: "selection" });
    }
    const selectedPaths = [
      ...new Set((yield* fs.readFileString(session.chooserPath)).split("\n").filter(Boolean)),
    ];
    if (selectedPaths.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return yield* new YaziPickerError({ reason: "selection" });
    }
    const selected: SelectedFile[] = [];
    for (const selectedPath of selectedPaths) {
      if (!path.isAbsolute(selectedPath))
        return yield* new YaziPickerError({ reason: "selection" });
      const canonicalPath = yield* fs.realPath(selectedPath);
      const info = yield* fs.stat(canonicalPath);
      const mimeType =
        hostPreviewMimeTypeFromExtension(path.extname(selectedPath)) ?? "application/octet-stream";
      const maxBytes = mimeType.startsWith("image/")
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      if (info.type !== "File" || info.size > maxBytes) {
        return yield* new YaziPickerError({ reason: "selection" });
      }
      selected.push({
        path: canonicalPath,
        metadata: {
          id: NodeCrypto.randomUUID(),
          name: path.basename(selectedPath),
          mimeType,
          sizeBytes: Number(info.size),
        },
      });
    }
    session.files = selected;
    session.state = selected.length > 0 ? "completed" : "cancelled";
  });

  return YaziPicker.of({
    open: Effect.fn("YaziPicker.open")(function* (owner, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            sessions.size >= 32 ||
            [...sessions.values()].filter((s) => s.owner === owner).length >= 4
          ) {
            return yield* new YaziPickerError({ reason: "limit" });
          }
          const directory = yield* fs
            .makeTempDirectory({ prefix: "t3-yazi-" })
            .pipe(
              Effect.mapError((cause) => new YaziPickerError({ reason: "unavailable", cause })),
            );
          return yield* Effect.gen(function* () {
            yield* fs.chmod(directory, 0o700);
            const chooserPath = path.join(directory, "selection");
            const process = yield* pty.spawn({
              shell: "yazi",
              args: [home, "--chooser-file", chooserPath],
              cwd: home,
              cols: input.cols,
              rows: input.rows,
              env: { ...environment, TERM: "xterm-256color", COLORTERM: "truecolor" },
            });
            const sessionId = NodeCrypto.randomUUID();
            const session: Session = {
              owner,
              directory,
              chooserPath,
              process,
              unsubscribe: [],
              output: "",
              state: "running",
              files: [],
              lastAccess: yield* Clock.currentTimeMillis,
            };
            sessions.set(sessionId, session);
            session.unsubscribe.push(
              process.onData((data) => {
                if (session.output.length + data.length > MAX_OUTPUT_CHARS) {
                  session.state = "failed";
                  session.error =
                    "Yazi produced too much unread terminal output. Reopen the picker.";
                  try {
                    process.kill();
                  } catch {}
                  return;
                }
                session.output += data;
              }),
            );
            session.unsubscribe.push(
              process.onExit(({ exitCode }) => {
                session.exitCode = exitCode;
              }),
            );
            return { sessionId, homePath: home };
          }).pipe(
            Effect.mapError((cause) => new YaziPickerError({ reason: "unavailable", cause })),
            Effect.onError(() =>
              fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          );
        }),
      );
    }),
    poll: Effect.fn("YaziPicker.poll")(function* (owner, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* getSession(owner, input.sessionId);
          yield* finish(session).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                session.state = "failed";
                session.error =
                  cause instanceof YaziPickerError
                    ? cause.message
                    : new YaziPickerError({ reason: "selection" }).message;
              }),
            ),
          );
          const output = session.output;
          session.output = "";
          return {
            output,
            state: session.state,
            files: session.files.map((f) => f.metadata),
            ...(session.error === undefined ? {} : { error: session.error }),
          };
        }),
      );
    }),
    write: Effect.fn("YaziPicker.write")(function* (owner, input) {
      const session = yield* getSession(owner, input.sessionId);
      if (session.state !== "running" || session.exitCode !== undefined) return;
      yield* Effect.try({
        try: () => session.process.write(input.data),
        catch: (cause) => new YaziPickerError({ reason: "terminal", cause }),
      });
    }),
    resize: Effect.fn("YaziPicker.resize")(function* (owner, input) {
      const session = yield* getSession(owner, input.sessionId);
      if (session.state !== "running" || session.exitCode !== undefined) return;
      yield* Effect.try({
        try: () => session.process.resize(input.cols, input.rows),
        catch: (cause) => new YaziPickerError({ reason: "terminal", cause }),
      });
    }),
    read: Effect.fn("YaziPicker.read")(function* (owner, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* getSession(owner, input.sessionId);
          const selected = session.files.find((file) => file.metadata.id === input.fileId);
          if (
            session.state !== "completed" ||
            !selected ||
            input.offset > selected.metadata.sizeBytes
          ) {
            return yield* new YaziPickerError({ reason: "read" });
          }
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(selected.path, { flag: "r" });
              const info = yield* file.stat;
              if (info.type !== "File" || Number(info.size) !== selected.metadata.sizeBytes) {
                return yield* new YaziPickerError({ reason: "read" });
              }
              yield* file.seek(BigInt(input.offset), "start");
              const buffer = new Uint8Array(
                Math.min(READ_CHUNK_BYTES, selected.metadata.sizeBytes - input.offset),
              );
              const bytesRead = buffer.length === 0 ? 0 : yield* file.read(buffer);
              if (buffer.length > 0 && bytesRead === 0)
                return yield* new YaziPickerError({ reason: "read" });
              return {
                dataBase64: NodeBuffer.Buffer.from(buffer.subarray(0, bytesRead)).toString(
                  "base64",
                ),
                eof: input.offset + bytesRead >= selected.metadata.sizeBytes,
              };
            }),
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof YaziPickerError
                ? cause
                : new YaziPickerError({ reason: "read", cause }),
            ),
          );
        }),
      );
    }),
    close: Effect.fn("YaziPicker.close")(function* (owner, input) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* getSession(owner, input.sessionId);
          yield* dispose(input.sessionId, session);
        }),
      );
    }),
  });
});

export const layer = Layer.effect(YaziPicker, make);
