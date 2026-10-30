// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Receiver from "./PeerTransferReceiver.ts";

const TEST_TIME = 1_800_000_000_000;
const requestId = (value: string) =>
  `${TEST_TIME}-${NodeCrypto.createHash("sha256").update(value).digest("hex")}`;
const key = {
  owner: "linked-session-1",
  target: "environment-box",
  requestId: requestId("request-1"),
};
const data = Buffer.from([0, 255, 128, 1, 2, 13, 10, 0, 200]);
const hash = (value: Uint8Array) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const begin = { ...key, sizeBytes: data.length, sha256: hash(data) };

const withDirectory = <A, E>(run: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transfer-receiver-"))),
    run,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

it.live("prevents a second receiver from aborting a live upload", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      yield* receiver.begin(begin);
      yield* receiver.append({ ...key, offset: 0, base64: data.subarray(0, 4).toString("base64") });
      yield* Effect.gen(function* () {
        const other = yield* Receiver.PeerTransferReceiver;
        expect((yield* Effect.flip(other.abort(key))).reason).toBe("busy");
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
      const executable = yield* HostProcess.ExecutablePath;
      const id = NodeCrypto.createHash("sha256")
        .update(JSON.stringify([key.owner, key.requestId]))
        .digest("hex");
      const probe = yield* Effect.sync(() =>
        NodeChildProcess.spawnSync(executable, [
          "-e",
          `
          const { DatabaseSync } = require("node:sqlite");
          const db = new DatabaseSync(process.argv[1]);
          try { db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); process.exitCode = 1; }
          catch (error) { if (error.errcode !== 5) process.exitCode = 2; }
          finally { db.close(); }
        `,
          NodePath.join(directory, id, "lease.db"),
        ]),
      );
      expect(probe.status).toBe(0);
      expect(
        yield* receiver.append({ ...key, offset: 4, base64: data.subarray(4).toString("base64") }),
      ).toEqual({ state: "receiving", offset: data.length });
      expect((yield* receiver.finish(key)).state).toBe("finished");
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("stores exact binary bytes, replays operations and recovers the completed receipt", () =>
  withDirectory((directory) => {
    const layer = Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME });
    return Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      expect(yield* receiver.begin(begin)).toEqual({ state: "receiving", offset: 0 });
      const first = data.subarray(0, 4).toString("base64");
      expect(yield* receiver.append({ ...key, offset: 0, base64: first })).toEqual({
        state: "receiving",
        offset: 4,
      });
      expect(yield* receiver.append({ ...key, offset: 0, base64: first })).toEqual({
        state: "receiving",
        offset: 4,
      });
      expect(
        (yield* Effect.flip(
          receiver.append({
            ...key,
            offset: 0,
            base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
          }),
        )).reason,
      ).toBe("conflict");
      yield* receiver.append({ ...key, offset: 4, base64: data.subarray(4).toString("base64") });
      const finished = yield* receiver.finish(key);
      expect(finished.state).toBe("finished");
      if (finished.state !== "finished") throw new Error("Expected finished transfer");
      expect(yield* Effect.promise(() => NodeFSP.readFile(finished.path))).toEqual(data);
      expect(finished).toMatchObject({ sizeBytes: data.length, sha256: hash(data) });
      expect(yield* receiver.finish(key)).toEqual(finished);
      expect(yield* receiver.begin(begin)).toEqual(finished);
      expect(
        (yield* Effect.flip(receiver.begin({ ...begin, sha256: "0".repeat(64) }))).reason,
      ).toBe("conflict");
      const recovered = yield* Effect.gen(function* () {
        return yield* (yield* Receiver.PeerTransferReceiver).status(key);
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
      expect(recovered).toEqual(finished);
    }).pipe(Effect.provide(layer));
  }),
);

it.live("rejects wrong target, other owners, malformed data, limits and hash mismatches", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      expect((yield* Effect.flip(receiver.begin({ ...begin, target: "wrong" }))).reason).toBe(
        "wrong_target",
      );
      expect((yield* Effect.flip(receiver.begin({ ...begin, requestId: "legacy" }))).reason).toBe(
        "invalid",
      );
      expect(
        (yield* Effect.flip(
          receiver.begin({
            ...begin,
            requestId: `${TEST_TIME + 10 * 60 * 1000}-${"a".repeat(64)}`,
          }),
        )).reason,
      ).toBe("invalid");
      expect(
        (yield* Effect.flip(
          receiver.begin({ ...begin, sizeBytes: Receiver.MAX_TRANSFER_BYTES + 1 }),
        )).reason,
      ).toBe("limit");
      yield* receiver.begin(begin);
      expect(yield* receiver.status({ ...key, owner: "other-session" })).toEqual({
        state: "not_found",
      });
      expect(
        (yield* Effect.flip(receiver.append({ ...key, offset: 0, base64: "AB==" }))).reason,
      ).toBe("invalid");
      expect(
        (yield* Effect.flip(
          receiver.append({
            ...key,
            offset: 0,
            base64: "A".repeat(4 * (Receiver.MAX_TRANSFER_CHUNK_BYTES + 1)),
          }),
        )).reason,
      ).toBe("limit");
      expect(
        (yield* Effect.flip(
          receiver.append({ ...key, offset: 1, base64: data.toString("base64") }),
        )).reason,
      ).toBe("limit");
      yield* receiver.append({
        ...key,
        offset: 0,
        base64: Buffer.alloc(data.length).toString("base64"),
      });
      expect((yield* Effect.flip(receiver.finish(key))).reason).toBe("integrity");
      expect(yield* receiver.abort(key)).toEqual({ state: "aborted" });
      expect(yield* receiver.abort(key)).toEqual({ state: "aborted" });
      expect(yield* receiver.status(key)).toEqual({ state: "aborted" });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("refuses simultaneous operations and protects a live upload from another receiver", () =>
  withDirectory((directory) => {
    const layer = Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME });
    return Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      const results = yield* Effect.all(
        [receiver.begin(begin).pipe(Effect.result), receiver.begin(begin).pipe(Effect.result)],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const failure = results.find((result) => result._tag === "Failure");
      expect(failure?._tag === "Failure" && failure.failure.reason).toBe("busy");
      yield* receiver.append({
        ...key,
        offset: 0,
        base64: data.subarray(0, 4).toString("base64"),
      });
      yield* Effect.gen(function* () {
        const restarted = yield* Receiver.PeerTransferReceiver;
        expect((yield* Effect.flip(restarted.status(key))).reason).toBe("busy");
        expect((yield* Effect.flip(restarted.abort(key))).reason).toBe("busy");
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
      expect(yield* receiver.abort(key)).toEqual({ state: "aborted" });
      const files = yield* Effect.promise(() => NodeFSP.readdir(directory, { recursive: true }));
      expect(files.some((file) => String(file).endsWith(`${NodePath.sep}part`))).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.live("allows an interrupted upload to be aborted after its owner stops", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const owner = yield* Receiver.PeerTransferReceiver;
        yield* owner.begin(begin);
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
      yield* Effect.gen(function* () {
        const restarted = yield* Receiver.PeerTransferReceiver;
        expect(yield* restarted.status(key)).toEqual({ state: "interrupted" });
        expect(yield* restarted.abort(key)).toEqual({ state: "aborted" });
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
    }),
  ),
);

it.live("recovers an unclaimed lease left before a manifest was written", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const id = NodeCrypto.createHash("sha256")
        .update(JSON.stringify([key.owner, key.requestId]))
        .digest("hex");
      yield* Effect.promise(async () => {
        const transferDir = NodePath.join(directory, id);
        await NodeFSP.mkdir(transferDir, { mode: 0o700 });
        const lease = new NodeSqlite.DatabaseSync(NodePath.join(transferDir, "lease.db"));
        lease.close();
      });
      const receiver = yield* Receiver.PeerTransferReceiver;
      expect(yield* receiver.begin(begin)).toEqual({ state: "receiving", offset: 0 });
      expect(yield* receiver.abort(key)).toEqual({ state: "aborted" });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("respects an upload lease held by another process until it exits", () =>
  withDirectory((directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        yield* Effect.gen(function* () {
          yield* (yield* Receiver.PeerTransferReceiver).begin(begin);
        }).pipe(
          Effect.provide(
            Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
          ),
        );
        const id = NodeCrypto.createHash("sha256")
          .update(JSON.stringify([key.owner, key.requestId]))
          .digest("hex");
        const executable = yield* HostProcess.ExecutablePath;
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const process = NodeChildProcess.spawn(
              executable,
              [
                "-e",
                `
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.argv[1]);
            db.exec("BEGIN IMMEDIATE");
            process.stdout.write("locked");
            process.stdin.resume();
          `,
                NodePath.join(directory, id, "lease.db"),
              ],
              { stdio: ["pipe", "pipe", "ignore"] },
            );
            const exit = new Promise<void>((resolve, reject) => {
              process.once("exit", () => resolve());
              process.once("error", reject);
            });
            return { process, exit };
          }),
          ({ process, exit }) =>
            Effect.promise(async () => {
              if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
              await exit;
            }),
        );
        yield* Effect.promise(() =>
          Promise.race([
            new Promise<void>((resolve) => child.process.stdout.once("data", () => resolve())),
            child.exit.then(() => {
              throw new Error("lease holder exited before acquiring the lease");
            }),
          ]),
        );
        yield* Effect.gen(function* () {
          const receiver = yield* Receiver.PeerTransferReceiver;
          expect((yield* Effect.flip(receiver.abort(key))).reason).toBe("busy");
          child.process.kill("SIGKILL");
          yield* Effect.promise(() => child.exit);
          expect(yield* receiver.status(key)).toEqual({ state: "interrupted" });
          expect(yield* receiver.abort(key)).toEqual({ state: "aborted" });
        }).pipe(
          Effect.provide(
            Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
          ),
        );
      }),
    ),
  ),
);

it.live("bounds incomplete transfers across owners and releases their quota on abort", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      const reserved = { ...begin, sizeBytes: Receiver.MAX_TRANSFER_BYTES };
      yield* receiver.begin(reserved);
      yield* receiver.begin({ ...reserved, owner: "second-owner" });
      expect((yield* Effect.flip(receiver.begin({ ...begin, owner: "third-owner" }))).reason).toBe(
        "limit",
      );
      yield* receiver.abort(key);
      yield* receiver.abort({ ...key, owner: "second-owner" });
      for (let i = 0; i < Receiver.MAX_INCOMPLETE_TRANSFERS; i += 1) {
        yield* receiver.begin({ ...begin, requestId: requestId(`small-${i}`) });
      }
      expect(
        (yield* Effect.flip(receiver.begin({ ...begin, requestId: requestId("one-too-many") })))
          .reason,
      ).toBe("limit");
      yield* receiver.abort({ ...key, requestId: requestId("small-0") });
      expect(yield* receiver.begin({ ...begin, requestId: requestId("one-too-many") })).toEqual({
        state: "receiving",
        offset: 0,
      });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("bounds retained receipts without deleting replay evidence", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      for (let i = 0; i < Receiver.MAX_TRANSFER_RECORDS; i += 1) {
        const request = { ...key, requestId: requestId(`receipt-${i}`) };
        yield* receiver.begin({ ...begin, requestId: request.requestId });
        yield* receiver.abort(request);
      }
      expect(
        (yield* Effect.flip(receiver.begin({ ...begin, requestId: requestId("overflow") }))).reason,
      ).toBe("limit");
      expect(yield* receiver.status({ ...key, requestId: requestId("receipt-0") })).toEqual({
        state: "aborted",
      });
      const directories = yield* Effect.promise(() => NodeFSP.readdir(directory));
      expect(directories.filter((name) => name !== "lock")).toHaveLength(
        Receiver.MAX_TRANSFER_RECORDS,
      );
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live(
  "expires released receipts without allowing old requests to run again after clock rollback",
  () =>
    withDirectory((directory) => {
      let now = 1_800_000_000_000;
      const receiverLayer = () =>
        Receiver.layer({ directory, environmentId: key.target, now: () => now });
      return Effect.gen(function* () {
        const receiver = yield* Receiver.PeerTransferReceiver;
        for (let i = 0; i < Receiver.MAX_TRANSFER_TOMBSTONES; i += 1) {
          const request = {
            ...key,
            requestId: `1800000000000-${i.toString(16).padStart(64, "0")}`,
          };
          yield* receiver.begin({ ...begin, ...request });
          yield* receiver.abort(request);
          yield* receiver.release({ ...request, destinationUseComplete: true });
        }
        now += 2 * 24 * 60 * 60 * 1000;
        const fresh = { ...key, requestId: `${now}-${"a".repeat(64)}` };
        yield* receiver.begin({ ...begin, ...fresh });
        now = 1_800_000_000_000;
        const old = { ...key, requestId: `1800000000000-${"0".repeat(64)}` };
        expect((yield* Effect.flip(receiver.begin({ ...begin, ...old }))).reason).toBe("expired");
        yield* Effect.gen(function* () {
          const restarted = yield* Receiver.PeerTransferReceiver;
          expect((yield* Effect.flip(restarted.begin({ ...begin, ...old }))).reason).toBe(
            "expired",
          );
        }).pipe(Effect.provide(receiverLayer()));
      }).pipe(Effect.provide(receiverLayer()));
    }),
);

it.live("refuses Windows before creating a staging file without a verified ACL", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      const error = yield* Effect.flip(receiver.begin(begin));
      expect(error.reason).toBe("platform_unsupported");
      expect(error.message).toContain("Windows");
      expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([]);
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }).pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
        ),
      ),
    ),
  ),
);

