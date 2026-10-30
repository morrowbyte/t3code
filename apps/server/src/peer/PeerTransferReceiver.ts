// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
export const MAX_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const MAX_INCOMPLETE_TRANSFERS = 4;
const MAX_INCOMPLETE_BYTES = 100 * 1024 * 1024;
export const MAX_TRANSFER_RECORDS = 32;
const MAX_STAGING_BYTES = 200 * 1024 * 1024;
export const MAX_TRANSFER_TOMBSTONES = 256;
const RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type TransferKey = {
  readonly owner: string;
  readonly target: string;
  readonly requestId: string;
};
export type BeginTransfer = TransferKey & {
  readonly sizeBytes: number;
  readonly sha256: string;
};
export type TransferStatus =
  | { readonly state: "receiving"; readonly offset: number }
  | {
      readonly state: "finished";
      readonly path: string;
      readonly sizeBytes: number;
      readonly sha256: string;
    }
  | { readonly state: "aborted" }
  | { readonly state: "not_found" }
  | { readonly state: "released" }
  | { readonly state: "interrupted" };

export class PeerTransferReceiverError extends Schema.TaggedError<PeerTransferReceiverError>()(
  "PeerTransferReceiverError",
  {
    reason: Schema.Literals([
      "invalid",
      "wrong_target",
      "limit",
      "conflict",
      "busy",
      "not_found",
      "interrupted",
      "integrity",
      "storage",
      "platform_unsupported",
      "expired",
    ]),
  },
) {
  override get message() {
    return this.reason === "platform_unsupported"
      ? "Private transfer staging is unavailable on Windows without a verified private ACL."
      : `Transfer failed: ${this.reason}.`;
  }
}

export class PeerTransferReceiver extends Context.Service<
  PeerTransferReceiver,
  {
    readonly begin: (
      input: BeginTransfer,
    ) => Effect.Effect<TransferStatus, PeerTransferReceiverError>;
    readonly append: (
      input: TransferKey & { readonly offset: number; readonly base64: string },
    ) => Effect.Effect<TransferStatus, PeerTransferReceiverError>;
    readonly finish: (
      input: TransferKey,
    ) => Effect.Effect<TransferStatus, PeerTransferReceiverError>;
    readonly abort: (
      input: TransferKey,
    ) => Effect.Effect<TransferStatus, PeerTransferReceiverError>;
    readonly status: (
      input: TransferKey,
    ) => Effect.Effect<TransferStatus, PeerTransferReceiverError>;
    readonly release: (
      input: TransferKey & { readonly destinationUseComplete: true },
    ) => Effect.Effect<TransferStatus, PeerTransferReceiverError>;
  }
>()("t3/peer/PeerTransferReceiver") {}

type FailureReason = PeerTransferReceiverError["reason"];
class Failure extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(reason);
    this.reason = reason;
  }
}
const fail = (reason: FailureReason): never => {
  throw new Failure(reason);
};
const exists = async (path: string) => {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const identity = (input: TransferKey) => {
  if (
    typeof input.owner !== "string" ||
    !input.owner ||
    input.owner.length > 512 ||
    typeof input.requestId !== "string" ||
    !input.requestId ||
    input.requestId.length > 512
  )
    fail("invalid");
  return sha256(Buffer.from(JSON.stringify([input.owner, input.requestId])));
};
const validManifest = (input: BeginTransfer) => {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) fail("invalid");
  if (input.sizeBytes > MAX_TRANSFER_BYTES) fail("limit");
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) fail("invalid");
  return JSON.stringify({ sizeBytes: input.sizeBytes, sha256: input.sha256 });
};
const decodeChunk = (base64: string) => {
  if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_TRANSFER_CHUNK_BYTES / 3) * 4)
    fail("limit");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    fail("invalid");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_TRANSFER_CHUNK_BYTES ||
    bytes.toString("base64") !== base64
  )
    fail("invalid");
  return bytes;
};

