// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture binds the same platform socket or named pipe as the CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DESKTOP_BROWSER_REGISTRATION_FILE,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import { describe, expect } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

const encodeRuntimeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

async function startFakeDesktop(input: {
  readonly baseDir: string;
  readonly stateSubdirectory?: "userdata" | "dev";
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  readonly reply?: (request: DesktopAppActivationRequest) => unknown;
}) {
  const target = resolveDesktopAppControlAddress({
    stateDir: NodePath.join(input.baseDir, input.stateSubdirectory ?? "userdata"),
    platform: input.platform,
    tempDir: NodeOS.tmpdir(),
    userId: input.userId,
    joinPath: NodePath.join,
  });
  if (target.directory !== null) {
    await NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  const received: DesktopAppActivationRequest[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
      received.push(request);
      const response = input.reply
        ? input.reply(request)
        : {
            version: 1,
            requestId: request.requestId,
            ok: true,
            projectId: "project-1",
            threadId: `thread-${received.length}`,
          };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.address, resolve);
  });

  return {
    directory: target.directory,
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.directory !== null) {
        await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

const fakeDesktop = Effect.fn(function* (
  input: Omit<Parameters<typeof startFakeDesktop>[0], "platform" | "userId">,
) {
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.acquireRelease(
    Effect.promise(() => startFakeDesktop({ ...input, platform, userId })),
    (server) => Effect.promise(() => server.close()),
  );
});

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
  tempDir = NodeOS.tmpdir(),
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(tempDir, prefix))),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

describe("t3 server command safety", () => {
  it.effect("rejects unknown command words without creating a home or project", () =>
    withTempDirectory("t3-cli-unknown-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        for (const word of [
          "account",
          "login",
          "clients",
          "conenct",
          "package.json",
          "C:new-project",
        ]) {
          const error = yield* runCli([word, "--base-dir", baseDir]).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.flip,
          );
          expect(String(error)).toContain(`Unknown command "${word}"`);
          expect(yield* pathExists(word)).toBe(word === "package.json");
          expect(yield* pathExists(baseDir)).toBe(false);
        }
      }),
    ),
  );

  it.effect("refuses manual startup over a live server before creating directories", () =>
    withTempDirectory("t3-cli-running-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        const stateDir = NodePath.join(baseDir, "userdata");
        const statePath = NodePath.join(stateDir, "server-runtime.json");
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        const record = yield* encodeRuntimeState({
          version: 1,
          pid: child.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
          serviceManaged: true,
        });
        yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(statePath, record));
        const newDirectory = NodePath.join(root, "new-project");
        const platform = yield* HostProcess.Platform;
        for (const args of [
          [],
          ["start"],
          ["."],
          ["node_modules"],
          ["C:new-project"],
          [newDirectory],
          ["start", newDirectory],
        ]) {
          const error = yield* runCli(args, { T3CODE_HOME: baseDir }).pipe(
            Effect.provideService(
              HostProcess.Platform,
              args[0] === "C:new-project" ? "win32" : platform,
            ),
            Effect.flip,
          );
          expect(String(error)).toContain("A T3 Code server is already running");
          expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe(record);
          expect(yield* pathExists(newDirectory)).toBe(false);
          expect(yield* Effect.promise(() => NodeFSP.readdir(stateDir))).toEqual([
            "server-runtime.json",
          ]);
        }
      }),
    ),
  );
});

