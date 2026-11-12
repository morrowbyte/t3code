// @effect-diagnostics nodeBuiltinImport:off -- Local dev-runner control uses Node loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "../HostProcess.ts";

export const ProcessIdentity = Schema.Struct({
  bootId: Schema.String,
  pid: Schema.Number,
  start: Schema.String,
});
const Connection = Schema.Struct({
  serverPort: Schema.String,
  webPort: Schema.String,
  baseDir: Schema.String,
  sharedUrl: Schema.optionalKey(Schema.String),
  outputPath: Schema.optionalKey(Schema.String),
});
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  threadId: Schema.String,
  workspacePath: Schema.String,
  token: Schema.String,
  port: Schema.Number,
  owner: Schema.optionalKey(ProcessIdentity),
  launching: Schema.optionalKey(Schema.Boolean),
  child: Schema.optionalKey(ProcessIdentity),
  sharePort: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  shareGeneration: Schema.optionalKey(Schema.String),
});
const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(Receipt));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const withoutShare = ({
  sharePort: _port,
  shareGeneration: _generation,
  ...receipt
}: typeof Receipt.Type) => receipt;
type RuntimeChild = {
  readonly pid: number;
  readonly isRunning: ChildProcessSpawner.ChildProcessHandle["isRunning"];
};
const ControlAction = Schema.Literals(["prepare-stop", "stop", "status"]);
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ receipt: Receipt, action: ControlAction })),
);
const ControlResponse = Schema.Struct({
  token: Schema.String,
  action: ControlAction,
  accepted: Schema.Boolean,
  connection: Schema.optionalKey(Connection),
});
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ControlResponse));
const directoryFor = (workspacePath: string) => NodePath.join(workspacePath, ".t3", "dev-runners");
const validToken = (token: string) => /^[a-f0-9]{64}$/u.test(token);
const validIdentity = (identity: typeof ProcessIdentity.Type) =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(identity.bootId) &&
  Number.isSafeInteger(identity.pid) &&
  identity.pid > 0 &&
  /^\d+$/u.test(identity.start);

export const resolveTaskWorkspace = Effect.fn("devRunnerControl.resolveTaskWorkspace")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  let directory = yield* fs.realPath(cwd);
  for (;;) {
    const git = NodePath.join(directory, ".git");
    const info = (yield* fs.exists(git)) ? yield* fs.stat(git).pipe(Effect.option) : Option.none();
    if (Option.isSome(info)) {
      if (info.value.type === "Directory") return directory;
      if (info.value.type === "File" && /^\s*gitdir:\s*\S/mu.test(yield* fs.readFileString(git)))
        return directory;
      return undefined;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
});

const windowsProcessValue = Effect.fn("devRunnerControl.windowsProcessValue")(function* (
  command: string,
) {
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  if (Option.isNone(spawner)) return undefined;
  return yield* spawner.value
    .string(
      ChildProcess.make("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.map((value) => value.trim()),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => undefined),
    );
});

const readBootId = Effect.fn("devRunnerControl.readBootId")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") {
    const ticks = yield* windowsProcessValue(
      "(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks",
    );
    if (ticks === undefined || !/^\d+$/u.test(ticks)) return undefined;
    const hash = NodeCrypto.createHash("sha256").update(`windows:${ticks}`).digest("hex");
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  }
  if (platform !== "linux") return undefined;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => undefined),
  );
});

