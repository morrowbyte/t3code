// @effect-diagnostics nodeBuiltinImport:off - Tests create and inspect real binary files and temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as PeerTransferReceiver from "./PeerTransferReceiver.ts";
import * as PeerTransferSender from "./PeerTransferSender.ts";
import * as PeerTransferSource from "./PeerTransferSource.ts";
import { submitFile } from "./PeerTransferSourceClient.ts";

const TEST_TIME = 1_800_000_000_000;
const clientId = (value: string) => `${TEST_TIME}-${value}`;
const target = EnvironmentId.make("environment:destination");
const limits = { runtimeMode: "auto", interactionMode: "default" } as const;

const fixture = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-peer-sender-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

it.live("submits an authorized local file and transfers its exact bytes to the receiver", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const original = NodePath.join(directory, "original");
      const bytes = Buffer.alloc(300_001);
      for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 131) % 256;
      yield* Effect.promise(() => NodeFSP.writeFile(original, bytes));
      yield* Effect.gen(function* () {
        const source = yield* PeerTransferSource.PeerTransferSource;
        const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
        const key = {
          callerNamespace: "thread:integration",
          clientRequestId: clientId("one"),
          target,
        };
        const prepared = yield* source.prepare(key, async () => true);
        yield* Effect.promise(() => submitFile(prepared.socketPath, prepared.tokenPath, original));
        const client = PeerMcpClient.PeerMcpClient.of({
          call: ((input) => {
            const data = { ...input.arguments, owner: "authenticated-link" };
            const operation = input.tool.replace("t3_peer_transfer_", "");
            const result =
              operation === "begin"
                ? receiver.begin(data as never)
                : operation === "append"
                  ? receiver.append(data as never)
                  : operation === "finish"
                    ? receiver.finish(data as never)
                    : operation === "release"
                      ? receiver.release(data as never)
                      : receiver.status(data as never);
            return result.pipe(
              Effect.mapError(
                () => new OrchestratorMcpFailure({ code: "invalid_request", message: "refused" }),
              ),
            );
          }) as PeerMcpClient.PeerMcpClient["Service"]["call"],
        });
        yield* Effect.gen(function* () {
          const sender = yield* PeerTransferSender.PeerTransferSender;
          const request = {
            target,
            callerNamespace: key.callerNamespace,
            clientRequestId: key.clientRequestId,
            authorize: Effect.succeed(limits),
          };
          const received = yield* source.withTransfer(key, (staged) =>
            sender.transfer({
              ...request,
              sourcePath: staged.path,
              expected: { sizeBytes: staged.sizeBytes, sha256: staged.sha256 },
            }),
          );
          expect(yield* Effect.promise(() => NodeFSP.readFile(received.path))).toEqual(bytes);
          expect(received.sizeBytes).toBe(bytes.length);
          expect(yield* sender.status(request)).toEqual({ state: "finished", ...received });
          yield* sender.release(request);
          yield* source.cleanup(key);
          expect(yield* sender.status(request)).toEqual({ state: "released" });
        }).pipe(
          Effect.provide(
            PeerTransferSender.layer.pipe(
              Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            PeerTransferSource.layer({ directory: NodePath.join(directory, "source") }),
            PeerTransferReceiver.layer({
              directory: NodePath.join(directory, "destination"),
              environmentId: target,
              now: () => TEST_TIME,
            }),
          ),
        ),
      );
    }),
  ),
);

