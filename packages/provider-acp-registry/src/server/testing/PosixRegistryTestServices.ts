// @effect-diagnostics nodeBuiltinImport:off - POSIX fixtures run on the real host filesystem and Git Bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeEffectPath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const fixturePath = (value: string) => (windowsHost ? value.replaceAll("\\", "/") : value);

const overrides = Layer.effectContext(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const hostPath = yield* Path.Path;
    const posixPath = yield* Path.Path.pipe(Effect.provide(NodeEffectPath.layerPosix));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolveExecutable = yield* SpawnExecutableResolution;
    // NTFS does not preserve POSIX executable bits; inode keys survive staged-file renames.
    const modes = new Map<bigint, number>();
    const fixtures = windowsHost
      ? FileSystem.FileSystem.of({
          ...fileSystem,
          makeTempDirectory: Effect.fn("PosixRegistryTestServices.makeTempDirectory")(
            fileSystem.makeTempDirectory,
            Effect.map(fixturePath),
          ),
          makeTempDirectoryScoped: Effect.fn("PosixRegistryTestServices.makeTempDirectoryScoped")(
            fileSystem.makeTempDirectoryScoped,
            Effect.map(fixturePath),
          ),
          realPath: Effect.fn("PosixRegistryTestServices.realPath")(
            fileSystem.realPath,
            Effect.map(fixturePath),
          ),
          chmod: Effect.fn("PosixRegistryTestServices.chmod")(function* (
            path: string,
            mode: number,
          ) {
            yield* fileSystem.chmod(path, mode);
            const info = yield* fileSystem.stat(path);
            if (Option.isSome(info.ino)) modes.set(info.ino.value, mode);
          }),
          stat: Effect.fn("PosixRegistryTestServices.stat")(
            fileSystem.stat,
            Effect.map((info) => {
              const mode = Option.isSome(info.ino) ? modes.get(info.ino.value) : undefined;
              return mode === undefined ? info : { ...info, mode: (info.mode & ~0o777) | mode };
            }),
          ),
        })
      : fileSystem;
    let bash: string | undefined;
    const fixtureSpawner = windowsHost
      ? ChildProcessSpawner.make((command) => {
          if (
            command._tag !== "StandardCommand" ||
            !/\/fake-(?:node|uv)\/bin\/(?:npm|uv)$/u.test(command.command)
          ) {
            return spawner.spawn(command);
          }
          bash ??= NodePath.resolve(
            NodeChildProcess.execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
            "../../../bin/bash.exe",
          );
          return spawner.spawn(
            ChildProcess.make(
              bash,
              [
                "-c",
                'PATH="/usr/bin:$PATH"; exec sh "$@"',
                "fixture",
                command.command,
                ...command.args,
              ],
              command.options,
            ),
          );
        })
      : spawner;
    return Context.make(FileSystem.FileSystem, fixtures).pipe(
      Context.add(
        Path.Path,
        Path.Path.of({
          ...posixPath,
          isAbsolute: (path) => posixPath.isAbsolute(path) || hostPath.isAbsolute(path),
          fromFileUrl: Effect.fn("PosixRegistryTestServices.fromFileUrl")(
            hostPath.fromFileUrl,
            Effect.map(fixturePath),
          ),
        }),
      ),
      Context.add(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner),
      Context.add(SpawnExecutableResolution, (command, platform, environment) => {
        if (!windowsHost || platform === "win32") {
          return resolveExecutable(command, platform, environment);
        }
        // Keep host drive colons while splitting the target's POSIX PATH.
        const candidates =
          command.includes("/") || command.includes("\\")
            ? [command]
            : (environment.PATH?.match(/(?:[a-z]:)?[^:]+/giu) ?? []).map((directory) =>
                posixPath.join(directory, command),
              );
        return candidates.find((candidate) => {
          if (resolveExecutable(candidate, platform, environment) === undefined) return false;
          const mode = modes.get(NodeFS.statSync(candidate, { bigint: true }).ino);
          return mode === undefined || (mode & 0o111) !== 0;
        });
      }),
    );
  }),
);

export const layer = Layer.provideMerge(overrides, NodeServices.layer);

export const runnerEnvironment = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-registry-runners-" });
  const npm = path.join(directory, "npm");
  yield* fileSystem.writeFileString(npm, "#!/bin/sh\nexit 0\n");
  yield* fileSystem.chmod(npm, 0o755);
  return { PATH: directory };
});
