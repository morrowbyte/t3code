// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it, live } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import {
  captureIdentity,
  createDevRunnerOutput,
  isProvenDead,
  reconcileDevRunnerOutputs,
  stopDevRunners,
} from "@t3tools/shared/node/devRunnerControl";
import {
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
  resolveTaskWorkspace,
  runDevRunnerWithInput,
} from "./dev-runner.ts";

const emptyConfigLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
const decodeReady = Schema.decodeUnknownSync(
  Schema.Struct({ reused: Schema.Boolean, outputPath: Schema.String }),
);
const decodeFailure = Schema.decodeUnknownSync(
  Schema.Struct({ error: Schema.String, outputPath: Schema.String }),
);
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      child: Schema.Struct({ pid: Schema.Number }),
      owner: Schema.Struct({ pid: Schema.Number }),
    }),
  ),
);
const netServiceLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(49_152),
  findAvailablePort: (port) => Effect.succeed(port),
});

function mockProcess(exit: number | PlatformError.PlatformError) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      typeof exit === "number"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
        : Effect.fail(exit),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const onceWorkerEvent = (worker: NodeChildProcess.ChildProcess, event: "message" | "exit") =>
  new Promise<ReadonlyArray<unknown>>((resolve, reject) => {
    const cleanup = () => {
      worker.off(event, success);
      worker.off("error", failure);
    };
    const success = (...values: ReadonlyArray<unknown>) => {
      cleanup();
      resolve(values);
    };
    const failure = (error: Error) => {
      cleanup();
      reject(error);
    };
    worker.once(event, success);
    worker.once("error", failure);
  });

