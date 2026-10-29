// @effect-diagnostics nodeBuiltinImport:off - preserves real fixture processes and archive extraction on Windows.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeEffectPath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const drive = NodePath.parse(process.cwd()).root.slice(0, 2);
const fixturePath = (value: string) => {
  if (!windowsHost) return value;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") && !normalized.startsWith("//")) return normalized;
  if (!normalized.toLowerCase().startsWith(`${drive.toLowerCase()}/`)) {
    throw new Error(`The POSIX fixture path must use the checkout's drive: ${value}`);
  }
  return normalized.slice(2);
};
export const shellPath = (value: string) => (windowsHost ? `${drive}${value}` : value);
export const gitBash = () =>
  NodePath.resolve(
    NodeChildProcess.execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
    "../../../bin/bash.exe",
  );

const overrides = Layer.effectContext(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const hostPath = yield* Path.Path;
    const posixPath = yield* Path.Path.pipe(Effect.provide(NodeEffectPath.layerPosix));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // NTFS loses executable bits; track explicit fixture modes and the archive's actual headers.
    const modes = new Map<bigint, number>();
    const recordMode = (path: string, mode: number) => {
      modes.set(NodeFS.statSync(path, { bigint: true }).ino, mode);
    };
    const recordArchiveModes = (archive: string, directory: string) => {
      const tar = NodeZlib.gunzipSync(NodeFS.readFileSync(archive));
      for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
        const header = tar.subarray(offset, offset + 512);
        const name = header.toString("utf8", 0, 100).replace(/\0.*$/su, "");
        const mode = Number.parseInt(header.toString("ascii", 100, 108).trim(), 8);
        const size = Number.parseInt(header.toString("ascii", 124, 136).trim(), 8);
        recordMode(posixPath.join(directory, name), mode);
        offset += 512 + Math.ceil(size / 512) * 512;
      }
    };
    const fixtures = FileSystem.FileSystem.of({
      ...fileSystem,
      makeTempDirectoryScoped: Effect.fn("CodexInstallationTestHost.makeTempDirectoryScoped")(
        fileSystem.makeTempDirectoryScoped,
        Effect.map(fixturePath),
      ),
      makeTempDirectory: Effect.fn("CodexInstallationTestHost.makeTempDirectory")(
        fileSystem.makeTempDirectory,
        Effect.map(fixturePath),
      ),
      realPath: Effect.fn("CodexInstallationTestHost.realPath")(
        fileSystem.realPath,
        Effect.map(fixturePath),
      ),
      writeFileString: Effect.fn("CodexInstallationTestHost.writeFileString")(
        fileSystem.writeFileString,
        (effect, path, _contents, options) =>
          effect.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (options?.mode !== undefined) recordMode(path, options.mode);
              }),
            ),
          ),
      ),
      chmod: Effect.fn("CodexInstallationTestHost.chmod")(function* (path: string, mode: number) {
        yield* fileSystem.chmod(path, mode);
        recordMode(path, mode);
      }),
      stat: Effect.fn("CodexInstallationTestHost.stat")(
        fileSystem.stat,
        Effect.map((info) => {
          const mode = Option.isSome(info.ino) ? modes.get(info.ino.value) : undefined;
          return mode === undefined ? info : { ...info, mode: (info.mode & ~0o777) | mode };
        }),
      ),
    });
    let bash: string | undefined;
    const fixtureSpawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return spawner.spawn(command);
      if (
        NodeFS.existsSync(command.command) &&
        NodeFS.readFileSync(command.command).subarray(0, 2).toString() === "#!"
      ) {
        bash ??= gitBash();
        return spawner.spawn(
          ChildProcess.make(bash, [shellPath(command.command), ...command.args], command.options),
        );
      }
      // libuv cannot spawn an extensionless PE file; retain the fixture's invoked basename.
      if (command.command.endsWith("/local/codex") && NodeFS.existsSync(`${command.command}.exe`)) {
        return spawner.spawn(
          ChildProcess.make(shellPath(`${command.command}.exe`), command.args, command.options),
        );
      }
      return spawner.spawn(command).pipe(
        Effect.map((child) =>
          command.args[0] === "-xzf"
            ? ChildProcessSpawner.makeHandle({
                ...child,
                exitCode: child.exitCode.pipe(
                  Effect.tap((code) =>
                    code === 0
                      ? Effect.sync(() => recordArchiveModes(command.args[1]!, command.args[3]!))
                      : Effect.void,
                  ),
                ),
              })
            : child,
        ),
      );
    });
    return Context.make(FileSystem.FileSystem, fixtures).pipe(
      Context.add(
        Path.Path,
        Path.Path.of({
          ...posixPath,
          fromFileUrl: Effect.fn("CodexInstallationTestHost.fromFileUrl")(
            hostPath.fromFileUrl,
            Effect.map(fixturePath),
          ),
        }),
      ),
      Context.add(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner),
    );
  }),
);

export const layer = windowsHost
  ? Layer.provideMerge(overrides, NodeServices.layer)
  : NodeServices.layer;