const readProcessStart = Effect.fn("devRunnerControl.readProcessStart")(function* (pid: number) {
  if ((yield* HostProcess.Platform) === "win32") {
    const start = yield* windowsProcessValue(
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $process) { 'missing' } else { $process.CreationDate.ToUniversalTime().Ticks }`,
    );
    return start === "missing"
      ? null
      : start !== undefined && /^\d+$/u.test(start)
        ? start
        : undefined;
  }
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`/proc/${pid}/stat`).pipe(
    Effect.map((stat) => {
      const end = stat.lastIndexOf(") ");
      const fields =
        end < 0
          ? []
          : stat
              .slice(end + 2)
              .trim()
              .split(/\s+/u);
      const start = fields[19];
      return stat.startsWith(`${pid} (`) && start !== undefined && /^\d+$/u.test(start)
        ? fields[0] === "Z" || fields[0] === "X"
          ? null
          : start
        : undefined;
    }),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});

export const captureIdentity = Effect.fn("devRunnerControl.captureIdentity")(function* (
  pid: number,
) {
  const bootId = yield* readBootId();
  if (bootId === undefined) return undefined;
  const start = yield* readProcessStart(pid);
  if (start == null) return undefined;
  const identity = { bootId, pid, start };
  return validIdentity(identity) ? identity : undefined;
});

export const isProvenDead = Effect.fn("devRunnerControl.isProvenDead")(function* (
  identity: typeof ProcessIdentity.Type | undefined,
) {
  if (identity === undefined || !validIdentity(identity)) return false;
  const bootId = yield* readBootId();
  if (bootId === undefined || !validIdentity({ ...identity, bootId })) return false;
  if (bootId !== identity.bootId) return true;
  const start = yield* readProcessStart(identity.pid);
  return start === null || (start !== undefined && start !== identity.start);
});

const processGroupExited = Effect.fn("devRunnerControl.processGroupExited")(
  function* (pid: number) {
    if ((yield* HostProcess.Platform) !== "linux") return false;
    const fs = yield* FileSystem.FileSystem;
    for (const name of yield* fs.readDirectory("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      const stat = yield* fs.readFileString(`/proc/${name}/stat`).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (stat === null) continue;
      const end = stat.lastIndexOf(") ");
      const fields =
        end < 0
          ? []
          : stat
              .slice(end + 2)
              .trim()
              .split(/\s+/u);
      const group = fields[2];
      if (!stat.startsWith(`${name} (`) || group === undefined || !/^\d+$/u.test(group))
        return false;
      if (group === String(pid) && fields[0] !== "Z" && fields[0] !== "X") return false;
    }
    return true;
  },
  Effect.orElseSucceed(() => false),
);

const receiptProvenStopped = Effect.fn("devRunnerControl.receiptProvenStopped")(function* (
  receipt: typeof Receipt.Type,
) {
  if (receipt.sharePort !== undefined) return false;
  if (!(yield* isProvenDead(receipt.owner))) return false;
  const bootId = yield* readBootId();
  if (bootId !== undefined && bootId !== receipt.owner?.bootId) return true;
  if (receipt.launching === false) return true;
  return (
    receipt.child !== undefined &&
    (yield* isProvenDead(receipt.child)) &&
    (yield* processGroupExited(receipt.child.pid))
  );
});

// SQLite releases the cross-process mutation lock even after abrupt owner death.
const mutateReceipt = Effect.fn("devRunnerControl.mutateReceipt")(
  (directory: string, mutate: () => void, operation: "register" | "stop" = "register") =>
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(directory, "..", "dev-runner-control.sqlite"),
        );
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
          mutate();
        } finally {
          db.close();
        }
      },
      catch: (cause) => new DevRunnerControlError({ operation, cause }),
    }),
);

export class DevRunnerControlError extends Schema.TaggedError<DevRunnerControlError>()(
  "DevRunnerControlError",
  { operation: Schema.Literals(["register", "stop"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Dev-runner control ${this.operation} failed.`;
  }
}

export const ShareRuntime = Schema.Struct({
  workspacePath: Schema.String,
  id: Schema.String,
  token: Schema.String,
});

export const shareRuntimeStopped = Effect.fn("devRunnerControl.shareRuntimeStopped")(
  function* (runtime: typeof ShareRuntime.Type | undefined, port: number, generation: string) {
    if (runtime === undefined || !/^[a-f0-9]{32}$/u.test(runtime.id) || !validToken(runtime.token))
      return false;
    const fs = yield* FileSystem.FileSystem;
    if ((yield* fs.realPath(runtime.workspacePath)) !== runtime.workspacePath) return false;
    const path = NodePath.join(directoryFor(runtime.workspacePath), `${runtime.id}.json`);
    const read = Effect.try({
      try: () => {
        const info = NodeFS.lstatSync(path);
        return info.isFile() && info.nlink === 1 && info.size <= 4096
          ? NodeFS.readFileSync(path, "utf8")
          : undefined;
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const contents = yield* read;
    const parsed = contents === undefined ? Option.none() : decodeReceipt(contents);
    if (Option.isNone(parsed)) return false;
    const receipt = parsed.value;
    return (
      receipt.workspacePath === runtime.workspacePath &&
      receipt.id === runtime.id &&
      receipt.token === runtime.token &&
      receipt.sharePort === port &&
      receipt.shareGeneration === generation &&
      (yield* receiptProvenStopped(withoutShare(receipt))) &&
      (yield* read) === contents
    );
  },
  Effect.orElseSucceed(() => false),
);

type RecoverShare = (
  port: number,
  generation: string | undefined,
  canRecover: Effect.Effect<boolean>,
) => Effect.Effect<boolean>;

const decodeOutputOwner = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ProcessIdentity)),
);
const encodeOutputOwner = Schema.encodeSync(Schema.fromJsonString(Schema.NullOr(ProcessIdentity)));
const validOutputName = (name: string) => /^runner-[a-zA-Z0-9_-]+\.log$/u.test(name);
const outputFileExists = (directory: string, name: string) => {
  if (!validOutputName(name)) return false;
  const path = NodePath.join(directory, name);
  if (!NodeFS.existsSync(path)) return false;
  const info = NodeFS.lstatSync(path);
  return info.isFile() && info.nlink === 1;
};

const rotateOutputs = (db: NodeSqlite.DatabaseSync, directory: string) => {
  for (const row of db
    .prepare("SELECT name FROM failures ORDER BY id DESC LIMIT -1 OFFSET 8")
    .all()) {
    const name = String(row.name);
    if (outputFileExists(directory, name)) NodeFS.unlinkSync(NodePath.join(directory, name));
    db.prepare("DELETE FROM failures WHERE name = ?").run(name);
  }
};

const withOutputDatabase = Effect.fn("devRunnerControl.withOutputDatabase")(function* <A>(
  workspacePath: string,
  use: (db: NodeSqlite.DatabaseSync, directory: string) => A,
) {
  return yield* Effect.try({
    try: () => {
      const directory = NodePath.join(workspacePath, ".t3", "dev-runner-output");
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = NodePath.join(directory, "failures.sqlite");
      const fd = NodeFS.openSync(path, "a", 0o600);
      NodeFS.closeSync(fd);
      const db = new NodeSqlite.DatabaseSync(path);
      try {
        db.exec(
          "PRAGMA busy_timeout = 5000; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS failures (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL); CREATE TABLE IF NOT EXISTS active_outputs (name TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, owner TEXT NOT NULL);",
        );
        const result = use(db, directory);
        db.exec("COMMIT;");
        return result;
      } finally {
        db.close();
      }
    },
    catch: (cause) => new DevRunnerControlError({ operation: "stop", cause }),
  });
});

export const reconcileDevRunnerOutputs = Effect.fn("devRunnerControl.reconcileOutputs")(
  function* (input: { readonly workspacePath: string; readonly threadId: string }) {
    if (
      !NodeFS.existsSync(
        NodePath.join(input.workspacePath, ".t3", "dev-runner-output", "failures.sqlite"),
      )
    )
      return;
    const rows = yield* withOutputDatabase(input.workspacePath, (db) =>
      db.prepare("SELECT name, owner FROM active_outputs WHERE thread_id = ?").all(input.threadId),
    );
    const dead: Array<{ name: string; owner: string }> = [];
    for (const row of rows) {
      const owner = String(row.owner);
      const parsed = decodeOutputOwner(owner);
      if (Option.isSome(parsed) && parsed.value !== null && (yield* isProvenDead(parsed.value)))
        dead.push({ name: String(row.name), owner });
    }
    yield* withOutputDatabase(input.workspacePath, (db, directory) => {
      for (const row of dead) {
        const removed = db
          .prepare("DELETE FROM active_outputs WHERE name = ? AND owner = ? AND thread_id = ?")
          .run(row.name, row.owner, input.threadId);
        if (Number(removed.changes) !== 0 && outputFileExists(directory, row.name))
          db.prepare("INSERT OR REPLACE INTO failures (name) VALUES (?)").run(row.name);
      }
      rotateOutputs(db, directory);
    });
  },
);

export const createDevRunnerOutput = Effect.fn("devRunnerControl.createOutput")(function* (input: {
  readonly workspacePath: string;
  readonly threadId: string;
}) {
  yield* reconcileDevRunnerOutputs(input);
  const owner = encodeOutputOwner((yield* captureIdentity(process.pid)) ?? null);
  const name = `runner-${NodeCrypto.randomBytes(16).toString("hex")}.log`;
  const path = NodePath.join(input.workspacePath, ".t3", "dev-runner-output", name);
  yield* withOutputDatabase(input.workspacePath, (db) => {
    db.prepare("INSERT INTO active_outputs (name, thread_id, owner) VALUES (?, ?, ?)").run(
      name,
      input.threadId,
      owner,
    );
  });
  // Commit ownership before creating the file so abrupt exit cannot leave an unregistered log.
  yield* Effect.try({
    try: () => NodeFS.writeFileSync(path, new Uint8Array(), { flag: "wx", mode: 0o600 }),
    catch: (cause) => new DevRunnerControlError({ operation: "register", cause }),
  });
  const finish = (failed: boolean) =>
    withOutputDatabase(input.workspacePath, (db, directory) => {
      const row = db
        .prepare("SELECT owner, thread_id FROM active_outputs WHERE name = ?")
        .get(name);
      if (row?.owner !== owner || row.thread_id !== input.threadId) return;
      if (failed && outputFileExists(directory, name)) {
        db.prepare("INSERT OR REPLACE INTO failures (name) VALUES (?)").run(name);
        rotateOutputs(db, directory);
      } else if (!failed && outputFileExists(directory, name)) NodeFS.unlinkSync(path);
      db.prepare("DELETE FROM active_outputs WHERE name = ? AND owner = ? AND thread_id = ?").run(
        name,
        owner,
        input.threadId,
      );
    });
  return { path, fail: finish(true), remove: finish(false) };
});

const recoverStoppedReceipt = Effect.fn("devRunnerControl.recoverStoppedReceipt")(
  function* (input: {
    readonly receiptPath: string;
    readonly contents: string;
    readonly receipt: typeof Receipt.Type;
    readonly canStop: Effect.Effect<boolean>;
    readonly recoverShare?: RecoverShare;
    readonly remove: boolean;
  }) {
    const { receiptPath, contents, receipt } = input;
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const db = new NodeSqlite.DatabaseSync(
                NodePath.join(NodePath.dirname(receiptPath), "..", "dev-runner-control.sqlite"),
              );
              try {
                db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
                return db;
              } catch (cause) {
                db.close();
                throw cause;
              }
            },
            catch: (cause) => new DevRunnerControlError({ operation: "stop", cause }),
          }),
          (db) => Effect.sync(() => db.close()),
        );
        const current = Effect.try({
          try: () => {
            const info = NodeFS.lstatSync(receiptPath);
            return (
              info.isFile() &&
              info.nlink === 1 &&
              info.size <= 4096 &&
              NodeFS.readFileSync(receiptPath, "utf8") === contents
            );
          },
          catch: (cause) => new DevRunnerControlError({ operation: "stop", cause }),
        }).pipe(Effect.orElseSucceed(() => false));
        const canRecover = Effect.gen(function* () {
          return (
            (yield* current) &&
            (yield* receiptProvenStopped(withoutShare(receipt))) &&
            (yield* input.canStop) &&
            (yield* current)
          );
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        if (!(yield* canRecover)) return undefined;
        if (receipt.sharePort !== undefined) {
          if (
            input.recoverShare === undefined ||
            !(yield* input.recoverShare(receipt.sharePort, receipt.shareGeneration, canRecover))
          )
            return undefined;
        }
        if (!(yield* canRecover)) return undefined;
        const next = encodeJson({
          ...receipt,
          sharePort: undefined,
          shareGeneration: undefined,
        });
        yield* Effect.try({
          try: () => {
            if (input.remove) NodeFS.unlinkSync(receiptPath);
            else NodeFS.writeFileSync(receiptPath, next, { mode: 0o600 });
            db.exec("COMMIT;");
          },
          catch: (cause) => new DevRunnerControlError({ operation: "stop", cause }),
        });
        return next;
      }),
    );
  },
);