const devServerInput = {
  mode: "dev:server",
  t3Home: "/tmp/t3code-dev-runner",
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: 13_773,
  devUrl: undefined,
  dryRun: false,
  share: false,
  built: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;

const devRunnerLayer = Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Environment, {}));
it.layer(devRunnerLayer, { excludeTestServices: true })("dev-runner", (it) => {
  describe("createDevRunnerEnv", () => {
    it.effect("forwards the reusable auth token to web dev and removes it for desktop", () =>
      Effect.gen(function* () {
        const input = {
          baseEnv: { T3CODE_DEV_AUTH_TOKEN: "reusable-dev-auth-token-that-is-long-enough" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const web = yield* createDevRunnerEnv({ ...input, mode: "dev" });
        const desktop = yield* createDevRunnerEnv({ ...input, mode: "dev:desktop" });

        assert.equal(web.T3CODE_DEV_AUTH_TOKEN, input.baseEnv.T3CODE_DEV_AUTH_TOKEN);
        assert.equal(desktop.T3CODE_DEV_AUTH_TOKEN, undefined);
      }),
    );

    it.effect("turns product analytics off unless the developer opts in", () =>
      Effect.gen(function* () {
        const input = {
          mode: "dev",
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const byDefault = yield* createDevRunnerEnv({ ...input, baseEnv: {} });
        const optedIn = yield* createDevRunnerEnv({
          ...input,
          baseEnv: { T3CODE_TELEMETRY_ENABLED: "true" },
        });

        assert.equal(byDefault.T3CODE_TELEMETRY_ENABLED, "false");
        assert.equal(optedIn.T3CODE_TELEMETRY_ENABLED, "true");
      }),
    );

    it.effect("strips inherited service-launcher context", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T3_SERVICE_LAUNCHER_CONTEXT: '{"childVersion":"9.9.9"}',
            T3_BOOT_SERVICE_UNIT: "t3code.service",
          },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3_SERVICE_LAUNCHER_CONTEXT, undefined);
        assert.equal(env.T3_BOOT_SERVICE_UNIT, undefined);
      }),
    );

    it.effect.each(["dev", "dev:web"] as const)(
      "leaves the client backend URLs unset in %s mode",
      (mode) =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {
              VITE_HTTP_URL: "http://localhost:1234",
              VITE_WS_URL: "ws://localhost:1234",
            },
            serverOffset: 0,
            webOffset: 0,
            t3Home: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.VITE_HTTP_URL, undefined);
          assert.equal(env.VITE_WS_URL, undefined);
          assert.equal(env.T3CODE_PORT, "13773");
          assert.equal(env.T3CODE_SINGLE_ORIGIN_DEV, "1");
        }),
    );

    it.effect.each(["dev", "dev:web", "dev:server"] as const)(
      "drops inherited bind addresses in %s mode",
      (mode) =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: { HOST: "0.0.0.0", T3CODE_HOST: "192.168.1.10" },
            serverOffset: 0,
            webOffset: 0,
            t3Home: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.HOST, undefined);
          assert.equal(env.T3CODE_HOST, undefined);
        }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733, 13774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("skips browser-blocked web ports before probing availability", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];
        const offset = yield* findFirstAvailableOffset({
          // 5733 + 833 = 6566, which browsers block as sane-port.
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.equal(offset, 834);
        assert.deepStrictEqual(probed, [
          { port: 14_607, role: "server" },
          { port: 6567, role: "web" },
        ]);
      }),
    );

    it.effect("does not reject a server-only offset because its unused web port is blocked", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 833);
      }),
    );
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_773,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;
              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_773, "127.0.0.1"],
          [13_773, "0.0.0.0"],
          [13_773, "::"],
        ]);
      }),
    );
  });

  describe("devPortProbeHosts", () => {
    it.effect("passes the port role so only the server port sees the bind host", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];

        yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(probed, [
          { port: 13_773, role: "server" },
          { port: 5733, role: "web" },
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });

  describe("runDevRunnerWithInput", () => {
    live.each([
      { detached: false, crashed: false, descendant: false },
      { detached: true, crashed: false, descendant: false },
      { detached: true, crashed: true, descendant: false },
      { detached: true, crashed: true, descendant: true },
    ])("retains bounded native worker stderr after failure: %j", (fixture) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { detached, crashed, descendant } = fixture;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const platform = yield* HostProcess.Platform;
          const root = yield* fs.makeTempDirectoryScoped();
          const workspace = path.join(root, "workspace");
          yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
          const directory = path.join(workspace, ".t3", "dev-runner-output");
          yield* fs.makeDirectory(directory, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(path.join(directory, "failures.sqlite"));
          try {
            db.exec(
              "CREATE TABLE failures (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)",
            );
            for (let index = 0; index < 8; index++) {
              const name = `runner-retained${index}.log`;
              NodeFS.writeFileSync(path.join(directory, name), "old failure", { mode: 0o600 });
              db.prepare("INSERT INTO failures (name) VALUES (?)").run(name);
            }
          } finally {
            db.close();
          }
          const active = yield* createDevRunnerOutput({
            workspacePath: workspace,
            threadId: "other-active-owner",
          });
          NodeFS.writeFileSync(active.path, "other active output");
          yield* Effect.addFinalizer(() => active.remove.pipe(Effect.orDie));
          const sameOwnerActive = yield* createDevRunnerOutput({
            workspacePath: workspace,
            threadId: "failed-worker-owner",
          });
          NodeFS.writeFileSync(sameOwnerActive.path, "same thread active output");
          yield* Effect.addFinalizer(() => sameOwnerActive.remove.pipe(Effect.orDie));
          const connected = yield* Deferred.make<NodeNet.Socket>();
          const sockets = new Set<NodeNet.Socket>();
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => socket.destroy());
            socket.once("data", () => Deferred.doneUnsafe(connected, Effect.succeed(socket)));
          });
          yield* Effect.acquireRelease(
            Effect.callback<void>((resume) => {
              server.listen(0, "127.0.0.1", () => resume(Effect.void));
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
          const executable = path.join(root, platform === "win32" ? "runner-fixture.cjs" : "vp");
          yield* fs.writeFileString(
            executable,
            `#!${process.execPath}
const net = require("node:net");
if (process.env.RUNNER_FIXTURE_CRASH && !process.env.RUNNER_FIXTURE_DESCENDANT) process.on("SIGTERM", () => {});
const connect = () => {
const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.env.RUNNER_FIXTURE_PORT) }, () => socket.write("ready\\n"));
socket.once("data", () => process.stdout.write(process.env.RUNNER_FIXTURE_CRASH ? "crash-output\\n" : Buffer.alloc(3 * 1024 * 1024, "x"), () => process.stderr.write("late-stderr-marker\\n", () => { if (!process.env.RUNNER_FIXTURE_CRASH) process.exit(7); })));
socket.on("end", () => process.exit(0));
};
if (process.env.RUNNER_FIXTURE_DESCENDANT) {
  const child = require("node:child_process").spawn(process.execPath, ["-e", 'const socket = require("node:net").createConnection({ host: "127.0.0.1", port: Number(process.env.RUNNER_FIXTURE_PORT) }, () => process.send("ready")); process.on("SIGTERM", () => {}); socket.on("end", () => process.exit(0));'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.once("message", connect);
} else connect();
`,
          );
          yield* fs.chmod(executable, 0o700);
          if (platform === "win32")
            yield* fs.writeFileString(
              path.join(root, "vp.cmd"),
              `@"${process.execPath}" "%~dp0runner-fixture.cjs" %*\r\n`,
            );
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeChildProcess.fork(path.join(import.meta.dirname, "dev-runner-worker.ts"), [], {
                cwd: workspace,
                execArgv: [],
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                env: {
                  ...process.env,
                  PATH: `${root}${NodePath.delimiter}${process.env.PATH ?? ""}`,
                  T3CODE_THREAD_ID: "failed-worker-owner",
                  ...(crashed ? { RUNNER_FIXTURE_CRASH: "1" } : {}),
                  ...(descendant ? { RUNNER_FIXTURE_DESCENDANT: "1" } : {}),
                  RUNNER_FIXTURE_PORT: String((server.address() as NodeNet.AddressInfo).port),
                },
              }),
            ),
            (worker) =>
              Effect.sync(() => {
                if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
              }),
          );
          const exit = onceWorkerEvent(worker, "exit");
          yield* Effect.promise(() => onceWorkerEvent(worker, "message"));
          worker.send({ ...devServerInput, t3Home: path.join(root, "state"), seed: false });
          const [raw] = yield* Effect.promise(() => onceWorkerEvent(worker, "message"));
          const ready = decodeReady(raw);
          const socket = yield* Deferred.await(connected);
          yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
          if (detached) worker.disconnect();
          const failure = detached ? undefined : onceWorkerEvent(worker, "message");
          if (crashed) {
            const logged = yield* Deferred.make<void>();
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                NodeFS.watch(ready.outputPath, () => {
                  if (NodeFS.readFileSync(ready.outputPath, "utf8").includes("late-stderr-marker"))
                    Deferred.doneUnsafe(logged, Effect.void);
                }),
              ),
              (watcher) => Effect.sync(() => watcher.close()),
            );
            socket.write("fail\n");
            yield* Deferred.await(logged);
            worker.kill("SIGKILL");
          } else socket.write("fail\n");
          if (failure !== undefined) {
            const [rawFailure] = yield* Effect.promise(() => failure);
            const value = decodeFailure(rawFailure);
            assert.strictEqual(value.outputPath, ready.outputPath);
            assert.notInclude(value.error, "late-stderr-marker");
          }
          const [code] = yield* Effect.promise(() => exit);
          assert.notStrictEqual(code, 0);
          if (crashed) {
            yield* reconcileDevRunnerOutputs({
              workspacePath: workspace,
              threadId: "failed-worker-owner",
            }).pipe(
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(
                FileSystem.FileSystem,
                FileSystem.FileSystem.of({
                  ...fs,
                  readFileString: (file, encoding) =>
                    file === "/proc/sys/kernel/random/boot_id"
                      ? Effect.succeed("unavailable")
                      : fs.readFileString(file, encoding),
                }),
              ),
            );
            assert.lengthOf(
              (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".log")),
              11,
            );
            yield* reconcileDevRunnerOutputs({
              workspacePath: workspace,
              threadId: "failed-worker-owner",
            });
          }
          assert.include(yield* fs.readFileString(ready.outputPath), "late-stderr-marker");
          assert.strictEqual(yield* fs.readFileString(active.path), "other active output");
          assert.strictEqual(
            yield* fs.readFileString(sameOwnerActive.path),
            "same thread active output",
          );
          assert.isAtMost(Number((yield* fs.stat(ready.outputPath)).size), 2 * 1024 * 1024);
          assert.lengthOf(
            (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".log")),
            10,
          );
          assert.isFalse(yield* fs.exists(path.join(directory, "runner-retained0.log")));
          if (crashed && platform === "linux") {
            const input = { workspacePath: workspace, threadId: "failed-worker-owner" };
            const receiptDirectory = path.join(workspace, ".t3", "dev-runners");
            const [name] = yield* fs.readDirectory(receiptDirectory);
            const receipt = decodeReceipt(
              yield* fs.readFileString(path.join(receiptDirectory, name!)),
            );
            const child = yield* captureIdentity(receipt.child.pid);
            assert.isDefined(child);
            assert.isTrue(
              yield* stopDevRunners({
                ...input,
                threadId: "foreign-owner",
                canStop: Effect.succeed(true),
              }),
            );
            assert.isFalse(yield* isProvenDead(child));
            assert.isFalse(yield* stopDevRunners({ ...input, canStop: Effect.succeed(false) }));
            assert.isFalse(yield* isProvenDead(child));
            if (descendant) {
              assert.isFalse(
                yield* stopDevRunners({
                  ...input,
                  canStop: isProvenDead(child).pipe(Effect.map((dead) => !dead)),
                }),
              );
              assert.isTrue(yield* isProvenDead(child));
              assert.isTrue(yield* fs.exists(path.join(receiptDirectory, name!)));
            }
            const stopped = yield* stopDevRunners({ ...input, canStop: Effect.succeed(true) });
            assert.isTrue(stopped);
            assert.isTrue(yield* isProvenDead(child));
            assert.deepEqual(
              yield* fs.readDirectory(path.join(workspace, ".t3", "dev-runners")),
              [],
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect.each(["root", "linked"] as const)(
      "resolves a canonical %s workspace from an aliased subdirectory",
      (kind) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const workspacePath = path.join(root, "workspace");
            const nested = path.join(workspacePath, "src", "nested");
            yield* fs.makeDirectory(nested, { recursive: true });
            if (kind === "root") yield* fs.makeDirectory(path.join(workspacePath, ".git"));
            else
              yield* fs.writeFileString(
                path.join(workspacePath, ".git"),
                "gitdir: /repo/.git/worktrees/task\n",
              );
            const alias = path.join(root, "alias");
            yield* fs.symlink(workspacePath, alias);
            assert.strictEqual(
              yield* resolveTaskWorkspace(path.join(alias, "src", "nested")),
              yield* fs.realPath(workspacePath),
            );
          }),
        ),
    );

    live.each(["SIGINT", "SIGTERM"] as const)(
      "retains the real scoped runner and controller across caller %s until settlement",
      (signal) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const platform = yield* HostProcess.Platform;
            const root = yield* fs.makeTempDirectoryScoped();
            const workspacePath = path.join(root, "workspace");
            const cwd = path.join(workspacePath, "src");
            yield* fs.makeDirectory(path.join(workspacePath, ".git"), { recursive: true });
            yield* fs.makeDirectory(cwd);
            const fixtureStarted = yield* Deferred.make<number>();
            const fixtureClosed = yield* Deferred.make<void>();
            const sockets = new Set<NodeNet.Socket>();
            let starts = 0;
            const server = NodeNet.createServer((socket) => {
              sockets.add(socket);
              socket.on("error", () => socket.destroy());
              let contents = "";
              socket.on("data", (chunk) => {
                contents += String(chunk);
                if (!contents.includes("\n")) return;
                starts += 1;
                Deferred.doneUnsafe(fixtureStarted, Effect.succeed(Number(contents.trim())));
              });
              socket.once("close", () => {
                sockets.delete(socket);
                Deferred.doneUnsafe(fixtureClosed, Effect.void);
              });
            });
            yield* Effect.acquireRelease(
              Effect.callback<void>((resume) => {
                server.listen(0, "127.0.0.1", () => resume(Effect.void));
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
            const executable = path.join(root, platform === "win32" ? "runner-fixture.cjs" : "vp");
            yield* fs.writeFileString(
              executable,
              `#!${process.execPath}
const net = require("node:net");
const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.env.RUNNER_FIXTURE_PORT) }, () => socket.write(String(process.pid) + "\\n"));
socket.on("close", () => process.exit(0));
process.on("SIGTERM", () => socket.end());
`,
            );
            yield* fs.chmod(executable, 0o700);
            if (platform === "win32")
              yield* fs.writeFileString(
                path.join(root, "vp.cmd"),
                `@"${process.execPath}" "%~dp0runner-fixture.cjs" %*\r\n`,
              );
            const launch = Effect.fn("test.launchTaskRunner")(function* () {
              const child = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  NodeChildProcess.fork(
                    path.join(import.meta.dirname, "dev-runner.ts"),
                    [
                      "dev:server",
                      "--home-dir",
                      path.join(root, "state"),
                      "--port",
                      "13773",
                      "--no-seed",
                    ],
                    {
                      cwd,
                      execArgv: [],
                      env: {
                        ...process.env,
                        PATH: `${root}${NodePath.delimiter}${process.env.PATH ?? ""}`,
                        T3CODE_THREAD_ID: "real-runner-owner",
                        RUNNER_FIXTURE_PORT: String((server.address() as NodeNet.AddressInfo).port),
                      },
                      stdio: ["ignore", "ignore", "ignore", "ipc"],
                    },
                  ),
                ),
                (child) =>
                  Effect.sync(() => {
                    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
                  }),
              );
              const exit = onceWorkerEvent(child, "exit");
              const ready = yield* Effect.promise(async () => {
                const [raw] = await Promise.race([
                  onceWorkerEvent(child, "message"),
                  exit.then(() => {
                    throw new Error("Runner exited before its ready receipt");
                  }),
                ]);
                return decodeReady(raw);
              });
              return { child, exit, ready };
            });
            const first = yield* launch();
            assert.isFalse(first.ready.reused);
            const childPid = yield* Deferred.await(fixtureStarted);
            const directory = path.join(workspacePath, ".t3", "dev-runners");
            const [receiptName] = yield* fs.readDirectory(directory);
            assert(receiptName !== undefined);
            const receiptPath = path.join(directory, receiptName);
            const original = yield* fs.readFileString(receiptPath);
            const receipt = decodeReceipt(original);
            if (platform !== "win32") assert.strictEqual(receipt.child.pid, childPid);
            else assert.notStrictEqual(receipt.child.pid, receipt.owner.pid);
            assert.notStrictEqual(receipt.owner.pid, first.child.pid);
            first.child.kill(signal);
            yield* Effect.promise(() => first.exit);
            assert.strictEqual(yield* fs.readFileString(receiptPath), original);
            const second = yield* launch();
            assert.isTrue(second.ready.reused);
            assert.strictEqual(second.ready.outputPath, first.ready.outputPath);
            assert.deepEqual(yield* Effect.promise(() => second.exit), [0, null]);
            assert.strictEqual(starts, 1);
            assert.isFalse(
              yield* stopDevRunners({
                threadId: "real-runner-owner",
                workspacePath,
                canStop: Effect.succeed(false),
              }),
            );
            assert.strictEqual(yield* fs.readFileString(receiptPath), original);
            const outputRemoved = yield* Deferred.make<void>();
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                NodeFS.watch(path.dirname(first.ready.outputPath), (_event, name) => {
                  if (
                    String(name) === path.basename(first.ready.outputPath) &&
                    !NodeFS.existsSync(first.ready.outputPath)
                  )
                    Deferred.doneUnsafe(outputRemoved, Effect.void);
                }),
              ),
              (watcher) => Effect.sync(() => watcher.close()),
            );
            assert.isTrue(
              yield* stopDevRunners({
                threadId: "real-runner-owner",
                workspacePath,
                canStop: Effect.succeed(true),
              }),
            );
            yield* Deferred.await(fixtureClosed);
            yield* Deferred.await(outputRemoved);
            assert.deepEqual(yield* fs.readDirectory(directory), []);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect.each(["manual", "settlement", "unconfirmed exit"] as const)(
      "preserves the distinction between %s and a normal child exit",
      (kind) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const workspacePath = yield* fs.makeTempDirectoryScoped();
            yield* fs.writeFileString(
              path.join(workspacePath, ".git"),
              "gitdir: /repo/.git/worktrees/task\n",
            );
            const spawned = yield* Deferred.make<void>();
            const exited = yield* Deferred.make<
              ChildProcessSpawner.ExitCode,
              PlatformError.PlatformError
            >();
            let running = true;
            let kills = 0;
            const spawnerLayer = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Deferred.succeed(spawned, undefined).pipe(
                  Effect.as(
                    ChildProcessSpawner.makeHandle({
                      ...mockProcess(0),
                      exitCode: Deferred.await(exited),
                      isRunning: Effect.sync(() => running),
                      kill: () =>
                        Effect.sync(() => {
                          kills += 1;
                          if (kind !== "unconfirmed exit") running = false;
                        }).pipe(
                          Effect.andThen(
                            Deferred.fail(
                              exited,
                              PlatformError.systemError({
                                _tag: "Unknown",
                                module: "ChildProcess",
                                method: "exitCode",
                                description: "SIGTERM",
                              }),
                            ),
                          ),
                          Effect.asVoid,
                        ),
                    }),
                  ),
                ),
              ),
            );
            const runner = yield* runDevRunnerWithInput({ ...devServerInput, seed: false }).pipe(
              Effect.scoped,
              Effect.provide([emptyConfigLayer, netServiceLayer, spawnerLayer]),
              Effect.provideService(HostProcess.WorkingDirectory, workspacePath),
              Effect.provideService(
                HostProcess.Environment,
                kind === "manual" ? {} : { T3CODE_THREAD_ID: "task-owner" },
              ),
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.exit,
              Effect.forkChild,
            );
            yield* Deferred.await(spawned);
            const directory = path.join(workspacePath, ".t3", "dev-runners");
            if (kind === "manual") {
              assert.isFalse(yield* fs.exists(directory));
              running = false;
              yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
              assert.strictEqual((yield* Fiber.join(runner))._tag, "Success");
              assert.strictEqual(kills, 0);
              return;
            }
            assert.lengthOf(yield* fs.readDirectory(directory), 1);
            const stopped = yield* stopDevRunners({
              threadId: "task-owner",
              workspacePath,
              canStop: Effect.succeed(true),
            });
            assert.strictEqual(stopped, kind === "settlement");
            const result = yield* Fiber.join(runner);
            assert.strictEqual(result._tag, kind === "settlement" ? "Success" : "Failure");
            assert.strictEqual(kills, 1);
            assert.lengthOf(yield* fs.readDirectory(directory), running ? 1 : 0);
          }),
        ),
    );

    it.effect("preserves process spawn context and the exact platform cause", () => {
      const cause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "vp was not found",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "spawn");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    it.effect("ignores an ambient T3CODE_HOME when no home is resolved", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { T3CODE_HOME: "/home/user/.t3" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, undefined);
      }),
    );

    it.effect("expands a home-relative T3 home the way the server does", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeFor = (t3Home: string) =>
          createDevRunnerEnv({
            mode: "dev",
            baseEnv: {},
            serverOffset: 0,
            webOffset: 0,
            t3Home,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          }).pipe(
            Effect.provideService(HostProcess.HomeDirectory, "/home/dev"),
            Effect.map((env) => env.T3CODE_HOME),
          );

        assert.equal(yield* homeFor("~/t3-dev"), path.join("/home/dev", "t3-dev"));
        assert.equal(yield* homeFor("~"), "/home/dev");
        assert.equal(yield* homeFor("~\\t3-dev"), path.join("/home/dev", "t3-dev"));
        assert.equal(yield* homeFor("  ~/t3-dev  "), path.join("/home/dev", "t3-dev"));
        assert.equal(yield* homeFor("~someone/t3-dev"), path.resolve("~someone/t3-dev"));
        assert.equal(yield* homeFor("relative/t3-dev"), path.resolve("relative/t3-dev"));
        assert.equal(yield* homeFor("/tmp/t3-dev"), path.resolve("/tmp/t3-dev"));
      }),
    );

    it.effect("rejects a specific non-loopback --host for browser dev modes", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerHostNotProxiableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev");
        assert.equal(error.host, "192.168.1.10");
        assert.include(error.message, "0.0.0.0");
        assert.include(error.message, "--share");
      });
    });

    // A shared origin means a remote browser, where unbundled dev's
    // per-module waterfall pays a tailnet round trip per import level. The
    // runner defaults bundled dev on for the spawned stack, but only
    // defaults: an explicit T3CODE_BUNDLED_DEV (even "0") must pass through.
    describe("--share spawn wiring", () => {
      const shareSpawned = (input: {
        readonly ambientBundledDev?: string | undefined;
        readonly built?: boolean;
        readonly host?: string;
        readonly reuse?: boolean;
        readonly stopUnconfirmed?: boolean;
        readonly naturalExit?: boolean;
        readonly spawnFailure?: boolean;
        readonly clearedFalse?: boolean;
      }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspacePath = yield* fs.makeTempDirectoryScoped();
          yield* fs.writeFileString(
            path.join(workspacePath, ".git"),
            "gitdir: /repo/.git/worktrees/task\n",
          );
          const ready = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const teardownEntered = yield* Deferred.make<void>();
          const teardownRelease = yield* Deferred.make<void>();
          let captured: Record<string, string | undefined> | undefined;
          let vpArgs: ReadonlyArray<string> = [];
          let vpStarts = 0;
          const tailscaleCalls: Array<ReadonlyArray<string>> = [];
          let currentRoute: { port: string; proxy: string } | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const spawned = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options?: { readonly env?: Record<string, string | undefined> };
              };
              if (spawned.command === "vp") {
                vpStarts += 1;
                captured = spawned.options?.env;
                vpArgs = spawned.args;
                if (input.spawnFailure) {
                  return Deferred.succeed(ready, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "ChildProcess",
                          method: "spawn",
                          description: "Resource temporarily unavailable",
                        }),
                      ),
                    ),
                  );
                }
                return Effect.succeed(
                  input.reuse
                    ? ChildProcessSpawner.makeHandle({
                        ...mockProcess(0),
                        isRunning: Effect.succeed(input.stopUnconfirmed ?? false),
                        exitCode: Deferred.succeed(ready, undefined).pipe(
                          Effect.andThen(Deferred.await(exited)),
                        ),
                      })
                    : mockProcess(0),
                );
              }
              tailscaleCalls.push(spawned.args);
              const offFails =
                input.clearedFalse &&
                spawned.args.includes("off") &&
                tailscaleCalls.filter((args) => args.includes("off")).length === 2;
              if (spawned.args.includes("off") && !offFails) currentRoute = undefined;
              if (spawned.args.includes("--bg"))
                currentRoute = {
                  port: spawned.args.find((arg) => arg.startsWith("--https="))!.slice(8),
                  proxy: spawned.args.at(-1)!,
                };
              const routeStatus =
                currentRoute === undefined
                  ? "null"
                  : JSON.stringify({
                      TCP: { [currentRoute.port]: { HTTPS: true } },
                      Web: {
                        [`host.example.ts.net:${currentRoute.port}`]: {
                          Handlers: { "/": { Proxy: currentRoute.proxy } },
                        },
                      },
                    });
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(2),
                  exitCode: Effect.succeed(
                    ChildProcessSpawner.ExitCode(
                      input.clearedFalse &&
                        spawned.args.includes("off") &&
                        tailscaleCalls.filter((args) => args.includes("off")).length === 2
                        ? 1
                        : 0,
                    ),
                  ),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: spawned.args.includes("status")
                    ? Stream.make(
                        new TextEncoder().encode(
                          spawned.args[0] === "serve"
                            ? routeStatus
                            : JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }),
                        ),
                      )
                    : Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              ).pipe(
                Effect.tap(() =>
                  input.reuse &&
                  !input.stopUnconfirmed &&
                  spawned.args.includes("off") &&
                  tailscaleCalls.filter((args) => args.includes("off")).length === 2
                    ? Deferred.succeed(teardownEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(teardownRelease)),
                      )
                    : Effect.void,
                ),
              );
            }),
          );

          const run = runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: input.reuse ? 13773 : undefined,
            share: true,
            built: input.built ?? false,
            host: input.host,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, {
              ...(input.ambientBundledDev === undefined
                ? {}
                : { T3CODE_BUNDLED_DEV: input.ambientBundledDev }),
              ...(input.reuse ? { T3CODE_THREAD_ID: "share-owner" } : {}),
            }),
            Effect.provideService(HostProcess.WorkingDirectory, workspacePath),
            Effect.provideService(HostProcess.HomeDirectory, workspacePath),
          );
          if (input.reuse) {
            const first = yield* run.pipe(Effect.scoped, Effect.exit, Effect.forkChild);
            yield* Deferred.await(ready);
            if (input.spawnFailure) {
              yield* Effect.gen(function* () {
                yield* Deferred.await(teardownEntered);
                assert.lengthOf(
                  yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")),
                  1,
                );
                assert.strictEqual((yield* run.pipe(Effect.scoped, Effect.exit))._tag, "Failure");
                assert.strictEqual(vpStarts, 1);
              }).pipe(Effect.ensuring(Deferred.succeed(teardownRelease, undefined)));
              assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
              assert.lengthOf(
                yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")),
                input.clearedFalse ? 1 : 0,
              );
              return { env: captured, vpArgs, tailscaleCalls };
            }
            const originalCalls = [...tailscaleCalls];
            const initialOffCount = originalCalls.filter((args) => args.includes("off")).length;
            const messages: string[] = [];
            yield* run.pipe(
              Effect.scoped,
              Effect.provide(
                Logger.layer([
                  Logger.make((options) => {
                    messages.push(String(options.message));
                  }),
                ]),
              ),
            );
            assert.strictEqual(vpStarts, 1);
            assert.deepEqual(tailscaleCalls, originalCalls);
            assert.isTrue(
              messages.some((message) =>
                message.includes(`serverPort=${captured?.T3CODE_PORT} webPort=${captured?.PORT}`),
              ),
            );
            assert.isTrue(
              messages.some((message) => message.includes("https://host.example.ts.net")),
            );
            assert.isFalse(messages.some((message) => message.includes("selectedOffset")));
            if (input.stopUnconfirmed) {
              assert.isFalse(
                yield* stopDevRunners({
                  threadId: "share-owner",
                  workspacePath,
                  canStop: Effect.succeed(true),
                }),
              );
              assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
              assert.lengthOf(
                tailscaleCalls.filter((args) => args.includes("off")),
                initialOffCount,
              );
              assert.lengthOf(
                yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")),
                1,
              );
            } else {
              const stopping = yield* (
                input.naturalExit
                  ? Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.as(true))
                  : stopDevRunners({
                      threadId: "share-owner",
                      workspacePath,
                      canStop: Effect.succeed(true),
                    })
              ).pipe(Effect.forkChild);
              yield* Effect.gen(function* () {
                yield* Deferred.await(teardownEntered);
                assert.lengthOf(
                  yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")),
                  1,
                );
                assert.strictEqual((yield* run.pipe(Effect.scoped, Effect.exit))._tag, "Failure");
                assert.strictEqual(vpStarts, 1);
              }).pipe(Effect.ensuring(Deferred.succeed(teardownRelease, undefined)));
              assert.strictEqual(
                yield* Fiber.join(stopping),
                input.naturalExit || !input.clearedFalse,
              );
              assert.strictEqual(
                (yield* Fiber.join(first))._tag,
                input.clearedFalse ? "Failure" : "Success",
              );
              assert.lengthOf(
                tailscaleCalls.filter((args) => args.includes("off")),
                initialOffCount + 1,
              );
              assert.lengthOf(
                yield* fs.readDirectory(path.join(workspacePath, ".t3", "dev-runners")),
                input.clearedFalse ? 1 : 0,
              );
            }
          } else {
            yield* run;
          }

          return { env: captured, vpArgs, tailscaleCalls };
        });

      it.effect.each([
        { stopUnconfirmed: false, naturalExit: false, spawnFailure: false },
        { stopUnconfirmed: true, naturalExit: false, spawnFailure: false },
        { stopUnconfirmed: false, naturalExit: true, spawnFailure: false },
        { stopUnconfirmed: false, naturalExit: false, spawnFailure: true },
        { stopUnconfirmed: false, naturalExit: false, spawnFailure: false, clearedFalse: true },
        { stopUnconfirmed: false, naturalExit: true, spawnFailure: false, clearedFalse: true },
        { stopUnconfirmed: false, naturalExit: false, spawnFailure: true, clearedFalse: true },
      ])(
        "keeps shared runner ownership through teardown: unconfirmed=$stopUnconfirmed natural=$naturalExit spawn=$spawnFailure clearedFalse=$clearedFalse",
        (ending) => Effect.scoped(shareSpawned({ built: true, reuse: true, ...ending })),
      );

      it.effect("keeps an explicit T3CODE_BUNDLED_DEV=0 opt-out", () =>
        Effect.gen(function* () {
          const { env } = yield* shareSpawned({ ambientBundledDev: "0" });
          assert.equal(env?.T3CODE_BUNDLED_DEV, "0");
        }),
      );

      it.effect("--built serves the backend on the web port's tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({ built: true });
          assert.include(vpArgs, "dev:built");
          assert.equal(env?.T3CODE_BUILT_DEV, "1");
          assert.equal(env?.T3CODE_BUNDLED_DEV, undefined);
          assert.equal(env?.VITE_DEV_SERVER_URL, `https://host.example.ts.net:${env?.PORT}/`);
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.deepEqual(serve?.slice(-2), [
            `--https=${env?.PORT}`,
            `http://127.0.0.1:${env?.T3CODE_PORT}`,
          ]);
        }),
      );

      it.effect("--built --host ::1 targets the backend's IPv6 loopback", () =>
        Effect.gen(function* () {
          const { env, tailscaleCalls } = yield* shareSpawned({ built: true, host: "::1" });
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://[::1]:${env?.T3CODE_PORT}`);
        }),
      );

      it.effect("without --built keeps Vite behind the tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({});
          assert.include(vpArgs, "dev");
          assert.notInclude(vpArgs, "dev:built");
          assert.equal(env?.T3CODE_BUNDLED_DEV, "1");
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://localhost:${env?.PORT}`);
        }),
      );
    });

    it.effect.each([
      { mode: "dev", share: false },
      { mode: "dev:web", share: true },
      { mode: "dev:desktop", share: true },
    ] as const)("rejects --built for $mode with share=$share", ({ mode, share }) => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode,
          port: undefined,
          share,
          built: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerBuiltNeedsShareError");
      });
    });

    it.effect.each([false, true])(
      "reports non-zero exits without losing diagnostics with a held output=%s",
      (held) => {
        const outputReceived = Deferred.makeUnsafe<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed({
              ...mockProcess(17),
              stdout: held ? Stream.never : Stream.empty,
              stderr: Stream.make(new TextEncoder().encode("failure diagnostic")),
            }),
          ),
        );

        return Effect.gen(function* () {
          const result = yield* runDevRunnerWithInput(devServerInput, undefined, () => {
            Deferred.doneUnsafe(outputReceived, Effect.void);
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.flip,
            Effect.forkChild,
          );
          yield* Deferred.await(outputReceived);
          yield* TestClock.adjust("2 seconds");
          assert.isDefined(result.pollUnsafe());
          const error = yield* Fiber.join(result);

          if (error._tag !== "DevRunnerProcessExitError") {
            assert.fail(`Unexpected error: ${error._tag}`);
          }
          assert.equal(error.mode, "dev:server");
          assert.equal(error.executable, "vp");
          assert.equal(error.argumentCount, 5);
          assert.equal(error.shell, false);
          assert.equal(error.exitCode, 17);
          assert.ok(!("cause" in error));
          assert.notProperty(error, "args");
          assert.notInclude(error.message, "secret-token-value");
        }).pipe(Effect.provide(TestClock.layer()));
      },
    );

    describe("t3 home precedence", () => {
      const makeWorktree = Effect.acquireRelease(
        Effect.sync(() => {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devrunner-"));
          NodeFS.writeFileSync(
            NodePath.join(root, ".git"),
            "gitdir: /elsewhere/.git/worktrees/x\n",
          );
          return root;
        }),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );

      const spawnedHome = (input: {
        readonly t3Home: string | undefined;
        readonly cwd: string;
        readonly ambientHome: string | undefined;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({ ...devServerInput, t3Home: input.t3Home }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.WorkingDirectory, input.cwd),
            // No ~/.t3 here, so these runs never seed from this machine's install.
            Effect.provideService(HostProcess.HomeDirectory, input.cwd),
            Effect.provideService(
              HostProcess.Environment,
              input.ambientHome === undefined ? {} : { T3CODE_HOME: input.ambientHome },
            ),
          );

          return captured?.T3CODE_HOME;
        });

      it.effect("prefers an explicit --home-dir over the worktree default", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t3Home: "/tmp/explicit-home",
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.resolve("/tmp/explicit-home"));
        }).pipe(Effect.scoped),
      );

      it.effect("treats a blank --home-dir as unset rather than as a selection", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t3Home: "   ",
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".t3"));
        }).pipe(Effect.scoped),
      );

      it.effect("prefers the worktree .t3 over an ambient T3CODE_HOME", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t3Home: undefined,
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".t3"));
        }).pipe(Effect.scoped),
      );

      it.effect("seeds a worktree database from ~/.t3 only when it has none", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = path.join(root, "home");
          NodeFS.mkdirSync(path.join(home, ".t3", "userdata"), { recursive: true });
          NodeFS.writeFileSync(path.join(home, ".t3", "userdata", "statev2.sqlite"), "");

          const spawnedArgs = (seed: boolean | undefined) =>
            Effect.gen(function* () {
              const spawned: Array<ReadonlyArray<string>> = [];
              const spawnerLayer = Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) => {
                  spawned.push(
                    (command as unknown as { readonly args: ReadonlyArray<string> }).args,
                  );
                  return Effect.succeed(mockProcess(0));
                }),
              );
              yield* runDevRunnerWithInput({ ...devServerInput, t3Home: undefined, seed }).pipe(
                Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
                Effect.provideService(HostProcess.Platform, "linux"),
                Effect.provideService(HostProcess.WorkingDirectory, root),
                Effect.provideService(HostProcess.HomeDirectory, home),
                Effect.provideService(HostProcess.Environment, {}),
              );
              return spawned.filter((args) =>
                args.some((arg) => arg.endsWith("migrate-dev-db.ts")),
              );
            });

          assert.deepStrictEqual(yield* spawnedArgs(false), []);
          const [seedArgs] = yield* spawnedArgs(undefined);
          assert.includeMembers([...(seedArgs ?? [])], ["--base-dir", path.join(root, ".t3")]);

          // Either database means the worktree already has data.
          for (const name of ["state.sqlite", "statev2.sqlite"]) {
            const file = path.join(root, ".t3", "userdata", name);
            NodeFS.mkdirSync(path.dirname(file), { recursive: true });
            NodeFS.writeFileSync(file, "");
            assert.deepStrictEqual(yield* spawnedArgs(undefined), []);
            NodeFS.rmSync(file);
          }
        }).pipe(Effect.scoped),
      );

      it.effect.each([
        { sourceBytes: 500 * 1024 * 1024 - 1, shouldSeed: true },
        { sourceBytes: 500 * 1024 * 1024, shouldSeed: true },
        { sourceBytes: 500 * 1024 * 1024 + 1, shouldSeed: false },
      ])(
        "checks source size before seeding an empty worktree: $sourceBytes bytes",
        ({ sourceBytes, shouldSeed }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* makeWorktree;
            const home = path.join(root, "home");
            const source = path.join(home, ".t3", "userdata", "statev2.sqlite");
            NodeFS.mkdirSync(path.dirname(source), { recursive: true });
            NodeFS.writeFileSync(source, "");
            const spawned: Array<ReadonlyArray<string>> = [];
            const warnings: Array<string> = [];
            const spawnerLayer = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                spawned.push((command as unknown as { readonly args: ReadonlyArray<string> }).args);
                return Effect.succeed(mockProcess(0));
              }),
            );

            yield* runDevRunnerWithInput({ ...devServerInput, t3Home: undefined }).pipe(
              Effect.provide([
                emptyConfigLayer,
                netServiceLayer,
                spawnerLayer,
                Logger.layer([
                  Logger.make((options) => {
                    if (options.logLevel === "Warn") warnings.push(String(options.message));
                  }),
                ]),
              ]),
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                stat: (file) =>
                  fs
                    .stat(file)
                    .pipe(
                      Effect.map((info) =>
                        file === source ? { ...info, size: ByteSize.bytes(sourceBytes) } : info,
                      ),
                    ),
              }),
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(HostProcess.WorkingDirectory, root),
              Effect.provideService(HostProcess.HomeDirectory, home),
              Effect.provideService(HostProcess.Environment, {}),
            );

            assert.equal(
              spawned.some((args) => args.some((arg) => arg.endsWith("migrate-dev-db.ts"))),
              shouldSeed,
            );
            assert.deepStrictEqual(spawned.at(-1), [
              "run",
              "--filter=t3",
              "dev",
              ...devServerInput.runArgs,
            ]);
            if (shouldSeed) {
              assert.deepStrictEqual(warnings, []);
            } else {
              assert.lengthOf(warnings, 1);
              assert.include(warnings[0]!, source);
              assert.include(warnings[0]!, "skipping automatic database seeding");
              assert.include(warnings[0]!, "vp run migrate-dev-db");
            }
          }).pipe(Effect.scoped),
      );

      it.effect("ignores the parent server home outside a worktree", () =>
        Effect.gen(function* () {
          const home = yield* spawnedHome({
            t3Home: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, undefined);
        }),
      );
    });
  });
});
