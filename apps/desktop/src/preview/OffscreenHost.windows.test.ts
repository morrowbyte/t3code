import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeModule from "node:module";
import { expect } from "vite-plus/test";

// quarantine: #68 Native Windows Electron pixels require a Windows desktop session.
effectIt.live.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "retains native viewport pixels and guest identity across zoom",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const artifactsRoot = process.env.NATIVE_PREVIEW_ARTIFACTS;
      if (artifactsRoot) yield* fs.makeDirectory(artifactsRoot, { recursive: true, mode: 0o700 });
      const artifacts = yield* fs.makeTempDirectory({
        ...(artifactsRoot ? { directory: artifactsRoot } : {}),
        prefix: "pr68-windows-",
      });
      yield* Effect.log(`PR68 original artifacts (retained for owner review): ${artifacts}`);
      yield* Effect.addFinalizer((exit) =>
        fs
          .writeFileString(
            path.join(artifacts, "probe-exit.json"),
            JSON.stringify(
              {
                outcome: exit._tag,
                ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
              },
              null,
              2,
            ),
            { mode: 0o600 },
          )
          .pipe(Effect.orDie),
      );
      const stdout = yield* spawner.string(
        ChildProcess.make("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${process.pid}).SessionId`,
        ]),
      );
      const sessionId = Number(stdout.trim());
      yield* fs.writeFileString(
        path.join(artifacts, "session.json"),
        JSON.stringify(
          {
            platform: HostProcess.Platform.defaultValue(),
            sessionId,
            node: process.version,
            interactiveSession: Number.isInteger(sessionId) && sessionId > 0,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      expect(Number.isInteger(sessionId), "PowerShell must report the actual process session").toBe(
        true,
      );
      expect(sessionId).toBeGreaterThanOrEqual(0);

      const runtime = yield* fs.makeTempDirectoryScoped({ prefix: "pr68-electron-runtime-" });
      yield* fs.makeDirectory(path.join(runtime, "userData"), { mode: 0o700 });
      const sourcePaths = ["./OffscreenHost.ts", "../ipc/channels.ts"];
      const sources = [];
      for (const [index, relative] of sourcePaths.entries()) {
        const sourcePath = yield* path.fromFileUrl(new URL(relative, import.meta.url));
        const source = yield* fs.readFileString(sourcePath);
        const erased = NodeModule.stripTypeScriptTypes(source, { mode: "strip" });
        const output = index === 0 ? "OffscreenHost.mjs" : "channels.mjs";
        const loaded = erased.replace('"../ipc/channels.ts"', '"./channels.mjs"');
        yield* fs.writeFileString(path.join(runtime, output), loaded, { mode: 0o600 });
        yield* fs.writeFileString(path.join(artifacts, output), loaded, { mode: 0o600 });
        sources.push({
          path: sourcePath,
          sha256: Buffer.from(
            yield* crypto.digest("SHA-256", new TextEncoder().encode(source)),
          ).toString("hex"),
          loadedSha256: Buffer.from(
            yield* crypto.digest("SHA-256", yield* fs.readFile(path.join(runtime, output))),
          ).toString("hex"),
        });
      }
      yield* fs.writeFileString(
        path.join(artifacts, "sources.json"),
        JSON.stringify(
          {
            loader:
              "node:module NodeModule.stripTypeScriptTypes(mode=strip); channels relative import only",
            sources,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      const fixturePath = yield* path.fromFileUrl(new URL("./windowsFixture.mjs", import.meta.url));
      const fixture = yield* fs.readFile(fixturePath);
      yield* fs.writeFile(path.join(runtime, "windowsFixture.mjs"), fixture, { mode: 0o600 });
      yield* fs.writeFile(path.join(artifacts, "windowsFixture.mjs"), fixture, { mode: 0o600 });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const electron: string = NodeModule.createRequire(import.meta.url)("electron");
      const child = yield* spawner.spawn(
        ChildProcess.make(
          electron,
          [path.join(runtime, "windowsFixture.mjs"), path.resolve(artifacts), String(sessionId)],
          {
            env,
            extendEnv: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: false,
          },
        ),
      );
      const output = yield* Stream.run(
        child.all,
        fs.sink(path.join(artifacts, "electron.log"), { flag: "wx", mode: 0o600 }),
      ).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const running = yield* child.isRunning;
          if (running) yield* child.kill();
          const exit = yield* Effect.exit(child.exitCode);
          const outputExit = yield* Effect.exit(Fiber.join(output));
          yield* fs.writeFileString(
            path.join(artifacts, "electron-exit.json"),
            JSON.stringify(
              {
                interruptedByCleanup: running,
                output: outputExit._tag,
                ...(Exit.isFailure(outputExit)
                  ? { outputError: Cause.pretty(outputExit.cause) }
                  : {}),
                ...(Exit.isSuccess(exit)
                  ? { code: exit.value, signal: null }
                  : { error: Cause.pretty(exit.cause) }),
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        }).pipe(Effect.orDie),
      );
      const code = yield* child.exitCode;
      yield* Fiber.join(output);
      const manifest = JSON.parse(yield* fs.readFileString(path.join(artifacts, "manifest.json")));
      // The spawner fails exitCode on a signal, so a returned code proves an unsignalled exit.
      const signal = null;
      expect({ code, signal, status: manifest.status }, `Original capture: ${artifacts}`).toEqual({
        code: 0,
        signal: null,
        status: "captured-awaiting-pixel-review",
      });
      expect(manifest.stages).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
