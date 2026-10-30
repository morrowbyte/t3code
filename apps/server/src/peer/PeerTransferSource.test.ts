// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real Unix sockets and private filesystem boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as Source from "./PeerTransferSource.ts";
import { submitFile } from "./PeerTransferSourceClient.ts";

const key = { callerNamespace: "agent-1", clientRequestId: "request-1", target: "environment-box" };
const authorize = async () => true;
const fixture = <A, E>(run: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3src-"))),
    run,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
const write = async (socketPath: string, header: string, bytes: Buffer) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.createConnection({ path: socketPath, allowHalfOpen: true });
    let answer = "";
    socket.on("error", reject);
    socket.on("data", (data) => {
      answer += data.toString("ascii");
    });
    socket.on("end", () => resolve(answer));
    socket.on("connect", () => {
      socket.write(header);
      socket.end(bytes);
    });
  });

it.live(
  "receives exact bytes over the private socket and keeps source until explicit cleanup",
  () =>
    fixture((directory) =>
      Effect.gen(function* () {
        const source = yield* Source.PeerTransferSource;
        const prepared = yield* source.prepare(key, authorize);
        expect(yield* source.prepare(key, authorize)).toEqual(prepared);
        expect(
          (yield* Effect.promise(() => NodeFSP.stat(NodePath.dirname(prepared.socketPath)))).mode &
            0o777,
        ).toBe(0o700);
        expect((yield* Effect.promise(() => NodeFSP.stat(prepared.tokenPath))).mode & 0o777).toBe(
          0o600,
        );
        const bytes = Buffer.from([0, 255, 1, 2, 128, 0]);
        const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const input = NodePath.join(directory, "binary-input");
        yield* Effect.promise(() => NodeFSP.writeFile(input, bytes));
        yield* Effect.promise(() => submitFile(prepared.socketPath, prepared.tokenPath, input));
        const resolved = yield* source.resolve(key);
        expect(resolved).toMatchObject({ sizeBytes: bytes.length, sha256: sha });
        expect(yield* Effect.promise(() => NodeFSP.readFile(resolved.path))).toEqual(bytes);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const active = yield* Effect.forkChild(
          source.withTransfer(key, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);
        expect((yield* Effect.flip(source.cleanup(key))).reason).toBe("busy");
        expect((yield* Effect.flip(source.abort(key))).reason).toBe("busy");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(active);
        expect((yield* Effect.flip(source.resolve({ ...key, target: "other" }))).reason).toBe(
          "not_found",
        );
        yield* source.cleanup(key);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(resolved.path).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
    ),
);

it.live("rejects an over-limit stream and preserves isolated request slots", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      const prepared = yield* source.prepare(key, authorize);
      const token = yield* Effect.promise(() => NodeFSP.readFile(prepared.tokenPath, "ascii"));
      expect(
        yield* Effect.promise(() =>
          write(prepared.socketPath, `${token} 52428801 ${"0".repeat(64)}\n`, Buffer.alloc(0)),
        ),
      ).toBe("error:limit\n");
      expect((yield* source.status(key)).state).toBe("failed");
      expect((yield* Effect.flip(source.resolve(key))).reason).toBe("busy");
      yield* source.abort(key);
      const other = yield* source.prepare({ ...key, callerNamespace: "agent-2" }, authorize);
      expect(other.socketPath).not.toBe(prepared.socketPath);
      yield* source.abort({ ...key, callerNamespace: "agent-2" });
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live("refuses oversized files in the real client before consuming the socket", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      const prepared = yield* source.prepare(key, authorize);
      const input = NodePath.join(directory, "large");
      yield* Effect.promise(async () => {
        const handle = await NodeFSP.open(input, "w");
        try {
          await handle.truncate(50 * 1024 * 1024 + 1);
        } finally {
          await handle.close();
        }
      });
      expect(
        yield* Effect.promise(() =>
          submitFile(prepared.socketPath, prepared.tokenPath, input).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      expect((yield* source.status(key)).state).toBe("waiting");
      yield* source.abort(key);
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live("rechecks authorization before local publication and discards revoked submissions", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      const input = NodePath.join(directory, "input");
      yield* Effect.promise(() => NodeFSP.writeFile(input, Buffer.from([0, 255])));
      let checks = 0;
      const prepared = yield* source.prepare(key, async () => ++checks === 1);
      expect(
        yield* Effect.promise(() =>
          submitFile(prepared.socketPath, prepared.tokenPath, input).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      expect(checks).toBe(2);
      expect((yield* source.status(key)).state).toBe("failed");
      expect((yield* Effect.flip(source.resolve(key))).reason).toBe("busy");
      yield* source.abort(key);
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live("returns a safe denied acknowledgement when authorization is revoked", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      for (const denyCheck of [1, 2]) {
        let checks = 0;
        const prepared = yield* source.prepare(key, async () => ++checks !== denyCheck);
        const token = yield* Effect.promise(() => NodeFSP.readFile(prepared.tokenPath, "ascii"));
        const emptyHash = NodeCrypto.createHash("sha256").digest("hex");
        expect(
          yield* Effect.promise(() =>
            write(prepared.socketPath, `${token} 0 ${emptyHash}\n`, Buffer.alloc(0)),
          ),
        ).toBe("error:denied\n");
        expect((yield* source.status(key)).state).toBe("failed");
        yield* source.abort(key);
      }
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live("rejects Windows without private ACL proof", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      expect((yield* Effect.flip(source.prepare(key, authorize))).reason).toBe(
        "platform_unsupported",
      );
    }).pipe(
      Effect.provide(
        Source.layer({ directory: NodePath.join(directory, "stage") }).pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
        ),
      ),
    ),
  ),
);

it.live("accepts an empty file with the real client and enforces four reserved slots", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      const prepared = yield* source.prepare(key, authorize);
      const empty = NodePath.join(directory, "empty");
      yield* Effect.promise(() => NodeFSP.writeFile(empty, ""));
      yield* Effect.promise(() => submitFile(prepared.socketPath, prepared.tokenPath, empty));
      expect((yield* source.resolve(key)).sizeBytes).toBe(0);
      const keys = [2, 3, 4].map((number) => ({ ...key, clientRequestId: `request-${number}` }));
      for (const next of keys) yield* source.prepare(next, authorize);
      expect(
        (yield* Effect.flip(source.prepare({ ...key, clientRequestId: "fifth" }, authorize)))
          .reason,
      ).toBe("limit");
      for (const next of keys) yield* source.abort(next);
      yield* source.cleanup(key);
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live("rejects wrong credentials, corrupt bytes and foreign request identities", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      const prepared = yield* source.prepare(key, authorize);
      const token = yield* Effect.promise(() => NodeFSP.readFile(prepared.tokenPath, "ascii"));
      expect(
        (yield* Effect.flip(source.status({ ...key, callerNamespace: "agent-2" }))).reason,
      ).toBe("not_found");
      yield* source.abort({ ...key, target: "other" });
      expect((yield* source.status(key)).state).toBe("waiting");
      expect(
        yield* Effect.promise(() =>
          write(
            prepared.socketPath,
            `${token[0] === "f" ? "0" : "f"}${token.slice(1)} 0 ${"0".repeat(64)}\n`,
            Buffer.alloc(0),
          ),
        ),
      ).toBe("error:invalid\n");
      expect((yield* source.status(key)).state).toBe("failed");
      yield* source.abort(key);

      const corrupt = yield* source.prepare(key, authorize);
      expect(
        yield* Effect.promise(() =>
          write(corrupt.socketPath, `${token} 1 ${"0".repeat(64)}\n`, Buffer.from([1])),
        ),
      ).toBe("error:invalid\n");
      yield* source.abort(key);

      const mismatch = yield* source.prepare(key, authorize);
      const currentToken = yield* Effect.promise(() =>
        NodeFSP.readFile(mismatch.tokenPath, "ascii"),
      );
      expect(
        yield* Effect.promise(() =>
          write(mismatch.socketPath, `${currentToken} 1 ${"0".repeat(64)}\n`, Buffer.from([1])),
        ),
      ).toBe("error:integrity\n");
      expect((yield* source.status(key)).state).toBe("failed");
      yield* source.abort(key);
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live("aborts an incomplete submission and releases its slot", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const source = yield* Source.PeerTransferSource;
      const prepared = yield* source.prepare(key, authorize);
      const socket = yield* Effect.promise(
        () =>
          new Promise<NodeNet.Socket>((resolve, reject) => {
            const connection = NodeNet.createConnection(prepared.socketPath);
            connection.once("error", reject);
            connection.once("connect", () => {
              connection.write("partial");
              resolve(connection);
            });
          }),
      );
      yield* source.abort(key);
      socket.destroy();
      expect((yield* Effect.flip(source.status(key))).reason).toBe("not_found");
      yield* source.prepare(key, authorize);
      yield* source.abort(key);
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);

it.live(
  "reports interrupted staging after restart and recovers it without stealing a live lease",
  () =>
    fixture((directory) =>
      Effect.gen(function* () {
        const stage = NodePath.join(directory, "stage");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const source = yield* Source.PeerTransferSource;
            yield* source.prepare(key, authorize);
            yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                const metadataLock = new NodeSqlite.DatabaseSync(
                  NodePath.join(stage, "metadata.db"),
                );
                metadataLock.exec("BEGIN IMMEDIATE");
                return metadataLock;
              }),
              () =>
                Effect.gen(function* () {
                  expect(
                    (yield* Effect.flip(
                      source.prepare({ ...key, clientRequestId: "concurrent" }, authorize),
                    )).reason,
                  ).toBe("busy");
                }),
              (metadataLock) => Effect.sync(() => metadataLock.close()),
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const other = yield* Source.PeerTransferSource;
                expect((yield* other.status(key)).state).toBe("interrupted");
                expect((yield* Effect.flip(other.abort(key))).reason).toBe("busy");
              }).pipe(Effect.provide(Source.layer({ directory: stage }))),
            );
          }).pipe(Effect.provide(Source.layer({ directory: stage }))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const source = yield* Source.PeerTransferSource;
            expect((yield* source.status(key)).state).toBe("interrupted");
            yield* source.abort(key);
            yield* source.abort(key);
            yield* source.cleanup(key);
            yield* source.prepare(key, authorize);
            yield* source.abort(key);
          }).pipe(Effect.provide(Source.layer({ directory: stage }))),
        );
      }),
    ),
);

