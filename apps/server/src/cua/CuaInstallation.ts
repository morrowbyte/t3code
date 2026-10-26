import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import {
  CUA_RELEASE,
  cuaRelease,
  cuaArchiveMembers,
  stageCuaRuntime,
  verifyCuaBytes,
} from "./cuaRelease.ts";

export class CuaInstallationError extends Schema.TaggedError<CuaInstallationError>()(
  "CuaInstallationError",
  {
    stage: Schema.Literals(["platform", "download", "verify", "extract", "cache"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Cua Driver installation failed at ${this.stage}.`;
  }
}
export class CuaInstallation extends Context.Service<
  CuaInstallation,
  {
    readonly acquire: Effect.Effect<string, CuaInstallationError>;
  }
>()("t3/cua/CuaInstallation") {}

const isInstallationError = Schema.is(CuaInstallationError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const client = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const libc = yield* HostProcess.Libc;
  const gate = yield* Semaphore.make(1);
  const release = cuaRelease(platform, arch);
  const cacheError = (cause: unknown) => new CuaInstallationError({ stage: "cache", cause });
  const acquire = Effect.gen(function* () {
    if (!release || (platform === "linux" && libc !== "glibc"))
      return yield* new CuaInstallationError({ stage: "platform" });
    // Release packages contain the whole SDK/native closure. Never redownload over
    // corrupt shipped bytes or silently resolve another driver on PATH.
    const packaged = yield* Effect.try({
      try: () => {
        try {
          return NodeModule.findPackageJSON(
            `@trycua/cua-driver-${release.triple}`,
            import.meta.url.replace(/\.asar\//u, ".asar.unpacked/"),
          );
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ERR_MODULE_NOT_FOUND"
          )
            return undefined;
          throw cause;
        }
      },
      catch: cacheError,
    });
    const directory = path.join(
      config.baseDir,
      "cua",
      CUA_RELEASE.version,
      release.executable.sha256,
    );
    const nativeRoot = packaged
      ? path.dirname(packaged)
      : path.join(directory, "node_modules", "@trycua", `cua-driver-${release.triple}`);
    const executable = path.join(nativeRoot, release.executable.name);
    const verify = Effect.gen(function* () {
      for (const member of [release.executable, release.library, release.addon]) {
        const bytes = yield* fs
          .readFile(path.join(nativeRoot, member.name))
          .pipe(Effect.mapError(cacheError));
        yield* Effect.try({
          try: () => verifyCuaBytes(bytes, member),
          catch: (cause) => new CuaInstallationError({ stage: "verify", cause }),
        });
      }
    });
    if (packaged || (yield* fs.exists(executable).pipe(Effect.mapError(cacheError)))) {
      yield* verify;
      return executable;
    }
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(cacheError));
    const staging = yield* fs
      .makeTempDirectoryScoped({ directory, prefix: "download-" })
      .pipe(Effect.mapError(cacheError));
    const archivePath = path.join(staging, release.archive);
    let received = 0;
    yield* client
      .get(
        `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_RELEASE.version}/${release.archive}`,
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) =>
          response.stream.pipe(
            Stream.tap((chunk) =>
              Effect.gen(function* () {
                received += chunk.byteLength;
                if (received > release.archiveBytes)
                  return yield* new CuaInstallationError({ stage: "verify" });
              }),
            ),
            Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
          ),
        ),
        Effect.mapError((cause) =>
          isInstallationError(cause)
            ? cause
            : new CuaInstallationError({ stage: "download", cause }),
        ),
        Effect.timeoutOrElse({
          duration: "60 seconds",
          orElse: () => Effect.fail(new CuaInstallationError({ stage: "download" })),
        }),
      );
    const bytes = Buffer.from(yield* fs.readFile(archivePath).pipe(Effect.mapError(cacheError)));
    yield* Effect.try({
      try: () => cuaArchiveMembers(bytes, release),
      catch: (cause) => new CuaInstallationError({ stage: "verify", cause }),
    });
    yield* Effect.tryPromise({
      try: (signal) =>
        stageCuaRuntime({ destination: directory, platform, arch, archivePath, signal }),
      catch: (cause) => new CuaInstallationError({ stage: "extract", cause }),
    });
    yield* verify;
    return executable;
  }).pipe(Effect.scoped, gate.withPermits(1));
  return CuaInstallation.of({ acquire });
});
export const layer = Layer.effect(CuaInstallation, make);
