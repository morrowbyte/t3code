// @effect-diagnostics nodeBuiltinImport:off -- Local dev-runner control uses Node loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  threadId: Schema.String,
  workspacePath: Schema.String,
  token: Schema.String,
  port: Schema.Number,
});
const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(Receipt));
const ControlAction = Schema.Literals(["stop", "status"]);
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ receipt: Receipt, action: ControlAction })),
);
const decodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ token: Schema.String, action: ControlAction, accepted: Schema.Boolean }),
  ),
);
const directoryFor = (workspacePath: string) => NodePath.join(workspacePath, ".t3", "dev-runners");
const validToken = (token: string) => /^[a-f0-9]{64}$/u.test(token);

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
  if (input.reuseKey !== undefined && (yield* fs.exists(receiptPath))) {
    const existing = decodeReceipt(yield* fs.readFileString(receiptPath));
    if (
      Option.isNone(existing) ||
      existing.value.id !== id ||
      existing.value.threadId !== input.threadId ||
      existing.value.workspacePath !== workspacePath ||
      !validToken(existing.value.token) ||
      !Number.isInteger(existing.value.port) ||
      existing.value.port < 1 ||
      existing.value.port > 65535 ||
      !(yield* requestControl(existing.value, "status"))
    )
      return yield* new DevRunnerControlError({
        operation: "register",
        cause: "Existing runner could not be verified",
      });
    return {
      reused: true as const,
      stopRequested: Effect.never,
      confirmStopped: (_stopped: boolean) => Effect.void,
    };
  }
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const sockets = new Set<NodeNet.Socket>();
  const requests = new Set<NodeNet.Socket>();
  let stopping = false;
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
    socket.on("data", (chunk: string) => {
      contents += chunk;
      if (contents.length > 4096) {
        socket.destroy();
        return;
      }
      if (!contents.includes("\n")) return;
      socket.removeAllListeners("data");
      const raw = decodeRequest(contents.trim());
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
        socket.end(`${JSON.stringify({ token, action: "status", accepted: !stopping })}\n`);
        return;
      }
      requests.add(socket);
      stopping = true;
      requestStop();
    });
  });
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
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      ),
  );
  const receipt = {
    version: 1,
    id,
    threadId: input.threadId,
    workspacePath,
    token,
    port: (server.address() as NodeNet.AddressInfo).port,
  } as const;
  const contents = JSON.stringify(receipt);
  yield* Effect.acquireRelease(
    fs.writeFileString(receiptPath, contents, { flag: "wx", mode: 0o600 }),
    () =>
      fs.readFileString(receiptPath).pipe(
        Effect.flatMap((current) => (current === contents ? fs.remove(receiptPath) : Effect.void)),
        Effect.ignore,
      ),
  );
  return {
    reused: false as const,
    stopRequested: Effect.promise(() => requested),
    confirmStopped: Effect.fn("devRunnerControl.confirmStopped")(function* (stopped: boolean) {
      if (stopped) {
        const current = yield* fs.readFileString(receiptPath);
        if (current !== contents) {
          return yield* new DevRunnerControlError({
            operation: "stop",
            cause: "Runner receipt changed",
          });
        }
        yield* fs.remove(receiptPath);
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
    }),
  };
});

const requestControl = Effect.fn("devRunnerControl.request")(function* (
  receipt: typeof Receipt.Type,
  action: typeof ControlAction.Type,
) {
  return yield* Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port: receipt.port });
    let complete = false;
    const finish = (stopped: boolean) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resume(Effect.succeed(stopped));
    };
    socket.setTimeout(10_000, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ receipt, action })}\n`));
    socket.setEncoding("utf8");
    let contents = "";
    socket.on("data", (chunk: string) => {
      contents += chunk;
      if (contents.length > 4096) {
        finish(false);
        return;
      }
      if (!contents.includes("\n")) return;
      const response = decodeResponse(contents.trim());
      finish(
        Option.isSome(response) &&
          response.value.token === receipt.token &&
          response.value.action === action &&
          response.value.accepted,
      );
    });
    return Effect.sync(() => socket.destroy());
  });
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
    const raw = decodeReceipt(yield* fs.readFileString(receiptPath));
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
    if (!(yield* input.canStop) || !(yield* requestControl(receipt, "stop"))) return false;
    stoppedNames.add(name);
  }
  if (names.length === 0) return true;
  const remaining = yield* fs.readDirectory(directory);
  return remaining.every((name) => names.includes(name) && !stoppedNames.has(name));
});
