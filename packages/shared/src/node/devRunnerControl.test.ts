import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { registerDevRunner, stopDevRunners } from "./devRunnerControl.ts";
it.layer(NodeServices.layer, { excludeTestServices: true })("task dev-runner reuse", (it) => {
  it.effect("reuses identical task runners without retaining another control server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspacePath = yield* fs.makeTempDirectoryScoped();
        const input = { threadId: "owner", workspacePath, reuseKey: "dev:web/default" };
        yield* registerDevRunner(input);
        const second = yield* registerDevRunner(input);
        assert.lengthOf(yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")), 1);
        assert.isTrue(second.reused);
        yield* registerDevRunner({ ...input, reuseKey: "dev:server/default" });
        assert.lengthOf(yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")), 2);
      }),
    ),
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })("task dev-runner control", (it) => {
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
        assert.deepEqual(yield* fs.readDirectory(directory), []);
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