export const registerDevRunner = Effect.fn("devRunnerControl.register")(function* (input: {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly reuseKey?: string;
  readonly recoverShare?: RecoverShare;
}) {
  const fs = yield* FileSystem.FileSystem;
  const workspacePath =
    (yield* resolveTaskWorkspace(input.workspacePath)) ?? (yield* fs.realPath(input.workspacePath));
  const directory = directoryFor(workspacePath);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const id =
    input.reuseKey === undefined
      ? NodeCrypto.randomBytes(16).toString("hex")
      : NodeCrypto.createHash("sha256")
          .update(encodeJson([input.threadId, input.reuseKey]))
          .digest("hex")
          .slice(0, 32);
  const receiptPath = NodePath.join(directory, `${id}.json`);
  let previous: string | undefined;
  if (input.reuseKey !== undefined && (yield* fs.exists(receiptPath))) {
    const info = yield* fs.stat(receiptPath);
    if (info.type !== "File" || Number(info.size) > 4096)
      return yield* new DevRunnerControlError({
        operation: "register",
        cause: "Invalid runner receipt",
      });
    const contents = yield* fs.readFileString(receiptPath);
    const existing = decodeReceipt(contents);
    if (
      Option.isNone(existing) ||
      existing.value.id !== id ||
      existing.value.threadId !== input.threadId ||
      existing.value.workspacePath !== workspacePath ||
      !validToken(existing.value.token) ||
      !Number.isInteger(existing.value.port) ||
      existing.value.port < 1 ||
      existing.value.port > 65535
    )
      return yield* new DevRunnerControlError({
        operation: "register",
        cause: "Existing runner could not be verified",
      });
    const response = yield* requestControl(existing.value, "status");
    if (
      Option.isSome(response) &&
      response.value.accepted &&
      response.value.connection !== undefined
    )
      return {
        reused: true as const,
        runtime: undefined,
        connection: response.value.connection,
        beginTeardown: Effect.void,
        prepareChild: Effect.void,
        prepareShare: (_port: number, _generation?: string) => Effect.void,
        confirmShareCleared: Effect.void,
        ready: (_value: typeof Connection.Type, _child?: RuntimeChild) => Effect.void,
        stopRequested: Effect.never,
        confirmStopped: (_stopped: boolean) => Effect.succeed(false),
      };
    if (!(yield* receiptProvenStopped(withoutShare(existing.value))))
      return yield* new DevRunnerControlError({
        operation: "register",
        cause: "Existing runner is not proven stopped",
      });
    previous = contents;
    if (existing.value.sharePort !== undefined) {
      previous = yield* recoverStoppedReceipt({
        receiptPath,
        contents,
        receipt: existing.value,
        canStop: Effect.succeed(true),
        ...(input.recoverShare === undefined ? {} : { recoverShare: input.recoverShare }),
        remove: false,
      });
      if (previous === undefined)
        return yield* new DevRunnerControlError({
          operation: "register",
          cause: "Tailnet cleanup could not be confirmed",
        });
    }
  }
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const sockets = new Set<NodeNet.Socket>();
  const requests = new Set<NodeNet.Socket>();
  let stopping = false;
  let connection: typeof Connection.Type | undefined;
  let isRunning: Effect.Effect<boolean> | undefined;
  let confirmedStopped = false;
  let stopRejected = false;
  let requestStop: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      requests.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    socket.setEncoding("utf8");
    let contents = "";
    let prepared = false;
    socket.on("data", (chunk: string) => {
      contents += chunk;
      if (contents.length > 4096) {
        socket.destroy();
        return;
      }
      if (!contents.includes("\n")) return;
      const raw = decodeRequest(contents.trim());
      contents = "";
      if (
        Option.isNone(raw) ||
        raw.value.receipt.id !== id ||
        raw.value.receipt.token !== token ||
        raw.value.receipt.threadId !== input.threadId ||
        raw.value.receipt.workspacePath !== workspacePath ||
        raw.value.receipt.port !== (server.address() as NodeNet.AddressInfo).port
      ) {
        socket.destroy();
        return;
      }
      if (raw.value.action === "status") {
        socket.end(
          `${encodeJson({
            token,
            action: "status",
            accepted: !stopping && connection !== undefined,
            connection,
          })}\n`,
        );
        return;
      }
      if (raw.value.action === "prepare-stop" && !prepared) {
        prepared = true;
        socket.write(`${encodeJson({ token, action: "prepare-stop", accepted: true })}\n`);
        return;
      }
      if (raw.value.action !== "stop" || !prepared) {
        socket.destroy();
        return;
      }
      socket.removeAllListeners("data");
      requests.add(socket);
      stopping = true;
      requestStop();
    });
  });
  const closeServer = Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  yield* Effect.acquireRelease(
    Effect.callback<void, DevRunnerControlError>((resume) => {
      server.once("error", (cause) =>
        resume(Effect.fail(new DevRunnerControlError({ operation: "register", cause }))),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
      return Effect.sync(() => {
        if (!server.listening) server.close();
      });
    }),
    () => closeServer,
  );
  const owner = yield* captureIdentity(NodeProcess.pid);
  let receipt: typeof Receipt.Type = {
    version: 1,
    id,
    threadId: input.threadId,
    workspacePath,
    token,
    port: (server.address() as NodeNet.AddressInfo).port,
    ...(owner === undefined ? {} : { owner }),
    launching: false,
  };
  let contents = encodeJson(receipt);
  const readCurrentReceipt = () => {
    const info = NodeFS.lstatSync(receiptPath);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
      throw new Error("Invalid runner receipt entry");
    return NodeFS.readFileSync(receiptPath, "utf8");
  };
  const updateReceipt = Effect.fn("devRunnerControl.updateReceipt")(function* (
    next: typeof Receipt.Type,
  ) {
    const nextContents = encodeJson(next);
    yield* mutateReceipt(directory, () => {
      if (readCurrentReceipt() !== contents) throw new Error("Runner receipt changed");
      NodeFS.writeFileSync(receiptPath, nextContents, { mode: 0o600 });
      contents = nextContents;
      receipt = next;
    });
  });
  const removeReceipt = mutateReceipt(
    directory,
    () => {
      if (readCurrentReceipt() !== contents) throw new Error("Runner receipt changed");
      NodeFS.unlinkSync(receiptPath);
    },
    "stop",
  );
  yield* Effect.acquireRelease(
    mutateReceipt(directory, () => {
      if (previous !== undefined) {
        if (readCurrentReceipt() !== previous)
          throw new Error("Runner receipt changed during recovery");
        NodeFS.unlinkSync(receiptPath);
      }
      NodeFS.writeFileSync(receiptPath, contents, { flag: "wx", mode: 0o600 });
    }).pipe(Effect.tapError(() => closeServer)),
    () =>
      Effect.gen(function* () {
        if (
          confirmedStopped ||
          receipt.sharePort !== undefined ||
          stopRejected ||
          receipt.launching
        )
          return;
        yield* removeReceipt;
      }).pipe(Effect.ignore),
  );
  return {
    reused: false as const,
    runtime: { workspacePath, id, token },
    beginTeardown: Effect.sync(() => {
      stopping = true;
    }),
    prepareChild: Effect.suspend(() => updateReceipt({ ...receipt, launching: true })),
    prepareShare: (sharePort: number, shareGeneration?: string) =>
      updateReceipt({
        ...withoutShare(receipt),
        sharePort,
        ...(shareGeneration === undefined ? {} : { shareGeneration }),
      }),
    confirmShareCleared: Effect.suspend(() => updateReceipt(withoutShare(receipt))),
    ready: Effect.fn("devRunnerControl.ready")(function* (
      value: typeof Connection.Type,
      child?: RuntimeChild,
    ) {
      if (child !== undefined) {
        isRunning = child.isRunning.pipe(Effect.orElseSucceed(() => true));
        const identity = yield* captureIdentity(child.pid);
        yield* updateReceipt({
          ...receipt,
          launching: true,
          ...(identity === undefined ? {} : { child: identity }),
        });
      }
      connection = value;
    }),
    stopRequested: Effect.promise(() => requested),
    confirmStopped: Effect.fn("devRunnerControl.confirmStopped")(function* (stopped: boolean) {
      stopped =
        stopped &&
        (isRunning === undefined || !(yield* isRunning.pipe(Effect.orElseSucceed(() => true))));
      if (stopped && receipt.sharePort !== undefined && isRunning === undefined)
        yield* updateReceipt({ ...receipt, launching: false });
      stopped = stopped && receipt.sharePort === undefined;
      stopRejected = !stopped;
      if (stopped) {
        yield* removeReceipt;
        confirmedStopped = true;
      }
      yield* Effect.promise(() =>
        Promise.all(
          [...requests].map(
            (socket) =>
              new Promise<void>((resolve) => {
                socket.once("close", resolve);
                socket.end(`${encodeJson({ token, action: "stop", accepted: stopped })}\n`);
              }),
          ),
        ),
      );
      return stopped;
    }),
  };
});