it.live("keeps a legacy lock untouched because its owner cannot be identified", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const lockPath = NodePath.join(directory, "lock");
      yield* Effect.promise(() => NodeFSP.writeFile(lockPath, "", { flag: "wx", mode: 0o600 }));
      const receiver = yield* Receiver.PeerTransferReceiver;
      expect((yield* Effect.flip(receiver.begin(begin))).reason).toBe("busy");
      expect((yield* Effect.promise(() => NodeFSP.stat(lockPath))).size).toBe(0);
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("preserves the global process lock and the live upload after that process crashes", () =>
  withDirectory((directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const receiver = yield* Receiver.PeerTransferReceiver;
        yield* receiver.begin(begin);
        yield* receiver.append({
          ...key,
          offset: 0,
          base64: data.subarray(0, 4).toString("base64"),
        });
        const executable = yield* HostProcess.ExecutablePath;
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const process = NodeChildProcess.spawn(
              executable,
              [
                "-e",
                `
              const { DatabaseSync } = require("node:sqlite");
              const db = new DatabaseSync(process.argv[1]);
              db.exec("BEGIN IMMEDIATE");
              process.stdout.write("locked");
              process.stdin.resume();
            `,
                NodePath.join(directory, "lock"),
              ],
              { stdio: ["pipe", "pipe", "ignore"] },
            );
            const exit = new Promise<void>((resolve, reject) => {
              process.once("exit", () => resolve());
              process.once("error", reject);
            });
            return { process, exit };
          }),
          ({ process, exit }) =>
            Effect.promise(async () => {
              if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
              await exit;
            }),
        );
        yield* Effect.promise(() =>
          Promise.race([
            new Promise<void>((resolve) => child.process.stdout.once("data", () => resolve())),
            child.exit.then(() => {
              throw new Error("lock holder exited before acquiring the lock");
            }),
          ]),
        );
        expect((yield* Effect.flip(receiver.status(key))).reason).toBe("busy");
        child.process.kill("SIGKILL");
        yield* Effect.promise(() => child.exit);
        yield* Effect.gen(function* () {
          const restarted = yield* Receiver.PeerTransferReceiver;
          expect((yield* Effect.flip(restarted.status(key))).reason).toBe("busy");
        }).pipe(
          Effect.provide(
            Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
          ),
        );
        expect(yield* receiver.status(key)).toEqual({ state: "receiving", offset: 4 });
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      ),
    ),
  ),
);