it.live("keeps a completed source across restart until explicit cleanup", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const stage = NodePath.join(directory, "stage");
      const input = NodePath.join(directory, "input");
      const bytes = Buffer.from([0, 255, 3, 128]);
      yield* Effect.promise(() => NodeFSP.writeFile(input, bytes));
      const savedPath = yield* Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Source.PeerTransferSource;
          const prepared = yield* source.prepare(key, authorize);
          yield* Effect.promise(() => submitFile(prepared.socketPath, prepared.tokenPath, input));
          return (yield* source.resolve(key)).path;
        }).pipe(Effect.provide(Source.layer({ directory: stage }))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Source.PeerTransferSource;
          expect((yield* source.status(key)).state).toBe("interrupted");
          expect((yield* Effect.flip(source.abort(key))).reason).toBe("busy");
          expect(yield* Effect.promise(() => NodeFSP.readFile(savedPath))).toEqual(bytes);
          yield* source.cleanup(key);
          yield* source.cleanup(key);
          yield* source.abort(key);
          yield* source.prepare(key, authorize);
          yield* source.abort(key);
        }).pipe(Effect.provide(Source.layer({ directory: stage }))),
      );
    }),
  ),
);

it.live("recovers an empty initialization directory after a process restart", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const stage = NodePath.join(directory, "stage");
      const source = yield* Source.PeerTransferSource;
      expect((yield* Effect.flip(source.status(key))).reason).toBe("not_found");
      const id = NodeCrypto.createHash("sha256")
        .update(JSON.stringify([key.callerNamespace, key.clientRequestId, key.target]))
        .digest("hex")
        .slice(0, 32);
      const interrupted = NodePath.join(stage, id);
      yield* Effect.promise(() => NodeFSP.mkdir(interrupted, { mode: 0o700 }));
      expect((yield* source.status(key)).state).toBe("interrupted");
      yield* source.abort(key);
      yield* source.prepare(key, authorize);
      yield* source.abort(key);
      yield* Effect.promise(() => NodeFSP.mkdir(interrupted, { mode: 0o700 }));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(interrupted, "foreign"), "x"));
      expect((yield* Effect.flip(source.abort(key))).reason).toBe("interrupted");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(interrupted, "foreign"), "utf8"),
        ),
      ).toBe("x");
    }).pipe(Effect.provide(Source.layer({ directory: NodePath.join(directory, "stage") }))),
  ),
);