it.live("sends exact binary bytes and resolves an append with a lost response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const sourcePath = NodePath.join(directory, "source.bin");
      const source = Buffer.alloc(256 * 1024 + 123);
      for (let index = 0; index < source.length; index++) source[index] = (index * 137) % 256;
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, source));
      yield* Effect.gen(function* () {
        const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
        let lost = false;
        const methods: string[] = [];
        const client = PeerMcpClient.PeerMcpClient.of({
          call: ((input) => {
            const operation = input.tool.replace("t3_peer_transfer_", "");
            methods.push(operation);
            expect(input.environmentId).toBe(target);
            expect(input.limits).toEqual(limits);
            const data = { ...input.arguments, owner: "link-session" };
            const operationEffect =
              operation === "begin"
                ? receiver.begin(data as never)
                : operation === "append"
                  ? receiver.append(data as never)
                  : operation === "finish"
                    ? receiver.finish(data as never)
                    : operation === "abort"
                      ? receiver.abort(data as never)
                      : receiver.status(data as never);
            return operationEffect.pipe(
              Effect.mapError(
                () => new OrchestratorMcpFailure({ code: "invalid_request", message: "refused" }),
              ),
              Effect.flatMap((status) => {
                if (operation === "append" && !lost) {
                  lost = true;
                  return Effect.fail(
                    new OrchestratorMcpFailure({ code: "orchestration_error", message: "lost" }),
                  );
                }
                return Effect.succeed(status);
              }),
            );
          }) as PeerMcpClient.PeerMcpClient["Service"]["call"],
        });
        yield* Effect.gen(function* () {
          const sender = yield* PeerTransferSender.PeerTransferSender;
          const input = {
            sourcePath,
            target,
            callerNamespace: "thread:one",
            authorize: Effect.succeed(limits),
            clientRequestId: clientId("one"),
          };
          const result = yield* sender.transfer(input);
          expect(yield* Effect.promise(() => NodeFSP.readFile(result.path))).toEqual(source);
          expect(result.sizeBytes).toBe(source.length);
          expect(methods).toContain("status");
          const replay = yield* sender.transfer(input);
          expect(replay).toEqual(result);
          yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from("changed")));
          const conflict = yield* Effect.result(sender.transfer(input));
          expect(conflict._tag).toBe("Failure");
          if (conflict._tag === "Failure") expect(conflict.failure.reason).toBe("peer");
          yield* Effect.promise(() => NodeFSP.rm(sourcePath));
          expect(yield* sender.status(input)).toEqual({ state: "finished", ...result });
        }).pipe(
          Effect.provide(
            PeerTransferSender.layer.pipe(
              Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          PeerTransferReceiver.layer({
            directory: NodePath.join(directory, "destination"),
            environmentId: target,
            now: () => TEST_TIME,
          }),
        ),
      );
    }),
  ),
);

it.live("rejects link denial without exposing the peer error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const sourcePath = NodePath.join(directory, "source.bin");
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from([0, 255])));
      const client = PeerMcpClient.PeerMcpClient.of({
        call: () =>
          Effect.fail(
            new OrchestratorMcpFailure({ code: "capability_denied", message: "private URL" }),
          ),
      });
      yield* Effect.gen(function* () {
        const sender = yield* PeerTransferSender.PeerTransferSender;
        const outcome = yield* Effect.result(
          sender.transfer({
            sourcePath,
            target,
            callerNamespace: "thread",
            authorize: Effect.succeed(limits),
            clientRequestId: clientId("x"),
          }),
        );
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") {
          expect(outcome.failure.reason).toBe("denied");
          expect(outcome.failure.message).not.toContain("private URL");
        }
      }).pipe(
        Effect.provide(
          PeerTransferSender.layer.pipe(
            Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
          ),
        ),
      );
    }),
  ),
);

it.live("reports bounded destination failures without forwarding arbitrary details", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const sourcePath = NodePath.join(directory, "source.bin");
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from([1])));
      for (const [message, reason] of [
        ["Transfer failed: limit.", "quota"],
        ["Transfer failed: integrity.", "integrity"],
        ["untrusted https://example.invalid/secret", "peer"],
      ] as const) {
        const client = PeerMcpClient.PeerMcpClient.of({
          call: () => Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message })),
        });
        const result = yield* PeerTransferSender.PeerTransferSender.pipe(
          Effect.flatMap((sender) =>
            Effect.result(
              sender.transfer({
                sourcePath,
                target,
                callerNamespace: "thread",
                authorize: Effect.succeed(limits),
                clientRequestId: clientId("x"),
              }),
            ),
          ),
          Effect.provide(
            PeerTransferSender.layer.pipe(
              Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe(reason);
          expect(result.failure.message).not.toContain("example.invalid");
        }
      }
    }),
  ),
);

it.live("aborts a confirmed open transfer when interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const sourcePath = NodePath.join(directory, "source.bin");
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from([1, 2, 3])));
      const appendStarted = yield* Deferred.make<void>();
      let aborted = false;
      const client = PeerMcpClient.PeerMcpClient.of({
        call: ((input) => {
          if (input.tool === "t3_peer_transfer_begin")
            return Effect.succeed({ state: "receiving", offset: 0 });
          if (input.tool === "t3_peer_transfer_append")
            return Deferred.succeed(appendStarted, undefined).pipe(Effect.andThen(Effect.never));
          if (input.tool === "t3_peer_transfer_abort") {
            aborted = true;
            return Effect.succeed({ state: "aborted" });
          }
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "unexpected" }),
          );
        }) as PeerMcpClient.PeerMcpClient["Service"]["call"],
      });
      yield* Effect.gen(function* () {
        const sender = yield* PeerTransferSender.PeerTransferSender;
        const fiber = yield* Effect.forkChild(
          sender.transfer({
            sourcePath,
            target,
            callerNamespace: "thread",
            authorize: Effect.succeed(limits),
            clientRequestId: clientId("x"),
          }),
        );
        yield* Deferred.await(appendStarted);
        yield* Fiber.interrupt(fiber);
        expect(aborted).toBe(true);
      }).pipe(
        Effect.provide(
          PeerTransferSender.layer.pipe(
            Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
          ),
        ),
      );
    }),
  ),
);

