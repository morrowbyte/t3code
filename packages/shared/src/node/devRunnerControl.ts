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

const ProcessIdentity = Schema.Struct({
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
});
const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(Receipt));
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

const captureIdentity = Effect.fn("devRunnerControl.captureIdentity")(function* (pid: number) {
  const bootId = yield* readBootId();
  if (bootId === undefined) return undefined;
  const start = yield* readProcessStart(pid);
  if (start == null) return undefined;
  const identity = { bootId, pid, start };
  return validIdentity(identity) ? identity : undefined;
});

const isProvenDead = Effect.fn("devRunnerControl.isProvenDead")(function* (
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

export const registerDevRunner = Effect.fn("devRunnerControl.register")(function* (input: {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly reuseKey?: string;
  readonly recoverShare?: (port: number) => Effect.Effect<boolean>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const workspacePath = yield* fs.realPath(input.workspacePath);
  const directory = directoryFor(workspacePath);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const id =
    input.reuseKey === undefined
      ? NodeCrypto.randomBytes(16).toString("hex")
      : NodeCrypto.createHash("sha256")
          .update(JSON.stringify([input.threadId, input.reuseKey]))
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
        connection: response.value.connection,
        beginTeardown: Effect.void,
        prepareChild: Effect.void,
        prepareShare: (_port: number) => Effect.void,
        confirmShareCleared: Effect.void,
        ready: (
          _value: typeof Connection.Type,
          _child?: { readonly pid: number; readonly isRunning: Effect.Effect<boolean, unknown> },
        ) => Effect.void,
        stopRequested: Effect.never,
        confirmStopped: (_stopped: boolean) => Effect.succeed(false),
      };
    if (!(yield* receiptProvenStopped({ ...existing.value, sharePort: undefined })))
      return yield* new DevRunnerControlError({
        operation: "register",
        cause: "Existing runner is not proven stopped",
      });
    previous = contents;
    if (existing.value.sharePort !== undefined) {
      if (input.recoverShare === undefined)
        return yield* new DevRunnerControlError({
          operation: "register",
          cause: `Tailnet cleanup for port ${existing.value.sharePort} has not been confirmed`,
        });
      const recoverShare = input.recoverShare;
      previous = yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                const db = new NodeSqlite.DatabaseSync(
                  NodePath.join(directory, "..", "dev-runner-control.sqlite"),
                );
                try {
                  db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
                  return db;
                } catch (cause) {
                  db.close();
                  throw cause;
                }
              },
              catch: (cause) => new DevRunnerControlError({ operation: "register", cause }),
            }),
            (db) => Effect.sync(() => db.close()),
          );
          yield* Effect.try({
            try: () => {
              const info = NodeFS.lstatSync(receiptPath);
              if (
                !info.isFile() ||
                info.nlink !== 1 ||
                NodeFS.readFileSync(receiptPath, "utf8") !== contents
              )
                throw new Error("Runner receipt changed during share recovery");
            },
            catch: (cause) => new DevRunnerControlError({ operation: "register", cause }),
          });
          if (!(yield* recoverShare(existing.value.sharePort!)))
            return yield* new DevRunnerControlError({
              operation: "register",
              cause: `Tailnet cleanup for port ${existing.value.sharePort} failed`,
            });
          const next = JSON.stringify({ ...existing.value, sharePort: undefined });
          yield* Effect.try({
            try: () => {
              NodeFS.writeFileSync(receiptPath, next, { mode: 0o600 });
              db.exec("COMMIT;");
            },
            catch: (cause) => new DevRunnerControlError({ operation: "register", cause }),
          });
          return next;
        }),
      );
    }
  }
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const sockets = new Set<NodeNet.Socket>();
  const requests = new Set<NodeNet.Socket>();
  let stopping = false;
  let connection: typeof Connection.Type | undefined;
  let isRunning: Effect.Effect<boolean, unknown> | undefined;
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
          `${JSON.stringify({
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
        socket.write(`${JSON.stringify({ token, action: "prepare-stop", accepted: true })}\n`);
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
  let contents = JSON.stringify(receipt);
  const readCurrentReceipt = () => {
    const info = NodeFS.lstatSync(receiptPath);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
      throw new Error("Invalid runner receipt entry");
    return NodeFS.readFileSync(receiptPath, "utf8");
  };
  const updateReceipt = Effect.fn("devRunnerControl.updateReceipt")(function* (
    next: typeof Receipt.Type,
  ) {
    const nextContents = JSON.stringify(next);
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
    beginTeardown: Effect.sync(() => {
      stopping = true;
    }),
    prepareChild: Effect.suspend(() => updateReceipt({ ...receipt, launching: true })),
    prepareShare: (sharePort: number) => updateReceipt({ ...receipt, sharePort }),
    confirmShareCleared: Effect.suspend(() => updateReceipt({ ...receipt, sharePort: undefined })),
    ready: Effect.fn("devRunnerControl.ready")(function* (
      value: typeof Connection.Type,
      child?: { readonly pid: number; readonly isRunning: Effect.Effect<boolean, unknown> },
    ) {
      if (child !== undefined) {
        isRunning = child.isRunning;
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
                socket.end(`${JSON.stringify({ token, action: "stop", accepted: stopped })}\n`);
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
          socket.write(`${JSON.stringify({ receipt, action })}\n`);
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
}) {
  const fs = yield* FileSystem.FileSystem;
  const workspacePath = yield* fs.realPath(input.workspacePath);
  const directory = directoryFor(workspacePath);
  const names = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
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
      if (!(yield* receiptProvenStopped(receipt)) || !(yield* input.canStop)) return false;
      yield* mutateReceipt(
        directory,
        () => {
          const info = NodeFS.lstatSync(receiptPath);
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size > 4096 ||
            NodeFS.readFileSync(receiptPath, "utf8") !== contents
          )
            throw new Error("Runner receipt changed during cleanup");
          NodeFS.unlinkSync(receiptPath);
        },
        "stop",
      );
    }
    stoppedNames.add(name);
  }
  if (names.length === 0) return true;
  const remaining = yield* fs.readDirectory(directory);
  return remaining.every((name) => names.includes(name) && !stoppedNames.has(name));
});
