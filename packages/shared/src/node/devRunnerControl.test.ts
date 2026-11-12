import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "../HostProcess.ts";
import { registerDevRunner, stopDevRunners } from "./devRunnerControl.ts";
it.layer(NodeServices.layer, { excludeTestServices: true })("task dev-runner reuse", (it) => {
  it.effect("reuses identical task runners without retaining another control server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
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
        const second = yield* registerDevRunner(input);
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

  it.effect.each([true, false])("acknowledges stop only after exit confirmation: %s", (stopped) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(workspacePath, ".t3", "dev-runners");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runner = yield* registerDevRunner({ threadId: "owner", workspacePath });
            const request = yield* stopDevRunners({
              threadId: "owner",
              workspacePath,
              canStop: Effect.succeed(true),
            }).pipe(Effect.forkChild);
            yield* runner.stopRequested;
            assert.lengthOf(yield* fs.readDirectory(directory), 1);
            yield* runner.confirmStopped(stopped);
            assert.strictEqual(yield* Fiber.join(request), stopped);
            assert.lengthOf(yield* fs.readDirectory(directory), stopped ? 0 : 1);
          }),
        );
        assert.lengthOf(yield* fs.readDirectory(directory), stopped ? 0 : 1);
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
    ].flatMap((kind) =>
      ["dead owner", "reboot", "windows reboot"].includes(kind)
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
                if (kind === "changed receipt")
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
          const recovery =
            operation === "cleanup"
              ? stopDevRunners({ ...input, canStop: Effect.succeed(true) }).pipe(
                  Effect.flatMap((stopped) =>
                    stopped ? Effect.void : Effect.fail(new Error("Recovery refused")),
                  ),
                )
              : registerDevRunner(input);
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
          ].includes(kind);
          assert.strictEqual(Exit.isSuccess(result), recoverable);
          if (recoverable) {
            if (operation === "cleanup") assert.isFalse(yield* fs.exists(receiptPath));
            else assert.notStrictEqual(yield* fs.readFileString(receiptPath), original);
          } else {
            assert.strictEqual(
              yield* fs.readFileString(receiptPath),
              kind === "changed receipt" ? replacement : original,
            );
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