const requestControl = Effect.fn("devRunnerControl.request")(function* (
  receipt: typeof Receipt.Type,
  action: "stop" | "status",
  canStop?: Effect.Effect<boolean>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = NodeNet.createConnection({ host: "127.0.0.1", port: receipt.port });
          socket.on("error", () => socket.destroy());
          socket.setTimeout(10_000, () => socket.destroy());
          socket.setEncoding("utf8");
          return socket;
        }),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      const exchange = (action: typeof ControlAction.Type) =>
        Effect.callback<Option.Option<typeof ControlResponse.Type>>((resume) => {
          let complete = false;
          let contents = "";
          const onFailure = () => finish(Option.none());
          const cleanup = () => {
            socket.off("error", onFailure);
            socket.off("close", onFailure);
            socket.off("data", onData);
          };
          const finish = (response: Option.Option<typeof ControlResponse.Type>) => {
            if (complete) return;
            complete = true;
            cleanup();
            resume(Effect.succeed(response));
          };
          const onData = (chunk: string) => {
            contents += chunk;
            if (contents.length > 4096) return finish(Option.none());
            if (!contents.includes("\n")) return;
            const response = decodeResponse(contents.trim());
            finish(
              Option.isSome(response) &&
                response.value.token === receipt.token &&
                response.value.action === action
                ? response
                : Option.none(),
            );
          };
          if (socket.destroyed) {
            finish(Option.none());
            return;
          }
          socket.once("error", onFailure);
          socket.once("close", onFailure);
          socket.on("data", onData);
          socket.write(`${encodeJson({ receipt, action })}\n`);
          return Effect.sync(cleanup);
        });
      if (action === "stop") {
        const prepared = yield* exchange("prepare-stop");
        if (Option.isNone(prepared) || !prepared.value.accepted || canStop === undefined)
          return Option.none<typeof ControlResponse.Type>();
        if (!(yield* canStop)) return Option.none<typeof ControlResponse.Type>();
      }
      return yield* exchange(action);
    }),
  );
});