it.live("refuses publication when the source changes while sending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const sourcePath = NodePath.join(directory, "source.bin");
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from([1, 2, 3])));
      let finished = false;
      const client = PeerMcpClient.PeerMcpClient.of({
        call: ((input) => {
          if (input.tool === "t3_peer_transfer_begin")
            return Effect.succeed({ state: "receiving", offset: 0 });
          if (input.tool === "t3_peer_transfer_append") {
            return Effect.promise(() => NodeFSP.appendFile(sourcePath, Buffer.from([4]))).pipe(
              Effect.as({ state: "receiving", offset: 3 }),
            );
          }
          if (input.tool === "t3_peer_transfer_finish") finished = true;
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "unexpected" }),
          );
        }) as PeerMcpClient.PeerMcpClient["Service"]["call"],
      });
      yield* Effect.gen(function* () {
        const sender = yield* PeerTransferSender.PeerTransferSender;
        const result = yield* Effect.result(
          sender.transfer({
            sourcePath,
            target,
            callerNamespace: "thread",
            authorize: Effect.succeed(limits),
            clientRequestId: clientId("changed"),
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("source");
        expect(finished).toBe(false);
      }).pipe(
        Effect.provide(
          PeerTransferSender.layer.pipe(
            Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
          ),
        ),
      );
    }),
  ),
);

it.live(
  "rejects a staged file that differs from its accepted digest before contacting the peer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        const sourcePath = NodePath.join(directory, "source.bin");
        yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from([1, 2, 3])));
        let calls = 0;
        const client = PeerMcpClient.PeerMcpClient.of({
          call: () => {
            calls++;
            return Effect.die("unexpected peer call");
          },
        });
        const result = yield* PeerTransferSender.PeerTransferSender.pipe(
          Effect.flatMap((sender) =>
            Effect.result(
              sender.transfer({
                sourcePath,
                expected: { sizeBytes: 3, sha256: "0".repeat(64) },
                target,
                callerNamespace: "thread",
                authorize: Effect.succeed(limits),
                clientRequestId: clientId("changed"),
              }),
            ),
          ),
          Effect.provide(
            PeerTransferSender.layer.pipe(
              Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("integrity");
        expect(calls).toBe(0);
      }),
    ),
);

it.live("rechecks caller permissions before publishing and stops on revocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixture;
      const sourcePath = NodePath.join(directory, "source.bin");
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, Buffer.from([1, 2, 3])));
      let permitted = true;
      let checks = 0;
      const methods: string[] = [];
      const authorize = Effect.suspend(() => {
        checks += 1;
        return permitted
          ? Effect.succeed(limits)
          : Effect.fail(
              new OrchestratorMcpFailure({ code: "capability_denied", message: "revoked" }),
            );
      });
      const client = PeerMcpClient.PeerMcpClient.of({
        call: ((input) => {
          methods.push(input.tool);
          if (input.tool === "t3_peer_transfer_begin")
            return Effect.succeed({ state: "receiving", offset: 0 });
          if (input.tool === "t3_peer_transfer_append") {
            permitted = false;
            return Effect.succeed({ state: "receiving", offset: 3 });
          }
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "unexpected" }),
          );
        }) as PeerMcpClient.PeerMcpClient["Service"]["call"],
      });
      yield* Effect.gen(function* () {
        const sender = yield* PeerTransferSender.PeerTransferSender;
        const result = yield* Effect.result(
          sender.transfer({
            sourcePath,
            target,
            callerNamespace: "thread",
            authorize,
            clientRequestId: clientId("revoked"),
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("denied");
        expect(checks).toBe(3);
        expect(methods).toEqual(["t3_peer_transfer_begin", "t3_peer_transfer_append"]);
      }).pipe(
        Effect.provide(
          PeerTransferSender.layer.pipe(
            Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, client)),
          ),
        ),
      );
    }),
  ),
);