it.live("does not release another connection's active lock in the same process", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const receiver = yield* Receiver.PeerTransferReceiver;
      yield* receiver.begin(begin);
      const lock = new NodeSqlite.DatabaseSync(NodePath.join(directory, "lock"));
      try {
        lock.exec("BEGIN IMMEDIATE");
        expect((yield* Effect.flip(receiver.status(key))).reason).toBe("busy");
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
      expect(yield* receiver.status(key)).toEqual({ state: "receiving", offset: 0 });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("releases only a confirmed owner's completed transfer and retains its tombstone", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      const release = { ...key, destinationUseComplete: true } as const;
      yield* receiver.begin(begin);
      expect((yield* Effect.flip(receiver.release(release))).reason).toBe("conflict");
      expect(
        (yield* Effect.flip(
          receiver.release({ ...release, destinationUseComplete: false as never }),
        )).reason,
      ).toBe("invalid");
      expect(
        (yield* Effect.flip(receiver.release({ ...release, owner: "other-owner" }))).reason,
      ).toBe("not_found");
      yield* receiver.append({ ...key, offset: 0, base64: data.toString("base64") });
      const finished = yield* receiver.finish(key);
      if (finished.state !== "finished") throw new Error("Expected finished transfer");
      expect(yield* receiver.release(release)).toEqual({ state: "released" });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(finished.path).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      expect(yield* receiver.status(key)).toEqual({ state: "released" });
      expect(yield* receiver.release(release)).toEqual({ state: "released" });
      expect(yield* receiver.begin(begin)).toEqual({ state: "released" });
      expect((yield* Effect.flip(receiver.finish(key))).reason).toBe("conflict");
      expect((yield* Effect.flip(receiver.abort(key))).reason).toBe("conflict");
      yield* Effect.gen(function* () {
        const restarted = yield* Receiver.PeerTransferReceiver;
        expect(yield* restarted.status(key)).toEqual({ state: "released" });
        expect(yield* restarted.begin(begin)).toEqual({ state: "released" });
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(finished.path, data, { flag: "wx", mode: 0o600 }),
      );
      expect((yield* Effect.flip(receiver.status(key))).reason).toBe("interrupted");
      expect(yield* receiver.release(release)).toEqual({ state: "released" });
      expect(yield* receiver.status(key)).toEqual({ state: "released" });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("releases aborted transfers and frees their active record quota", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      for (let i = 0; i < Receiver.MAX_TRANSFER_RECORDS; i += 1) {
        const request = { ...key, requestId: requestId(`completed-${i}`) };
        yield* receiver.begin({ ...begin, requestId: request.requestId });
        yield* receiver.abort(request);
      }
      expect(
        (yield* Effect.flip(receiver.begin({ ...begin, requestId: requestId("new") }))).reason,
      ).toBe("limit");
      expect(
        yield* receiver.release({
          ...key,
          requestId: requestId("completed-0"),
          destinationUseComplete: true,
        }),
      ).toEqual({ state: "released" });
      expect(yield* receiver.begin({ ...begin, requestId: requestId("new") })).toEqual({
        state: "receiving",
        offset: 0,
      });
      expect(yield* receiver.status({ ...key, requestId: requestId("completed-0") })).toEqual({
        state: "released",
      });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("refuses release when the independent tombstone quota is full", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      yield* receiver.begin(begin);
      yield* receiver.abort(key);
      yield* Effect.promise(async () => {
        for (let i = 0; i < Receiver.MAX_TRANSFER_TOMBSTONES; i += 1) {
          const entry = NodePath.join(directory, i.toString(16).padStart(64, "0"));
          await NodeFSP.mkdir(entry);
          await NodeFSP.writeFile(NodePath.join(entry, "released"), "");
        }
      });
      expect(
        (yield* Effect.flip(receiver.release({ ...key, destinationUseComplete: true }))).reason,
      ).toBe("limit");
      expect(yield* receiver.status(key)).toEqual({ state: "aborted" });
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("reserves a tombstone slot before admitting the final transfer", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        for (let i = 0; i < Receiver.MAX_TRANSFER_TOMBSTONES - 1; i += 1) {
          const entry = NodePath.join(directory, i.toString(16).padStart(64, "0"));
          await NodeFSP.mkdir(entry);
          await NodeFSP.writeFile(
            NodePath.join(entry, "manifest"),
            JSON.stringify({ sizeBytes: data.length, sha256: hash(data) }),
          );
          await NodeFSP.writeFile(NodePath.join(entry, "released"), "");
        }
      });
      const receiver = yield* Receiver.PeerTransferReceiver;
      yield* receiver.begin(begin);
      expect(
        (yield* Effect.flip(receiver.begin({ ...begin, requestId: requestId("extra") }))).reason,
      ).toBe("limit");
      yield* receiver.abort(key);
      expect(yield* receiver.release({ ...key, destinationUseComplete: true })).toEqual({
        state: "released",
      });
      expect(
        (yield* Effect.flip(receiver.begin({ ...begin, requestId: requestId("extra") }))).reason,
      ).toBe("limit");
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("reports an unknown transfer without creating staging or consuming quota", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const root = NodePath.join(directory, "staging");
      const receiver = yield* Receiver.PeerTransferReceiver;
      expect(yield* receiver.status(key)).toEqual({ state: "not_found" });
      expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([]);
      expect((yield* Effect.flip(receiver.status({ ...key, target: "wrong" }))).reason).toBe(
        "wrong_target",
      );
      yield* receiver.begin(begin);
      const before = yield* Effect.promise(() => NodeFSP.readdir(root));
      expect(yield* receiver.status({ ...key, requestId: requestId("unknown") })).toEqual({
        state: "not_found",
      });
      expect(yield* Effect.promise(() => NodeFSP.readdir(root))).toEqual(before);
      expect(yield* receiver.status({ ...key, owner: "other-owner" })).toEqual({
        state: "not_found",
      });
    }).pipe(
      Effect.provide(
        Receiver.layer({
          directory: NodePath.join(directory, "staging"),
          environmentId: key.target,
          now: () => TEST_TIME,
        }),
      ),
    ),
  ),
);

it.live("recovers publication after a crash between linking and removing the part", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      yield* receiver.begin(begin);
      yield* receiver.append({ ...key, offset: 0, base64: data.toString("base64") });
      const id = hash(Buffer.from(JSON.stringify([key.owner, key.requestId])));
      const part = NodePath.join(directory, id, "part");
      const final = NodePath.join(directory, id, "file");
      yield* Effect.promise(() => NodeFSP.link(part, final));
      yield* Effect.gen(function* () {
        const restarted = yield* Receiver.PeerTransferReceiver;
        const result = yield* restarted.finish(key);
        expect(result).toMatchObject({ state: "finished", path: final });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(part).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(yield* Effect.promise(() => NodeFSP.readFile(final))).toEqual(data);
        expect(yield* restarted.release({ ...key, destinationUseComplete: true })).toEqual({
          state: "released",
        });
      }).pipe(
        Effect.provide(
          Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
        ),
      );
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);

it.live("never removes a part that is not a hard link to the published file", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const receiver = yield* Receiver.PeerTransferReceiver;
      yield* receiver.begin(begin);
      yield* receiver.append({ ...key, offset: 0, base64: data.toString("base64") });
      const id = hash(Buffer.from(JSON.stringify([key.owner, key.requestId])));
      const part = NodePath.join(directory, id, "part");
      const final = NodePath.join(directory, id, "file");
      yield* Effect.promise(() => NodeFSP.writeFile(final, data, { flag: "wx", mode: 0o600 }));
      expect((yield* Effect.flip(receiver.finish(key))).reason).toBe("conflict");
      expect(
        (yield* Effect.flip(receiver.release({ ...key, destinationUseComplete: true }))).reason,
      ).toBe("conflict");
      expect(yield* Effect.promise(() => NodeFSP.readFile(part))).toEqual(data);
      expect(yield* Effect.promise(() => NodeFSP.readFile(final))).toEqual(data);
    }).pipe(
      Effect.provide(
        Receiver.layer({ directory, environmentId: key.target, now: () => TEST_TIME }),
      ),
    ),
  ),
);