export const stopDevRunners = Effect.fn("devRunnerControl.stop")(function* (input: {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly canStop: Effect.Effect<boolean>;
  readonly recoverShare?: RecoverShare;
}) {
  const fs = yield* FileSystem.FileSystem;
  const workspacePath =
    (yield* resolveTaskWorkspace(input.workspacePath)) ?? (yield* fs.realPath(input.workspacePath));
  const directory = directoryFor(workspacePath);
  const names = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(Array<string>()),
    ),
  );
  const stoppedNames = new Set<string>();
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) return false;
    const receiptPath = NodePath.join(directory, name);
    const info = yield* fs.stat(receiptPath);
    if (info.type !== "File" || Number(info.size) > 4096) return false;
    const contents = yield* fs.readFileString(receiptPath);
    const raw = decodeReceipt(contents);
    if (Option.isNone(raw)) return false;
    const receipt = raw.value;
    if (
      receipt.workspacePath !== workspacePath ||
      !validToken(receipt.token) ||
      name !== `${receipt.id}.json` ||
      !Number.isInteger(receipt.port) ||
      receipt.port < 1 ||
      receipt.port > 65535
    )
      return false;
    if (receipt.threadId !== input.threadId) continue;
    if (!(yield* input.canStop)) return false;
    const response = yield* requestControl(receipt, "stop", input.canStop);
    if (Option.isNone(response) || !response.value.accepted) {
      if (
        (yield* recoverStoppedReceipt({
          receiptPath,
          contents,
          receipt,
          canStop: input.canStop,
          ...(input.recoverShare === undefined ? {} : { recoverShare: input.recoverShare }),
          remove: true,
        })) === undefined
      )
        return false;
    }
    stoppedNames.add(name);
  }
  if (names.length !== 0) {
    const remaining = yield* fs.readDirectory(directory);
    if (!remaining.every((name) => names.includes(name) && !stoppedNames.has(name))) return false;
  }
  if (!(yield* input.canStop)) return false;
  yield* reconcileDevRunnerOutputs({ workspacePath, threadId: input.threadId });
  return true;
});