describe("t3 app", () => {
  it.live.each(["permissions", "owner", "symlink", "missing owner"] as const)(
    "rejects unsafe %s on the socket directory before sending",
    (unsafe) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        yield* withTempDirectory(
          "t3-app-unsafe-",
          (root) =>
            Effect.gen(function* () {
              const previousTmpdir = process.env.TMPDIR;
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  process.env.TMPDIR = root;
                }),
                () =>
                  Effect.sync(() => {
                    if (previousTmpdir === undefined) delete process.env.TMPDIR;
                    else process.env.TMPDIR = previousTmpdir;
                  }),
              );
              const baseDir = NodePath.join(root, ".t3");
              const userId = yield* HostProcess.UserId;
              assert(userId !== undefined);
              const expectedUserId =
                unsafe === "missing owner" ? undefined : unsafe === "owner" ? userId + 1 : userId;
              const desktop = yield* fakeDesktop({ baseDir }).pipe(
                Effect.provideService(HostProcess.UserId, expectedUserId),
              );
              const directory = desktop.directory;
              assert(directory !== null);
              if (unsafe === "permissions") {
                yield* Effect.promise(() => NodeFSP.chmod(directory, 0o755));
              } else if (unsafe === "symlink") {
                const moved = NodePath.join(root, "moved");
                yield* Effect.promise(() => NodeFSP.rename(directory, moved));
                yield* Effect.promise(() => NodeFSP.symlink(moved, directory));
              }
              const result = yield* runCli(["app"]).pipe(
                Effect.provideService(HostProcess.HomeDirectory, root),
                Effect.provideService(HostProcess.UserId, expectedUserId),
                Effect.result,
              );
              expect(desktop.received).toEqual([]);
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "DesktopAppUnreachableError" },
              });
            }).pipe(Effect.scoped),
          "/tmp",
        );
      }),
  );

  it.effect("uses T3CODE_HOME or --base-dir and sends the default or explicit path", () =>
    withTempDirectory("t3-app-command-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const explicitPath = NodePath.join(root, "project");
        const platform = yield* HostProcess.Platform;
        const workingDirectory = yield* HostProcess.WorkingDirectory;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app"], { T3CODE_HOME: baseDir });
        yield* runCli(["app", explicitPath, "--base-dir", baseDir]);

        expect(desktop.received.map((request) => request.workspaceRoot)).toEqual([
          workingDirectory,
          explicitPath,
        ]);
        expect(desktop.received.every((request) => request.platform === platform)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
    withTempDirectory("t3-app-preferred-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3");
        const desktop = yield* fakeDesktop({ baseDir });
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);

        expect(desktop.received).toHaveLength(1);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("finds the dev desktop when the default desktop socket is absent", () =>
    withTempDirectory("t3-app-dev-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);
        yield* runCli(["app"], { T3CODE_HOME: "   " });

        expect(development.received).toHaveLength(2);
        expect(yield* pathExists(baseDir)).toBe(false);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("never searches a dev state directory for an explicit T3 home", () =>
    withTempDirectory("t3-app-explicit-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        const flagError = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);
        const envError = yield* runCli(["app"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);

        expect(flagError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(envError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect.each(["failure", "invalid"] as const)(
    "never falls back after the default desktop sends a %s response",
    (responseKind) =>
      withTempDirectory("t3-app-response-test-", (root) =>
        Effect.gen(function* () {
          const baseDir = NodePath.join(root, ".t3");
          const desktop = yield* fakeDesktop({
            baseDir,
            reply: (request) =>
              responseKind === "failure"
                ? {
                    version: 1,
                    requestId: request.requestId,
                    ok: false,
                    code: "project-create-failed",
                    message: "The project path is not available.",
                  }
                : { invalid: true },
          });
          const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

          const error = yield* runCli(["app"]).pipe(Effect.flip);

          expect(desktop.received).toHaveLength(1);
          expect(development.received).toHaveLength(0);
          if (responseKind === "failure") {
            expect(error).toMatchObject({
              _tag: "DesktopAppRequestFailedError",
              code: "project-create-failed",
              requestId: desktop.received[0]?.requestId,
              workspaceRoot: yield* HostProcess.WorkingDirectory,
              message: expect.stringContaining("project-create-failed"),
              cause: {
                ok: false,
                code: "project-create-failed",
                message: "The project path is not available.",
              },
            });
          } else {
            expect(error).toMatchObject({
              _tag: "DesktopAppUnreachableError",
              cause: { message: "The desktop app response is invalid." },
            });
          }
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
      ),
  );
});

describe("SSH desktop browser helper", () => {
  it.live.each([
    "caller-eof-before-ready",
    "caller-eof-after-ready",
    "abort-before-ready",
    "wrong-epoch",
    "wrong-environment",
    "oversized-header",
  ] as const)("cleans up %s without exposing the capability", (scenario) =>
    withTempDirectory("t3-ssh-", (root) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        const endpoint =
          platform === "win32"
            ? `\\\\.\\pipe\\t3-ssh-${NodePath.basename(root)}`
            : NodePath.join(root, "channel.sock");
        const server = NodeNet.createServer();
        const peers = new Set<NodeNet.Socket>();
        const accepted = Promise.withResolvers<NodeNet.Socket>();
        const registered = Promise.withResolvers<string>();
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            server.on("connection", (socket) => {
              peers.add(socket);
              accepted.resolve(socket);
              let header = "";
              socket.on("data", (chunk) => {
                header += chunk.toString();
                if (header.includes("\n")) registered.resolve(header);
              });
            });
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(endpoint, resolve);
            });
            if (platform !== "win32") await NodeFSP.chmod(endpoint, 0o600);
          }),
          () =>
            Effect.promise(async () => {
              for (const socket of peers) socket.destroy();
              await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
            }),
        );
        const stateDir = NodePath.join(root, "userdata");
        const token = "test-only-local-capability";
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(stateDir, { mode: 0o700 });
          await NodeFSP.writeFile(
            NodePath.join(stateDir, DESKTOP_BROWSER_REGISTRATION_FILE),
            JSON.stringify({
              endpoint,
              token,
              environmentId: "target-env",
              processEpoch: "target-epoch",
              processId: process.pid,
            }),
            { mode: 0o600 },
          );
        });
        const stdin = new NodeStream.PassThrough();
        const stdout = new NodeStream.PassThrough();
        const output: string[] = [];
        const forwarded = Promise.withResolvers<void>();
        stdout.on("data", (chunk: Buffer) => {
          output.push(chunk.toString());
          if (output.join("").includes('"type":"turn"')) forwarded.resolve();
        });
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const input = Object.getOwnPropertyDescriptor(process, "stdin")!;
            const output = Object.getOwnPropertyDescriptor(process, "stdout")!;
            Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
            Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
            return { input, output };
          }),
          (original) =>
            Effect.sync(() => {
              Object.defineProperty(process, "stdin", original.input);
              Object.defineProperty(process, "stdout", original.output);
              stdin.destroy();
              stdout.destroy();
            }),
        );
        const fiber = yield* runCli([
          "__ssh-helper",
          "desktop-browser",
          "target-env",
          "--base-dir",
          root,
        ]).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.result,
          Effect.forkScoped,
        );
        const socket = yield* Effect.promise(() => accepted.promise);
        const disconnected = NodeEvents.EventEmitter.once(socket, "close");
        expect(JSON.parse(yield* Effect.promise(() => registered.promise))).toEqual({
          type: "desktop-browser-register",
          environmentId: "target-env",
          processEpoch: "target-epoch",
          token,
        });
        if (scenario === "abort-before-ready") {
          yield* Fiber.interrupt(fiber);
        } else if (scenario === "caller-eof-before-ready") {
          stdin.end();
          expect((yield* Fiber.join(fiber))._tag).toBe("Success");
        } else {
          const ready = JSON.stringify({
            type: "desktop-browser-ready",
            environmentId: scenario === "wrong-environment" ? "other-env" : "target-env",
            processEpoch: scenario === "wrong-epoch" ? "other-epoch" : "target-epoch",
          });
          const command = '{"type":"turn","threadId":"thread-1","active":true}\n';
          socket.write(scenario === "oversized-header" ? "x".repeat(8193) : `${ready}\n${command}`);
          if (scenario === "caller-eof-after-ready") {
            yield* Effect.promise(() => forwarded.promise);
            expect(output.join("")).toBe(`${ready}\n${command}`);
            stdin.end();
            expect((yield* Fiber.join(fiber))._tag).toBe("Success");
          } else {
            const result = yield* Fiber.join(fiber);
            expect(result._tag).toBe("Failure");
            expect(JSON.stringify(result)).not.toContain(token);
          }
        }
        yield* Effect.promise(() => disconnected);
        if (scenario !== "caller-eof-after-ready") expect(output.join("")).toBe("");
        for (const event of ["end", "close", "error", "readable"]) {
          expect(stdin.listenerCount(event)).toBe(0);
        }
        expect(stdout.listenerCount("close")).toBe(0);
        expect(stdout.listenerCount("error")).toBe(0);
      }).pipe(Effect.scoped),
    ),
  );
});
