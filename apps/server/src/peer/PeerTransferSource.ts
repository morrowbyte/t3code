// @effect-diagnostics nodeBuiltinImport:off -- Unix sockets, exclusive files and streaming SHA-256 are native boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SLOTS = 4;
const WAIT_MS = 120_000;
const HEADER_MAX = 160;

type Key = {
  readonly callerNamespace: string;
  readonly clientRequestId: string;
  readonly target: string;
};
type Status =
  | { readonly state: "waiting" | "receiving" | "failed" | "interrupted" }
  | { readonly state: "ready"; readonly sizeBytes: number; readonly sha256: string };

export class PeerTransferSourceError extends Schema.TaggedError<PeerTransferSourceError>()(
  "PeerTransferSourceError",
  {
    reason: Schema.Literals([
      "invalid",
      "limit",
      "not_found",
      "busy",
      "interrupted",
      "denied",
      "integrity",
      "storage",
      "platform_unsupported",
    ]),
  },
) {
  override get message() {
    return `Source staging failed: ${this.reason}.`;
  }
}

export class PeerTransferSource extends Context.Service<
  PeerTransferSource,
  {
    readonly prepare: (
      key: Key,
      authorize: () => Promise<boolean>,
    ) => Effect.Effect<
      { readonly socketPath: string; readonly tokenPath: string },
      PeerTransferSourceError
    >;
    readonly status: (key: Key) => Effect.Effect<Status, PeerTransferSourceError>;
    readonly resolve: (
      key: Key,
    ) => Effect.Effect<
      { readonly path: string; readonly sizeBytes: number; readonly sha256: string },
      PeerTransferSourceError
    >;
    readonly withTransfer: <A, E, R>(
      key: Key,
      use: (source: {
        readonly path: string;
        readonly sizeBytes: number;
        readonly sha256: string;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PeerTransferSourceError, R>;
    readonly withRelease: <A, E, R>(
      key: Key,
      release: () => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PeerTransferSourceError, R>;
    readonly abort: (key: Key) => Effect.Effect<void, PeerTransferSourceError>;
    readonly cleanup: (key: Key) => Effect.Effect<void, PeerTransferSourceError>;
  }
>()("t3/peer/PeerTransferSource") {}

class Failure extends Error {
  readonly reason: PeerTransferSourceError["reason"];

  constructor(reason: PeerTransferSourceError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
const fail = (reason: PeerTransferSourceError["reason"]): never => {
  throw new Failure(reason);
};
const idOf = (key: Key) => {
  if (
    typeof key.callerNamespace !== "string" ||
    key.callerNamespace.length < 1 ||
    key.callerNamespace.length > 1024 ||
    typeof key.clientRequestId !== "string" ||
    key.clientRequestId.length < 1 ||
    key.clientRequestId.length > 256 ||
    typeof key.target !== "string" ||
    key.target.length < 1 ||
    key.target.length > 512
  )
    fail("invalid");
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([key.callerNamespace, key.clientRequestId, key.target]))
    .digest("hex")
    .slice(0, 32);
};
const exists = async (path: string) => {
  try {
    return await NodeFSP.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
const privateDirectory = async (path: string) => {
  await NodeFSP.mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await NodeFSP.lstat(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    process.getuid === undefined ||
    stat.uid !== process.getuid()
  )
    fail("storage");
};

type Session = {
  readonly dir: string;
  readonly socketPath: string;
  readonly socketDirectory: string;
  readonly tokenPath: string;
  readonly part: string;
  readonly final: string;
  readonly slot: string;
  readonly server: NodeNet.Server;
  readonly lease: NodeSqlite.DatabaseSync;
  authorize: () => Promise<boolean>;
  worker?: Promise<void>;
  socket?: NodeNet.Socket;
  timer?: NodeJS.Timeout;
  state: "waiting" | "receiving" | "publishing" | "ready" | "failed";
  users: number;
  sizeBytes?: number;
  sha256?: string;
};

const make = Effect.fn("PeerTransferSource.make")(function* (configuration: {
  readonly directory: string;
}) {
  const platform = yield* HostProcess.Platform;
  const root = NodePath.resolve(configuration.directory);
  const slots = NodePath.join(root, "slots");
  const socketDirectoryOf = (id: string) =>
    NodePath.join(
      "/tmp",
      `t3s-${NodeCrypto.createHash("sha256")
        .update(JSON.stringify([root, id]))
        .digest("hex")
        .slice(0, 32)}`,
    );
  const sessions = new Map<string, Session>();
  const releasing = new Set<string>();
  const gate = Semaphore.makeUnsafe(1);
  const checkPlatform = () => {
    if (platform === "win32" || process.getuid === undefined) fail("platform_unsupported");
  };
  const base = async () => {
    checkPlatform();
    await privateDirectory(root);
    await privateDirectory(slots);
  };
  const withRootLock = async <A>(operation: () => Promise<A>): Promise<A> => {
    const lock = new NodeSqlite.DatabaseSync(NodePath.join(root, "metadata.db"));
    try {
      try {
        lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      } catch {
        return fail("busy");
      }
      await NodeFSP.chmod(NodePath.join(root, "metadata.db"), 0o600);
      return await operation();
    } finally {
      lock.close();
    }
  };
  const safeError = (error: unknown) =>
    new PeerTransferSourceError({ reason: error instanceof Failure ? error.reason : "storage" });
  const close = (session: Session) => {
    if (session.timer) clearTimeout(session.timer);
    session.server.close();
    session.socket?.destroy();
  };
  const removeIfPresent = (path: string) =>
    NodeFSP.unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  const eraseTransient = async (session: Session) => {
    await Promise.all([removeIfPresent(session.socketPath), removeIfPresent(session.part)]);
    await NodeFSP.rmdir(session.socketDirectory).catch(() => undefined);
  };
  const receive = async (session: Session, socket: NodeNet.Socket, token: Buffer) => {
    let handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
    let valid = false;
    let size = -1;
    let expectedHash = "";
    let received = 0;
    let header = Buffer.alloc(0);
    const hash = NodeCrypto.createHash("sha256");
    const write = async (chunk: Buffer) => {
      if (received + chunk.length > MAX_BYTES) fail("limit");
      if (received + chunk.length > size) fail("integrity");
      let written = 0;
      while (written < chunk.length) {
        const result = await handle!.write(chunk, written, chunk.length - written);
        if (result.bytesWritten === 0) fail("storage");
        written += result.bytesWritten;
      }
      received += chunk.length;
      hash.update(chunk);
    };
    try {
      if (!(await session.authorize().catch(() => false))) fail("denied");
      if (session.state !== "receiving") fail("interrupted");
      handle = await NodeFSP.open(session.part, "wx", 0o600);
      for await (const item of socket.iterator({ destroyOnReturn: false })) {
        const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
        if (!valid) {
          const lineEnd = chunk.indexOf(10);
          if (lineEnd === -1) {
            if (header.length + chunk.length > HEADER_MAX) fail("invalid");
            header = Buffer.concat([header, chunk]);
            continue;
          }
          if (header.length + lineEnd > HEADER_MAX) fail("invalid");
          header = Buffer.concat([header, chunk.subarray(0, lineEnd)]);
          const match = /^([a-f0-9]{64}) (0|[1-9][0-9]{0,7}) ([a-f0-9]{64})$/.exec(
            header.toString("ascii"),
          );
          if (!match || !NodeCrypto.timingSafeEqual(Buffer.from(match[1]!, "hex"), token))
            throw new Failure("invalid");
          size = Number(match[2]);
          if (!Number.isSafeInteger(size) || size > MAX_BYTES) fail("limit");
          expectedHash = match[3]!;
          valid = true;
          await write(chunk.subarray(lineEnd + 1));
        } else await write(chunk);
      }
      if (!valid) fail("invalid");
      if (received !== size || hash.digest("hex") !== expectedHash) fail("integrity");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (!(await session.authorize().catch(() => false))) fail("denied");
      if (session.state !== "receiving") fail("interrupted");
      session.state = "publishing";
      await NodeFSP.link(session.part, session.final);
      await removeIfPresent(session.part);
      session.sizeBytes = size;
      session.sha256 = expectedHash;
      session.state = "ready";
      socket.end("ok\n");
    } catch (error) {
      if (session.state !== "ready") session.state = "failed";
      await handle?.close().catch(() => undefined);
      await eraseTransient(session).catch(() => undefined);
      const reason =
        error instanceof Failure
          ? error.reason === "interrupted"
            ? "aborted"
            : error.reason
          : "storage";
      if (!socket.destroyed) socket.end(`error:${reason}\n`);
    } finally {
      if (session.timer) clearTimeout(session.timer);
      session.server.close();
      await removeIfPresent(session.socketPath).catch(() => undefined);
      await NodeFSP.rmdir(session.socketDirectory).catch(() => undefined);
    }
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const session of sessions.values()) {
        if (session.state === "waiting" || session.state === "receiving") session.state = "failed";
        close(session);
      }
      for (const session of sessions.values()) {
        await session.worker?.catch(() => undefined);
        session.lease.close();
      }
    }),
  );

  const prepare: PeerTransferSource["Service"]["prepare"] = Effect.fn("PeerTransferSource.prepare")(
    (key, authorize) =>
      gate.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const id = idOf(key);
            await base();
            if (releasing.has(id)) fail("busy");
            return withRootLock(async () => {
              const old = sessions.get(id);
              if (old) {
                if (old.state !== "waiting" && old.state !== "receiving")
                  fail(old.state === "ready" ? "busy" : "interrupted");
                old.authorize = authorize;
                return { socketPath: old.socketPath, tokenPath: old.tokenPath };
              }
              const dir = NodePath.join(root, id);
              if (await exists(dir)) fail("interrupted");
              await NodeFSP.mkdir(dir, { mode: 0o700 });
              const tokenPath = NodePath.join(dir, "token");
              const socketDirectory = socketDirectoryOf(id);
              const leasePath = NodePath.join(dir, "lease.db");
              let lease: NodeSqlite.DatabaseSync | undefined;
              const socketPath = NodePath.join(socketDirectory, "s");
              const part = NodePath.join(dir, "part");
              const final = NodePath.join(dir, "file");
              let slot: string | undefined;
              let server: NodeNet.Server | undefined;
              try {
                lease = new NodeSqlite.DatabaseSync(leasePath);
                lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
                await NodeFSP.chmod(leasePath, 0o600);
                await NodeFSP.mkdir(socketDirectory, { mode: 0o700 });
                const token = NodeCrypto.randomBytes(32);
                await NodeFSP.writeFile(tokenPath, token.toString("hex"), {
                  flag: "wx",
                  mode: 0o600,
                });
                for (let i = 0; i < MAX_SLOTS; i++) {
                  const candidate = NodePath.join(slots, String(i));
                  try {
                    await NodeFSP.link(tokenPath, candidate);
                    slot = candidate;
                    break;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                  }
                }
                if (!slot) throw new Failure("limit");
                server = NodeNet.createServer({ allowHalfOpen: true });
                const session: Session = {
                  dir,
                  socketPath,
                  socketDirectory,
                  tokenPath,
                  part,
                  final,
                  slot,
                  server,
                  lease,
                  authorize,
                  state: "waiting",
                  users: 0,
                };
                server.on("connection", (socket) => {
                  if (session.state !== "waiting") {
                    socket.destroy();
                    return;
                  }
                  session.state = "receiving";
                  session.socket = socket;
                  server!.close();
                  session.worker = receive(session, socket, token);
                });
                await new Promise<void>((resolve, reject) => {
                  server!.once("error", reject);
                  server!.listen(socketPath, () => {
                    server!.off("error", reject);
                    resolve();
                  });
                });
                await NodeFSP.chmod(socketPath, 0o600);
                server.unref();
                // @effect-diagnostics-next-line globalTimers:off -- The Node socket session owns and clears this deadline.
                session.timer = setTimeout(() => {
                  if (session.state === "waiting" || session.state === "receiving") {
                    session.state = "failed";
                    close(session);
                    void eraseTransient(session).catch(() => undefined);
                  }
                }, WAIT_MS);
                session.timer.unref();
                sessions.set(id, session);
                return { socketPath, tokenPath };
              } catch (error) {
                server?.close();
                lease?.close();
                await removeIfPresent(socketPath).catch(() => undefined);
                await NodeFSP.rmdir(socketDirectory).catch(() => undefined);
                if (slot) await removeIfPresent(slot).catch(() => undefined);
                await removeIfPresent(tokenPath).catch(() => undefined);
                await removeIfPresent(leasePath).catch(() => undefined);
                await NodeFSP.rmdir(dir).catch(() => undefined);
                throw error;
              }
            });
          },
          catch: safeError,
        }),
      ),
  );

  const status: PeerTransferSource["Service"]["status"] = Effect.fn("PeerTransferSource.status")(
    (key) =>
      gate.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const id = idOf(key);
            await base();
            if (releasing.has(id)) fail("busy");
            const session = sessions.get(id);
            if (!session) {
              if (await exists(NodePath.join(root, id))) return { state: "interrupted" } as const;
              return fail("not_found");
            }
            if (await exists(NodePath.join(session.dir, "released")))
              return { state: "interrupted" } as const;
            if (session.state === "ready")
              return {
                state: "ready",
                sizeBytes: session.sizeBytes!,
                sha256: session.sha256!,
              } as const;
            return {
              state: session.state === "publishing" ? "receiving" : session.state,
            } as Status;
          },
          catch: safeError,
        }),
      ),
  );

  const resolveAndClaim = Effect.fn("PeerTransferSource.resolve")((key: Key, claim: boolean) =>
    gate.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          const id = idOf(key);
          await base();
          if (releasing.has(id)) fail("busy");
          const session = sessions.get(id);
          if (!session)
            return fail((await exists(NodePath.join(root, id))) ? "interrupted" : "not_found");
          if (await exists(NodePath.join(session.dir, "released"))) return fail("interrupted");
          if (session.state !== "ready") return fail("busy");
          const stat = await NodeFSP.lstat(session.final);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== session.sizeBytes)
            fail("storage");
          if (claim) session.users += 1;
          return { path: session.final, sizeBytes: session.sizeBytes!, sha256: session.sha256! };
        },
        catch: safeError,
      }),
    ),
  );

  const resolve: PeerTransferSource["Service"]["resolve"] = (key) => resolveAndClaim(key, false);
  const withTransfer: PeerTransferSource["Service"]["withTransfer"] = (key, use) =>
    Effect.acquireUseRelease(resolveAndClaim(key, true), use, () =>
      Effect.sync(() => {
        const session = sessions.get(idOf(key));
        if (session) session.users -= 1;
      }),
    );

  const recover = async (id: string, releaseReady: boolean) => {
    const dir = NodePath.join(root, id);
    const dirStat = await exists(dir);
    if (!dirStat) return;
    if (
      !dirStat.isDirectory() ||
      (dirStat.mode & 0o077) !== 0 ||
      dirStat.uid !== process.getuid?.()
    )
      fail("storage");
    const leasePath = NodePath.join(dir, "lease.db");
    const released = await exists(NodePath.join(dir, "released"));
    if (released && (!released.isFile() || released.nlink !== 1)) fail("storage");
    let leaseStat = await exists(leasePath);
    if (!leaseStat && released && releaseReady) {
      const created = await NodeFSP.open(leasePath, "wx", 0o600);
      await created.close();
      leaseStat = await NodeFSP.lstat(leasePath);
    }
    if (!leaseStat) {
      if (releaseReady || (await NodeFSP.readdir(dir)).length !== 0) fail("interrupted");
      const created = await NodeFSP.open(leasePath, "wx", 0o600);
      await created.close();
      const recoveryLease = new NodeSqlite.DatabaseSync(leasePath);
      try {
        try {
          recoveryLease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        } catch {
          return fail("busy");
        }
      } finally {
        recoveryLease.close();
      }
      const entries = await NodeFSP.readdir(dir);
      if (entries.length !== 1 || entries[0] !== "lease.db") fail("interrupted");
      await NodeFSP.unlink(leasePath);
      await NodeFSP.rmdir(dir);
      return;
    }
    if (!leaseStat.isFile() || leaseStat.nlink !== 1) fail("interrupted");
    const lease = new NodeSqlite.DatabaseSync(leasePath);
    try {
      try {
        lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      } catch {
        return fail("busy");
      }
      const final = NodePath.join(dir, "file");
      const finalStat = await exists(final);
      if (finalStat && !releaseReady) fail("busy");
      if (
        releaseReady &&
        ((!finalStat && !released) || (finalStat && (!finalStat.isFile() || finalStat.nlink !== 1)))
      )
        fail("storage");
      const token = NodePath.join(dir, "token");
      const tokenStat = await exists(token);
      if (tokenStat && !tokenStat.isFile()) fail("storage");
      const socketDir = socketDirectoryOf(id);
      const socketDirStat = await exists(socketDir);
      if (socketDirStat) {
        if (
          !socketDirStat.isDirectory() ||
          (socketDirStat.mode & 0o077) !== 0 ||
          socketDirStat.uid !== process.getuid?.()
        )
          fail("storage");
        const socketPath = NodePath.join(socketDir, "s");
        const socketStat = await exists(socketPath);
        if (socketStat && !socketStat.isSocket()) fail("storage");
        await removeIfPresent(socketPath);
        await NodeFSP.rmdir(socketDir);
      }
      if (releaseReady) await removeIfPresent(final);
      await removeIfPresent(NodePath.join(dir, "part"));
      if (tokenStat) {
        for (let i = 0; i < MAX_SLOTS; i++) {
          const slot = NodePath.join(slots, String(i));
          const slotStat = await exists(slot);
          if (slotStat && slotStat.dev === tokenStat.dev && slotStat.ino === tokenStat.ino)
            await removeIfPresent(slot);
        }
      }
      await removeIfPresent(token);
    } finally {
      lease.close();
    }
    await removeIfPresent(leasePath);
    if (released) await removeIfPresent(NodePath.join(dir, "released"));
    await NodeFSP.rmdir(dir);
  };

  const abort: PeerTransferSource["Service"]["abort"] = Effect.fn("PeerTransferSource.abort")(
    (key) =>
      gate.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const id = idOf(key);
            await base();
            if (releasing.has(id)) fail("busy");
            return withRootLock(async () => {
              const session = sessions.get(id);
              if (!session) return recover(id, false);
              if (session.users > 0 || session.state === "publishing" || session.state === "ready")
                return fail("busy");
              session.state = "failed";
              close(session);
              await eraseTransient(session);
              await session.worker?.catch(() => undefined);
              const tokenStat = await NodeFSP.lstat(session.tokenPath);
              const slotStat = await NodeFSP.lstat(session.slot);
              if (tokenStat.dev !== slotStat.dev || tokenStat.ino !== slotStat.ino) fail("storage");
              await removeIfPresent(session.slot);
              await removeIfPresent(session.tokenPath);
              session.lease.close();
              await removeIfPresent(NodePath.join(session.dir, "lease.db"));
              await NodeFSP.rmdir(session.dir);
              sessions.delete(id);
            });
          },
          catch: safeError,
        }),
      ),
  );
  const cleanupLocked = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return recover(id, true);
    if (session.state !== "ready" || session.users > 0) return fail("busy");
    const released = await exists(NodePath.join(session.dir, "released"));
    if (released && (!released.isFile() || released.nlink !== 1)) fail("storage");
    const stat = await exists(session.final);
    if ((!stat && !released) || (stat && (!stat.isFile() || stat.nlink !== 1))) fail("storage");
    const tokenStat = await exists(session.tokenPath);
    const slotStat = await exists(session.slot);
    if (!released && (!tokenStat || !slotStat)) fail("storage");
    if (
      slotStat &&
      (!tokenStat || tokenStat.dev !== slotStat.dev || tokenStat.ino !== slotStat.ino)
    )
      fail("storage");
    await removeIfPresent(session.final);
    await removeIfPresent(session.slot);
    await removeIfPresent(session.tokenPath);
    await session.worker?.catch(() => undefined);
    session.lease.close();
    sessions.delete(id);
    await removeIfPresent(NodePath.join(session.dir, "lease.db"));
    if (released) await removeIfPresent(NodePath.join(session.dir, "released"));
    await NodeFSP.rmdir(session.dir);
  };

  const cleanup: PeerTransferSource["Service"]["cleanup"] = Effect.fn("PeerTransferSource.cleanup")(
    (key) =>
      gate.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const id = idOf(key);
            await base();
            if (releasing.has(id)) fail("busy");
            return withRootLock(() => cleanupLocked(id));
          },
          catch: safeError,
        }),
      ),
  );
  const withRelease: PeerTransferSource["Service"]["withRelease"] = (key, release) =>
    Effect.acquireUseRelease(
      gate.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const id = idOf(key);
            await base();
            if (releasing.has(id)) fail("busy");
            return withRootLock(async () => {
              const session = sessions.get(id);
              const dir = NodePath.join(root, id);
              let recoveryLease: NodeSqlite.DatabaseSync | undefined;
              let created = false;
              try {
                if (session) {
                  if (session.state !== "ready" || session.users > 0) fail("busy");
                  const released = await exists(NodePath.join(dir, "released"));
                  if (released && (!released.isFile() || released.nlink !== 1)) fail("storage");
                  const stat = await exists(session.final);
                  if ((!stat && !released) || (stat && (!stat.isFile() || stat.nlink !== 1)))
                    fail("storage");
                  const tokenStat = await exists(session.tokenPath);
                  const slotStat = await exists(session.slot);
                  if (
                    (!released && (!tokenStat || !slotStat)) ||
                    (slotStat &&
                      (!tokenStat ||
                        tokenStat.dev !== slotStat.dev ||
                        tokenStat.ino !== slotStat.ino))
                  )
                    fail("storage");
                } else {
                  const dirStat = await exists(dir);
                  if (!dirStat) {
                    await NodeFSP.mkdir(dir, { mode: 0o700 });
                    created = true;
                  } else if (
                    !dirStat.isDirectory() ||
                    (dirStat.mode & 0o077) !== 0 ||
                    dirStat.uid !== process.getuid?.()
                  )
                    fail("storage");
                  const leasePath = NodePath.join(dir, "lease.db");
                  const released = await exists(NodePath.join(dir, "released"));
                  if (released && (!released.isFile() || released.nlink !== 1)) fail("storage");
                  const final = await exists(NodePath.join(dir, "file"));
                  const entries = !created && !released && !final ? await NodeFSP.readdir(dir) : [];
                  if (!created && !released && !final && entries.length === 0) created = true;
                  const orphanLease =
                    !created &&
                    !released &&
                    !final &&
                    entries.length === 1 &&
                    entries[0] === "lease.db";
                  if (
                    !created &&
                    !orphanLease &&
                    ((!final && !released) || (final && (!final.isFile() || final.nlink !== 1)))
                  )
                    fail("storage");
                  let stat = await exists(leasePath);
                  if (!stat && (created || released)) {
                    const file = await NodeFSP.open(leasePath, "wx", 0o600);
                    await file.close();
                    stat = await NodeFSP.lstat(leasePath);
                  }
                  if (!stat?.isFile() || stat.nlink !== 1) fail("storage");
                  recoveryLease = new NodeSqlite.DatabaseSync(leasePath);
                  try {
                    recoveryLease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
                  } catch {
                    fail("busy");
                  }
                  if (orphanLease) created = true;
                }
                releasing.add(id);
                return { id, dir, recoveryLease, created };
              } catch (error) {
                recoveryLease?.close();
                if (created) {
                  await removeIfPresent(NodePath.join(dir, "lease.db")).catch(() => undefined);
                  await NodeFSP.rmdir(dir).catch(() => undefined);
                }
                throw error;
              }
            });
          },
          catch: safeError,
        }),
      ),
      (reservation) =>
        release().pipe(
          Effect.tap(() =>
            gate.withPermits(1)(
              Effect.tryPromise({
                try: async () =>
                  withRootLock(async () => {
                    const marker = NodePath.join(reservation.dir, "released");
                    try {
                      const file = await NodeFSP.open(marker, "wx", 0o600);
                      await file.close();
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                      const stat = await NodeFSP.lstat(marker);
                      if (!stat.isFile() || stat.nlink !== 1) fail("storage");
                    }
                    const markerFile = await NodeFSP.open(marker, "r");
                    try {
                      await markerFile.sync();
                    } finally {
                      await markerFile.close();
                    }
                    const directory = await NodeFSP.open(reservation.dir, "r");
                    try {
                      await directory.sync();
                    } finally {
                      await directory.close();
                    }
                    reservation.recoveryLease?.close();
                    reservation.recoveryLease = undefined;
                    await cleanupLocked(reservation.id);
                    reservation.created = false;
                  }),
                catch: safeError,
              }),
            ),
          ),
        ),
      (reservation) =>
        gate.withPermits(1)(
          Effect.promise(async () => {
            if (
              reservation.created &&
              !(await exists(NodePath.join(reservation.dir, "released")))
            ) {
              await withRootLock(async () => {
                reservation.recoveryLease?.close();
                reservation.recoveryLease = undefined;
                await removeIfPresent(NodePath.join(reservation.dir, "lease.db"));
                await NodeFSP.rmdir(reservation.dir);
              }).catch(() => undefined);
            }
            reservation.recoveryLease?.close();
            releasing.delete(reservation.id);
          }),
        ),
    );
  return PeerTransferSource.of({
    prepare,
    status,
    resolve,
    withTransfer,
    withRelease,
    abort,
    cleanup,
  });
});

export const layer = (configuration: { readonly directory: string }) =>
  Layer.effect(PeerTransferSource, make(configuration));
