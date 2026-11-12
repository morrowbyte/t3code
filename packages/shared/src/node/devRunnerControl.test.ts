import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "../HostProcess.ts";
import { DevRunnerControlError, registerDevRunner, stopDevRunners } from "./devRunnerControl.ts";
import * as DevShareOwnership from "./devShareOwnership.ts";
it.layer(NodeServices.layer, { excludeTestServices: true })("task dev-runner reuse", (it) => {
  it.effect("reuses identical task runners without retaining another control server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
        const nested = path.join(workspacePath, "apps", "service");
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.makeDirectory(path.join(workspacePath, ".git"));
        const input = { threadId: "owner", workspacePath, reuseKey: "dev:web/default" };
        const attempts = yield* Effect.all(
          [registerDevRunner(input).pipe(Effect.exit), registerDevRunner(input).pipe(Effect.exit)],
          { concurrency: "unbounded" },
        );
        assert.lengthOf(attempts.filter(Exit.isSuccess), 1);
        assert.lengthOf(attempts.filter(Exit.isFailure), 1);
        const first = attempts.find(Exit.isSuccess);
        assert(first !== undefined);
        const connection = {
          serverPort: "13773",
          webPort: "5733",
          baseDir: workspacePath,
          sharedUrl: "https://existing.example.ts.net:5733",
        };
        yield* first.value.ready(connection);
        const second = yield* registerDevRunner({ ...input, workspacePath: nested });
        assert.lengthOf(yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")), 1);
        assert.isTrue(second.reused);
        if (!second.reused) return assert.fail("Expected the existing connection");
        assert.deepEqual(second.connection, connection);
        yield* registerDevRunner({ ...input, reuseKey: "dev:server/default" });
        assert.lengthOf(yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")), 2);
      }),
    ),
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })("task dev-runner control", (it) => {
  it.effect.each([
    "takeover",
    "takeover start",
    "cleanup retry",
    "handshake",
    "handshake foreign",
    "partial create",
    "live orphan",
    "live descendant",
    "live owner",
    "legacy",
    "foreign route",
    "reactivated",
    "changed receipt",
  ] as const)("protects the host route generation across workspaces: %s", (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped();
        const workspaceA = path.join(home, "a");
        const workspaceB = path.join(home, "b");
        yield* fs.makeDirectory(path.join(workspaceA, ".git"), { recursive: true });
        yield* fs.makeDirectory(path.join(workspaceB, ".git"), { recursive: true });
        let bootId = "11111111-1111-1111-1111-111111111111";
        let route: string | null = null;
        let removals = 0;
        let removalSucceeds = kind !== "cleanup retry";
        let canStop = true;
        let onRead = Effect.void;
        let failNextRead = false;
        let processStart = "10";
        const ownershipA = DevShareOwnership.makeOwnership(5733);
        const ownershipB = DevShareOwnership.makeOwnership(5733);
        const target = JSON.stringify({
          TCP: { "5733": { HTTPS: true } },
          Web: { "box:5733": { Handlers: { "/": { Proxy: "http://localhost:5733" } } } },
        });
        const expectedRoute = DevShareOwnership.expectedRoute({
          port: 5733,
          host: "box",
          proxy: "http://localhost:5733",
        });
        const serve = Effect.sync(() => {
          route = target;
          failNextRead = kind.startsWith("handshake");
        }).pipe(
          Effect.andThen(
            kind === "partial create"
              ? Effect.fail(
                  new DevRunnerControlError({
                    operation: "register",
                    cause: "Serve failed after creating its route",
                  }),
                )
              : Effect.void,
          ),
        );
        const remove = Effect.sync(() => {
          removals++;
          if (removalSucceeds) route = null;
          return removalSucceeds;
        });
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          readDirectory: (directory) =>
            directory === "/proc"
              ? Effect.succeed(["12346", "12347"])
              : fs.readDirectory(directory),
          readFileString: (file, encoding) => {
            if (file === "/proc/sys/kernel/random/boot_id") return Effect.succeed(bootId);
            if (file === `/proc/${process.pid}/stat`)
              return Effect.succeed(
                `${process.pid} (controller) S ${"0 ".repeat(18)}${processStart}`,
              );
            if (file === "/proc/12346/stat")
              return kind === "live descendant"
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "readFileString",
                      pathOrDescriptor: file,
                    }),
                  )
                : Effect.succeed(`12346 (child) S ${"0 ".repeat(18)}20`);
            if (file === "/proc/12347/stat")
              return Effect.succeed(`12347 (descendant) S 1 12346 ${"0 ".repeat(16)}30`);
            return fs.readFileString(file, encoding);
          },
        });
        const run = Effect.gen(function* () {
          const creation = yield* Effect.scoped(
            Effect.gen(function* () {
              const runner = yield* registerDevRunner({
                threadId: "a",
                workspacePath: workspaceA,
                reuseKey: "web",
              });
              yield* runner.prepareShare(5733, ownershipA.generation);
              yield* DevShareOwnership.create({
                ownership: ownershipA,
                runtime: runner.runtime,
                expectedRoute,
                serve,
              });
            }),
          ).pipe(Effect.exit);
          assert.strictEqual(
            Exit.isFailure(creation),
            kind.startsWith("handshake") || kind === "partial create",
          );
          const directory = path.join(workspaceA, ".t3", "dev-runners");
          const [name] = yield* fs.readDirectory(directory);
          const receiptPath = path.join(directory, name!);
          const original = yield* fs.readFileString(receiptPath);
          if (kind === "live orphan" || kind === "live descendant") {
            const receipt = JSON.parse(original);
            receipt.launching = true;
            receipt.child = { bootId, pid: 12346, start: "20" };
            yield* fs.writeFileString(receiptPath, JSON.stringify(receipt));
            processStart = "30";
          }
          if (kind !== "live owner" && kind !== "live orphan" && kind !== "live descendant")
            bootId = "22222222-2222-2222-2222-222222222222";
          if (
            kind.startsWith("takeover") ||
            kind === "live owner" ||
            kind === "live orphan" ||
            kind === "live descendant"
          ) {
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const runner = yield* registerDevRunner({
                  threadId: "b",
                  workspacePath: workspaceB,
                });
                yield* runner.prepareShare(5733, ownershipB.generation);
                return yield* DevShareOwnership.create({
                  ownership: ownershipB,
                  runtime: runner.runtime,
                  expectedRoute,
                  serve,
                });
              }),
            ).pipe(Effect.exit);
            assert.strictEqual(Exit.isSuccess(result), kind.startsWith("takeover"));
          }
          if (kind === "legacy") {
            const parsed = JSON.parse(original);
            delete parsed.shareGeneration;
            yield* fs.writeFileString(receiptPath, JSON.stringify(parsed));
          }
          if (kind === "foreign route" || kind === "handshake foreign")
            route = JSON.stringify({
              Web: { "box:5733": { Handlers: { "/": { Proxy: "http://localhost:9999" } } } },
            });
          if (kind === "reactivated")
            onRead = Effect.sync(() => {
              canStop = false;
            });
          if (kind === "changed receipt")
            onRead = fs
              .writeFileString(
                receiptPath,
                original.replace(ownershipA.generation, ownershipB.generation),
              )
              .pipe(Effect.orDie);
          const recoverySpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const recoverShare = (
            port: number,
            generation: string | undefined,
            canRecover: Effect.Effect<boolean>,
          ) =>
            DevShareOwnership.clear({ port, generation, canClear: canRecover, remove }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recoverySpawner),
            );
          const input = {
            threadId: "a",
            workspacePath: workspaceA,
            canStop: Effect.sync(() => canStop),
            recoverShare,
          };
          const stopped =
            kind === "takeover start"
              ? yield* Effect.scoped(
                  registerDevRunner({ ...input, reuseKey: "web" }).pipe(Effect.as(true)),
                )
              : yield* stopDevRunners(input);
          const cleaned =
            kind.startsWith("takeover") || kind === "handshake" || kind === "partial create";
          assert.strictEqual(stopped, cleaned);
          assert.strictEqual(
            removals,
            ["cleanup retry", "handshake", "partial create"].includes(kind) ? 1 : 0,
          );
          if (kind === "handshake" || kind === "partial create") assert.isNull(route);
          else assert.isNotNull(route);
          assert.strictEqual(yield* fs.exists(receiptPath), !cleaned);
          if (kind.startsWith("takeover")) assert.strictEqual(route, target);
          if (kind === "cleanup retry") {
            removalSucceeds = true;
            assert.isTrue(yield* stopDevRunners(input));
            assert.strictEqual(removals, 2);
            assert.isNull(route);
            assert.isFalse(yield* fs.exists(receiptPath));
          }
        });
        yield* run.pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            spawn: () =>
              Effect.suspend(() => {
                if (failNextRead) {
                  failNextRead = false;
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "Serve status temporarily unavailable",
                    }),
                  );
                }
                return onRead.pipe(
                  Effect.map(() =>
                    ChildProcessSpawner.makeHandle({
                      pid: ChildProcessSpawner.ProcessId(2),
                      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      unref: Effect.succeed(Effect.void),
                      stdin: Sink.drain,
                      stdout: Stream.make(new TextEncoder().encode(route ?? "null")),
                      stderr: Stream.empty,
                      all: Stream.empty,
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                    }),
                  ),
                );
              }),
          }),
        );
      }),
    ),
  );

  it.effect("revalidates ownership after the runner prepares a stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
        const runner = yield* registerDevRunner({ threadId: "owner", workspacePath });
        let checks = 0;
        let stopped = false;
        const child = yield* Effect.gen(function* () {
          yield* runner.stopRequested;
          stopped = true;
          yield* runner.confirmStopped(true);
        }).pipe(Effect.forkChild);
        assert.isFalse(
          yield* stopDevRunners({
            threadId: "owner",
            workspacePath,
            canStop: Effect.sync(() => ++checks === 1),
          }),
        );
        assert.strictEqual(checks, 2);
        assert.isFalse(stopped);
        assert.lengthOf(yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")), 1);
        yield* Fiber.interrupt(child);
      }),
    ),
  );

  it.effect.each([
    { stopped: true, shareCleared: true },
    { stopped: false, shareCleared: true },
    { stopped: true, shareCleared: false },
    { stopped: true, shareCleared: true, childRunning: true },
    { stopped: undefined, shareCleared: true },
  ])(
    "acknowledges stop only after exit and share confirmation: $stopped/$shareCleared",
    ({ stopped, shareCleared, childRunning = false }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspacePath = yield* fs.makeTempDirectoryScoped();
          const directory = path.join(workspacePath, ".t3", "dev-runners");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runner = yield* registerDevRunner({ threadId: "owner", workspacePath });
              yield* runner.prepareChild;
              yield* runner.ready(
                { serverPort: "13773", webPort: "5733", baseDir: workspacePath },
                {
                  pid: 1,
                  isRunning: Effect.succeed(childRunning),
                },
              );
              if (!shareCleared) yield* runner.prepareShare(5733);
              if (stopped === undefined) return;
              const request = yield* stopDevRunners({
                threadId: "owner",
                workspacePath,
                canStop: Effect.succeed(true),
              }).pipe(Effect.forkChild);
              yield* runner.stopRequested;
              assert.lengthOf(yield* fs.readDirectory(directory), 1);
              yield* runner.confirmStopped(stopped);
              assert.strictEqual(
                yield* Fiber.join(request),
                stopped && shareCleared && !childRunning,
              );
              assert.lengthOf(
                yield* fs.readDirectory(directory),
                stopped && shareCleared && !childRunning ? 0 : 1,
              );
            }),
          );
          assert.lengthOf(
            yield* fs.readDirectory(directory),
            stopped && shareCleared && !childRunning ? 0 : 1,
          );
        }),
      ),
  );

  it.effect.each(
    [
      "dead owner",
      "reused pid",
      "reboot",
      "live owner",
      "live child",
      "unreadable",
      "legacy",
      "changed receipt",
      "windows",
      "windows reboot",
      "surviving descendant",
      "zombie group",
      "denied telemetry",
      "pending share",
      "share recovery",
      "failed share recovery",
      "changed share receipt",
      "unstarted share recovery",
    ].flatMap((kind) =>
      [
        "dead owner",
        "reboot",
        "windows reboot",
        "share recovery",
        "failed share recovery",
        "unstarted share recovery",
        "changed share receipt",
      ].includes(kind)
        ? [
            { kind, operation: "start" },
            { kind, operation: "cleanup" },
          ]
        : [{ kind, operation: "start" }],
    ),
  )(
    "recovers a stale reservation only with sufficient proof: $kind/$operation",
    ({ kind, operation }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const path = yield* Path.Path;
          const workspacePath = yield* fs.makeTempDirectoryScoped();
          const input = { threadId: "owner", workspacePath, reuseKey: "dev:web/default" };
          const directory = path.join(workspacePath, ".t3", "dev-runners");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runner = yield* registerDevRunner(input);
              yield* runner.prepareChild;
            }),
          );
          const [name] = yield* fs.readDirectory(directory);
          const receiptPath = path.join(directory, name!);
          const receipt = JSON.parse(yield* fs.readFileString(receiptPath)) as Record<
            string,
            unknown
          >;
          const bootId = "11111111-1111-1111-1111-111111111111";
          receipt.owner = { bootId, pid: 12345, start: "10" };
          receipt.child = { bootId, pid: 12346, start: "20" };
          if (kind.includes("share")) {
            receipt.sharePort = 5733;
            receipt.shareGeneration = "a".repeat(64);
          }
          if (kind === "unstarted share recovery") {
            receipt.launching = false;
            delete receipt.child;
          }
          if (kind === "legacy") {
            delete receipt.owner;
            delete receipt.child;
          }
          const original = JSON.stringify(receipt);
          yield* fs.writeFileString(receiptPath, original);
          const replacement = JSON.stringify({ ...receipt, token: "1".repeat(64) });
          const stat = (pid: number, start: string, state = "S") =>
            `${pid} (node (worker)) ${state} ${"0 ".repeat(18)}${start}`;
          const missing = (file: string) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: file,
              }),
            );
          const fileSystem = FileSystem.FileSystem.of({
            ...fs,
            readDirectory: (directoryPath) =>
              directoryPath === "/proc"
                ? Effect.succeed(["12345", "12346", "12347"])
                : fs.readDirectory(directoryPath),
            readFileString: (file, encoding) => {
              if (file === "/proc/sys/kernel/random/boot_id")
                return Effect.succeed(
                  kind === "reboot" ? "22222222-2222-2222-2222-222222222222" : bootId,
                );
              if (file === "/proc/12345/stat") {
                if (kind === "zombie group") return Effect.succeed(stat(12345, "10", "Z"));
                if (kind === "live owner") return Effect.succeed(stat(12345, "10"));
                if (kind === "reused pid") return Effect.succeed(stat(12345, "30"));
                if (kind === "unreadable") return Effect.succeed("unverifiable");
                if (kind === "denied telemetry")
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "readFileString",
                      pathOrDescriptor: file,
                    }),
                  );
                if (kind === "changed receipt" || kind === "changed share receipt")
                  return fs
                    .writeFileString(receiptPath, replacement)
                    .pipe(Effect.andThen(missing(file)));
                return missing(file);
              }
              if (file === "/proc/12346/stat")
                return kind === "live child"
                  ? Effect.succeed(stat(12346, "20"))
                  : kind === "zombie group"
                    ? Effect.succeed(stat(12346, "20", "Z"))
                    : missing(file);
              if (file === "/proc/12347/stat")
                return kind === "surviving descendant" || kind === "zombie group"
                  ? Effect.succeed(
                      `12347 (vite) ${kind === "zombie group" ? "Z" : "S"} 1 12346 ${"0 ".repeat(16)}30`,
                    )
                  : missing(file);
              return fs.readFileString(file, encoding);
            },
          });
          const recoverShare = (
            port: number,
            generation: string | undefined,
            canRecover: Effect.Effect<boolean>,
          ) =>
            Effect.gen(function* () {
              assert.strictEqual(port, 5733);
              assert.strictEqual(generation, "a".repeat(64));
              assert.isTrue(yield* canRecover);
              return kind !== "failed share recovery";
            });
          const recoveryInput = {
            ...input,
            ...(kind.includes("recovery") || kind === "changed share receipt"
              ? { recoverShare }
              : {}),
          };
          const recovery =
            operation === "cleanup"
              ? stopDevRunners({ ...recoveryInput, canStop: Effect.succeed(true) }).pipe(
                  Effect.flatMap((stopped) =>
                    stopped
                      ? Effect.void
                      : Effect.fail(
                          new DevRunnerControlError({
                            operation: "stop",
                            cause: "Recovery refused",
                          }),
                        ),
                  ),
                )
              : registerDevRunner(recoveryInput);
          const result = yield* recovery.pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              kind === "windows reboot"
                ? { ...spawner, string: () => Effect.succeed("638985000000000000") }
                : spawner,
            ),
            Effect.provideService(
              HostProcess.Platform,
              kind.startsWith("windows") ? "win32" : "linux",
            ),
            Effect.exit,
          );
          const recoverable = [
            "dead owner",
            "reused pid",
            "reboot",
            "windows reboot",
            "zombie group",
            "share recovery",
            "unstarted share recovery",
          ].includes(kind);
          assert.strictEqual(Exit.isSuccess(result), recoverable);
          if (recoverable) {
            if (operation === "cleanup") assert.isFalse(yield* fs.exists(receiptPath));
            else assert.notStrictEqual(yield* fs.readFileString(receiptPath), original);
          } else {
            assert.strictEqual(
              yield* fs.readFileString(receiptPath),
              kind === "changed receipt" || kind === "changed share receipt"
                ? replacement
                : original,
            );
            if (operation === "cleanup" && kind === "failed share recovery") {
              assert.isTrue(
                yield* stopDevRunners({
                  ...input,
                  canStop: Effect.succeed(true),
                  recoverShare: (_port, _generation, canRecover) => canRecover,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(HostProcess.Platform, "linux"),
                ),
              );
              assert.isFalse(yield* fs.exists(receiptPath));
            }
          }
        }),
      ),
  );

  it.effect.each(["active", "foreign", "workspace", "token", "malformed"] as const)(
    "preserves the runner for %s ownership",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspacePath = yield* fs.makeTempDirectoryScoped();
          const runner = yield* registerDevRunner({ threadId: "owner", workspacePath });
          const directory = path.join(workspacePath, ".t3", "dev-runners");
          const [name] = yield* fs.readDirectory(directory);
          const receiptPath = path.join(directory, name!);
          const original = yield* fs.readFileString(receiptPath);
          const receipt = JSON.parse(original) as Record<string, unknown>;
          if (kind === "workspace") receipt.workspacePath = path.join(workspacePath, "elsewhere");
          if (kind === "token") receipt.token = "0".repeat(64);
          if (["workspace", "token", "malformed"].includes(kind)) {
            yield* fs.writeFileString(
              receiptPath,
              kind === "malformed" ? "{" : JSON.stringify(receipt),
            );
          }
          assert.strictEqual(
            yield* stopDevRunners({
              threadId: kind === "foreign" ? "another-thread" : "owner",
              workspacePath,
              canStop: Effect.succeed(kind !== "active"),
            }),
            kind === "foreign",
          );
          assert.isTrue(yield* fs.exists(receiptPath));
          yield* fs.writeFileString(receiptPath, original);
          const request = yield* stopDevRunners({
            threadId: "owner",
            workspacePath,
            canStop: Effect.succeed(true),
          }).pipe(Effect.forkChild);
          yield* runner.stopRequested;
          yield* runner.confirmStopped(true);
          assert.isTrue(yield* Fiber.join(request));
        }),
      ),
  );

  it.effect("retains a changed receipt when registration is released", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(workspacePath, ".t3", "dev-runners");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* registerDevRunner({ threadId: "owner", workspacePath });
            const [name] = yield* fs.readDirectory(directory);
            yield* fs.writeFileString(path.join(directory, name!), "foreign replacement");
          }),
        );
        const [remaining] = yield* fs.readDirectory(directory);
        assert.strictEqual(
          yield* fs.readFileString(path.join(directory, remaining!)),
          "foreign replacement",
        );
      }),
    ),
  );

  it.effect("does not clear cleanup when another runner appears during stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
        const runner = yield* registerDevRunner({ threadId: "owner", workspacePath });
        const request = yield* stopDevRunners({
          threadId: "owner",
          workspacePath,
          canStop: Effect.succeed(true),
        }).pipe(Effect.forkChild);
        yield* runner.stopRequested;
        yield* registerDevRunner({ threadId: "owner", workspacePath });
        yield* runner.confirmStopped(true);
        assert.isFalse(yield* Fiber.join(request));
        assert.lengthOf(yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")), 1);
      }),
    ),
  );
});