const make = Effect.fn("PeerTransferReceiver.make")(function* (configuration: {
  readonly directory: string;
  readonly environmentId: string;
  readonly now?: () => number;
}) {
  const platform = yield* HostProcess.Platform;
  const clock = yield* Clock.Clock;
  const active = new Map<string, NodeSqlite.DatabaseSync>();
  const busy = new Set<string>();
  const root = NodePath.resolve(configuration.directory);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const lease of active.values()) lease.close();
      active.clear();
    }),
  );

  const releaseLease = (id: string) => {
    active.get(id)?.close();
    active.delete(id);
  };

  const checkLease = async (path: string) => {
    const stat = await NodeFSP.lstat(path).catch(() => fail("busy"));
    if (!stat.isFile() || stat.nlink !== 1) fail("busy");
    const lease = new NodeSqlite.DatabaseSync(path);
    try {
      try {
        lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      } catch {
        fail("busy");
      }
    } finally {
      lease.close();
    }
  };

  const operate = <A>(
    input: TransferKey,
    create: boolean,
    f: (paths: {
      dir: string;
      manifest: string;
      part: string;
      final: string;
      aborted: string;
      released: string;
      lock: string;
      lease: string;
      watermark: number;
    }) => Promise<A>,
    avoidCreatingRoot = false,
  ) =>
    Effect.tryPromise({
      try: async () => {
        if (platform === "win32") fail("platform_unsupported");
        if (input.target !== configuration.environmentId) fail("wrong_target");
        const id = identity(input);
        if (busy.has(id)) fail("busy");
        busy.add(id);
        try {
          if (avoidCreatingRoot && !(await exists(root))) fail("not_found");
          await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
          if (!(await NodeFSP.lstat(root)).isDirectory()) fail("storage");
          await NodeFSP.chmod(root, 0o700);
          const lockPath = NodePath.join(root, "lock");
          if (!(await exists(lockPath))) {
            const candidatePath = NodePath.join(root, `.lock-${NodeCrypto.randomUUID()}`);
            const candidate = await NodeFSP.open(candidatePath, "wx", 0o600);
            await candidate.close();
            try {
              const initialized = new NodeSqlite.DatabaseSync(candidatePath);
              try {
                initialized.exec(
                  "CREATE TABLE peer_transfer_lock (version INTEGER NOT NULL); INSERT INTO peer_transfer_lock VALUES (1)",
                );
              } finally {
                initialized.close();
              }
              try {
                await NodeFSP.link(candidatePath, lockPath);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              }
            } finally {
              await NodeFSP.rm(candidatePath, { force: true });
            }
          }
          if (!(await NodeFSP.lstat(lockPath)).isFile()) fail("busy");
          let verified: NodeSqlite.DatabaseSync | undefined;
          try {
            verified = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
            const marker = verified.prepare("SELECT version FROM peer_transfer_lock").get();
            if (marker?.version !== 1 && marker?.version !== 2) fail("busy");
          } catch {
            fail("busy");
          } finally {
            verified?.close();
          }
          const lock = new NodeSqlite.DatabaseSync(lockPath);
          let locked = false;
          try {
            try {
              lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
              locked = true;
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "errcode" in error &&
                error.errcode === 5
              )
                fail("busy");
              throw error;
            }
            const marker = lock.prepare("SELECT version FROM peer_transfer_lock").get();
            if (marker?.version !== 1 && marker?.version !== 2) fail("busy");
            let watermark = 0;
            if (create) {
              // Version 2 fences older receivers before any replay evidence can be removed.
              lock.exec("UPDATE peer_transfer_lock SET version = 2");
              lock.exec(
                "CREATE TABLE IF NOT EXISTS transfer_clock (id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER NOT NULL)",
              );
              const now = (configuration.now ?? (() => clock.currentTimeMillisUnsafe()))();
              if (!Number.isSafeInteger(now) || now < 0) fail("storage");
              lock
                .prepare(
                  "INSERT INTO transfer_clock (id, watermark) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET watermark = MAX(watermark, excluded.watermark)",
                )
                .run(now);
              // Persist the high-water mark before removing receipts, including across clock rollback.
              lock.exec("COMMIT");
              locked = false;
              try {
                lock.exec("BEGIN IMMEDIATE");
                locked = true;
              } catch {
                fail("busy");
              }
              const stored = lock
                .prepare("SELECT watermark FROM transfer_clock WHERE id = 1")
                .get()?.watermark;
              watermark =
                typeof stored === "number" && Number.isSafeInteger(stored)
                  ? stored
                  : fail("storage");
            }
            const dir = NodePath.join(root, id);
            if (create) {
              await NodeFSP.mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error;
              });
            } else if (!(await exists(dir))) fail("not_found");
            if (!(await NodeFSP.lstat(dir)).isDirectory()) fail("storage");
            const paths = {
              dir,
              manifest: NodePath.join(dir, "manifest"),
              part: NodePath.join(dir, "part"),
              final: NodePath.join(dir, "file"),
              aborted: NodePath.join(dir, "aborted"),
              released: NodePath.join(dir, "released"),
              lock: lockPath,
              lease: NodePath.join(dir, "lease.db"),
              watermark,
            };
            try {
              return await f(paths);
            } catch (error) {
              if (create && !(await exists(paths.manifest))) {
                await NodeFSP.rmdir(dir).catch(() => undefined);
              }
              throw error;
            }
          } finally {
            try {
              if (locked) lock.exec("ROLLBACK");
            } finally {
              lock.close();
            }
          }
        } finally {
          busy.delete(id);
        }
      },
      catch: (error) =>
        new PeerTransferReceiverError({
          reason: error instanceof Failure ? error.reason : "storage",
        }),
    }).pipe(Effect.uninterruptible);

  const manifest = async (
    path: string,
  ): Promise<{ sizeBytes: number; sha256: string; issuedAt?: number }> => {
    let value: unknown;
    try {
      value = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("not_found");
      fail("storage");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("sizeBytes" in value) ||
      !("sha256" in value)
    )
      fail("storage");
    const m = value as { sizeBytes: number; sha256: string; issuedAt?: number };
    validManifest({ owner: "x", target: "x", requestId: "x", ...m });
    if (m.issuedAt !== undefined && (!Number.isSafeInteger(m.issuedAt) || m.issuedAt < 0))
      fail("storage");
    return m;
  };
  const state = async (
    input: TransferKey,
    paths: {
      manifest: string;
      part: string;
      final: string;
      aborted: string;
      released: string;
      lease: string;
    },
  ): Promise<TransferStatus> => {
    const meta = await manifest(paths.manifest);
    if (await exists(paths.released)) {
      if ((await exists(paths.final)) || (await exists(paths.part))) fail("interrupted");
      return { state: "released" };
    }
    if (await exists(paths.final)) {
      const file = await NodeFSP.readFile(paths.final);
      if (file.length !== meta.sizeBytes || sha256(file) !== meta.sha256) fail("integrity");
      if (await exists(paths.part)) {
        const [partStat, finalStat] = await Promise.all([
          NodeFSP.lstat(paths.part),
          NodeFSP.lstat(paths.final),
        ]);
        if (
          !partStat.isFile() ||
          !finalStat.isFile() ||
          partStat.dev !== finalStat.dev ||
          partStat.ino !== finalStat.ino
        )
          fail("conflict");
        await NodeFSP.unlink(paths.part);
      }
      releaseLease(identity(input));
      return {
        state: "finished",
        path: paths.final,
        sizeBytes: meta.sizeBytes,
        sha256: meta.sha256,
      };
    }
    if (await exists(paths.aborted)) return { state: "aborted" };
    if (!active.has(identity(input))) {
      await checkLease(paths.lease);
      return { state: "interrupted" };
    }
    const stat = await NodeFSP.stat(paths.part);
    if (stat.size > meta.sizeBytes) fail("integrity");
    return { state: "receiving", offset: stat.size };
  };

  const begin = Effect.fn("PeerTransferReceiver.begin")((input: BeginTransfer) =>
    operate(input, true, async (paths) => {
      const match = /^(\d{13})-[a-f0-9]{64}$/.exec(input.requestId);
      if (!match) return fail("invalid");
      const issuedAt = Number(match[1]);
      if (issuedAt + RECEIPT_LIFETIME_MS < paths.watermark) fail("expired");
      if (issuedAt > paths.watermark + MAX_CLOCK_SKEW_MS) fail("invalid");
      validManifest(input);
      const expected = JSON.stringify({
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        issuedAt,
      });
      if (await exists(paths.manifest)) {
        if ((await NodeFSP.readFile(paths.manifest, "utf8")) !== expected) fail("conflict");
        return state(input, paths);
      }
      if (await exists(paths.lease)) {
        await checkLease(paths.lease);
        const entries = await NodeFSP.readdir(paths.dir);
        if (entries.length !== 1 || entries[0] !== "lease.db") fail("storage");
        await NodeFSP.unlink(paths.lease);
      }
      let reservedCount = 0;
      let reservedBytes = 0;
      let recordCount = 0;
      let tombstoneCount = 0;
      let pendingTombstones = 0;
      let stagedBytes = 0;
      for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const entryDir = NodePath.join(root, entry.name);
        const entryManifest = NodePath.join(entryDir, "manifest");
        if (!(await exists(entryManifest))) continue;
        const reservation = await manifest(entryManifest);
        const finished = await exists(NodePath.join(entryDir, "file"));
        const aborted = await exists(NodePath.join(entryDir, "aborted"));
        const partExists = await exists(NodePath.join(entryDir, "part"));
        const released = await exists(NodePath.join(entryDir, "released"));
        if (
          released &&
          !partExists &&
          !finished &&
          reservation.issuedAt !== undefined &&
          reservation.issuedAt + RECEIPT_LIFETIME_MS < paths.watermark
        ) {
          const entries = await NodeFSP.readdir(entryDir);
          if (
            entries.some((name) => !["manifest", "released", "aborted", "lease.db"].includes(name))
          )
            fail("storage");
          for (const name of entries) {
            const path = NodePath.join(entryDir, name);
            const stat = await NodeFSP.lstat(path);
            if (!stat.isFile() || stat.nlink !== 1) fail("storage");
            await NodeFSP.unlink(path);
          }
          await NodeFSP.rmdir(entryDir);
          continue;
        }
        if (released) tombstoneCount += 1;
        else pendingTombstones += 1;
        if (released && !partExists && !finished) continue;
        recordCount += 1;
        if (!aborted || partExists || finished) stagedBytes += reservation.sizeBytes;
        if (!finished && (!aborted || partExists)) {
          reservedCount += 1;
          reservedBytes += reservation.sizeBytes;
        }
      }
      if (
        reservedCount >= MAX_INCOMPLETE_TRANSFERS ||
        reservedBytes + input.sizeBytes > MAX_INCOMPLETE_BYTES ||
        recordCount >= MAX_TRANSFER_RECORDS ||
        tombstoneCount + pendingTombstones >= MAX_TRANSFER_TOMBSTONES ||
        stagedBytes + input.sizeBytes > MAX_STAGING_BYTES
      )
        fail("limit");
      const leaseFile = await NodeFSP.open(paths.lease, "wx", 0o600);
      await leaseFile.close();
      const lease = new NodeSqlite.DatabaseSync(paths.lease);
      try {
        lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        await NodeFSP.writeFile(paths.manifest, expected, { flag: "wx", mode: 0o600 });
        const part = await NodeFSP.open(paths.part, "wx", 0o600);
        await part.close();
        active.set(identity(input), lease);
      } catch (error) {
        lease.close();
        throw error;
      }
      return { state: "receiving", offset: 0 } as const;
    }),
  );
  const append = Effect.fn("PeerTransferReceiver.append")(
    (input: TransferKey & { readonly offset: number; readonly base64: string }) =>
      operate(input, false, async (paths) => {
        const bytes = decodeChunk(input.base64);
        if (!Number.isSafeInteger(input.offset) || input.offset < 0) fail("invalid");
        const current = await state(input, paths);
        if (current.state !== "receiving")
          throw new Failure(current.state === "interrupted" ? "interrupted" : "conflict");
        const meta = await manifest(paths.manifest);
        if (input.offset + bytes.length > meta.sizeBytes) fail("limit");
        const handle = await NodeFSP.open(paths.part, "r+");
        try {
          if (input.offset < current.offset) {
            if (input.offset + bytes.length > current.offset) fail("conflict");
            const prior = Buffer.alloc(bytes.length);
            const { bytesRead } = await handle.read(prior, 0, prior.length, input.offset);
            if (bytesRead !== bytes.length || !prior.equals(bytes)) fail("conflict");
            return current;
          }
          if (input.offset !== current.offset) fail("conflict");
          let written = 0;
          while (written < bytes.length) {
            const result = await handle.write(
              bytes,
              written,
              bytes.length - written,
              input.offset + written,
            );
            if (result.bytesWritten === 0) fail("storage");
            written += result.bytesWritten;
          }
          return { state: "receiving", offset: current.offset + written } as const;
        } finally {
          await handle.close();
        }
      }),
  );
  const finish = Effect.fn("PeerTransferReceiver.finish")((input: TransferKey) =>
    operate(input, false, async (paths) => {
      const current = await state(input, paths);
      if (current.state === "finished") return current;
      if (current.state !== "receiving")
        fail(current.state === "interrupted" ? "interrupted" : "conflict");
      const meta = await manifest(paths.manifest);
      const file = await NodeFSP.readFile(paths.part);
      if (file.length !== meta.sizeBytes || sha256(file) !== meta.sha256) fail("integrity");
      await NodeFSP.link(paths.part, paths.final);
      await NodeFSP.unlink(paths.part);
      releaseLease(identity(input));
      return {
        state: "finished",
        path: paths.final,
        sizeBytes: meta.sizeBytes,
        sha256: meta.sha256,
      } as const;
    }),
  );
  const abort = Effect.fn("PeerTransferReceiver.abort")((input: TransferKey) =>
    operate(input, false, async (paths) => {
      const current = await state(input, paths);
      if (current.state === "finished" || current.state === "released") fail("conflict");
      if (current.state !== "aborted")
        await NodeFSP.writeFile(paths.aborted, "", { flag: "wx", mode: 0o600 });
      await NodeFSP.rm(paths.part, { force: true });
      releaseLease(identity(input));
      return { state: "aborted" } as const;
    }),
  );
  const status = Effect.fn("PeerTransferReceiver.status")((input: TransferKey) =>
    operate(input, false, (paths) => state(input, paths), true).pipe(
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () => Effect.succeed({ state: "not_found" } as const),
      ),
    ),
  );
  const release = Effect.fn("PeerTransferReceiver.release")(
    (input: TransferKey & { readonly destinationUseComplete: true }) =>
      operate(input, false, async (paths) => {
        if (input.destinationUseComplete !== true) fail("invalid");
        await manifest(paths.manifest);
        if (!(await exists(paths.released))) {
          const current = await state(input, paths);
          if (current.state !== "finished" && current.state !== "aborted") fail("conflict");
          if (await exists(paths.part)) fail("conflict");
          let tombstones = 0;
          for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
            if (
              entry.isDirectory() &&
              /^[a-f0-9]{64}$/.test(entry.name) &&
              (await exists(NodePath.join(root, entry.name, "released")))
            )
              tombstones += 1;
          }
          if (tombstones >= MAX_TRANSFER_TOMBSTONES) fail("limit");
          await NodeFSP.writeFile(paths.released, "", { flag: "wx", mode: 0o600 });
        }
        if (await exists(paths.part)) fail("conflict");
        await NodeFSP.rm(paths.final, { force: true });
        return { state: "released" } as const;
      }),
  );
  return PeerTransferReceiver.of({ begin, append, finish, abort, status, release });
});

export const layer = (configuration: {
  readonly directory: string;
  readonly environmentId: string;
  readonly now?: () => number;
}) => Layer.effect(PeerTransferReceiver, make(configuration));
