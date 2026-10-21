// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "@effect/platform-node/NodeStream";
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
import { openZipArchive } from "../zipArchive.ts";

import { WINDOWS_CUA_RELEASE } from "./cuaRelease.ts";

export class CuaInstallationError extends Schema.TaggedError<CuaInstallationError>()(
  "CuaInstallationError",
  {
    stage: Schema.Literals(["platform", "download", "verify", "extract", "cache"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Windows Cua Driver installation failed at ${this.stage}.`;
  }
}

export class CuaInstallation extends Context.Service<
  CuaInstallation,
  { readonly acquire: Effect.Effect<string, CuaInstallationError> }
>()("t3/cua/CuaInstallation") {}

const isInstallationError = Schema.is(CuaInstallationError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const client = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const gate = yield* Semaphore.make(1);
  const release = WINDOWS_CUA_RELEASE;
  const directory = path.join(config.baseDir, "cua", release.version, release.executableSha256);
  const executable = path.join(directory, "cua-driver.exe");
  const cacheError = (cause: unknown) => new CuaInstallationError({ stage: "cache", cause });

  const verify = Effect.fn("CuaInstallation.verify")(function* (file: string) {
    const bytes = yield* fs.readFile(file).pipe(Effect.mapError(cacheError));
    if (
      bytes.byteLength !== release.executableBytes ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== release.executableSha256
    )
      return yield* new CuaInstallationError({ stage: "verify" });
  });

  const acquire = Effect.gen(function* () {
    if (platform !== "win32" || arch !== "x64")
      return yield* new CuaInstallationError({ stage: "platform" });
    if (yield* fs.exists(executable).pipe(Effect.mapError(cacheError))) {
      yield* verify(executable);
      return executable;
    }
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(cacheError));
    const staging = yield* fs
      .makeTempDirectoryScoped({ directory, prefix: "download-" })
      .pipe(Effect.mapError(cacheError));
    const archivePath = path.join(staging, "driver.zip");
    let received = 0;
    const hash = NodeCrypto.createHash("sha256");
    yield* client.get(release.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              received += chunk.byteLength;
              if (received > release.archiveBytes)
                return yield* new CuaInstallationError({ stage: "verify" });
              hash.update(chunk);
            }),
          ),
          Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        ),
      ),
      Effect.mapError((cause) =>
        isInstallationError(cause) ? cause : new CuaInstallationError({ stage: "download", cause }),
      ),
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(new CuaInstallationError({ stage: "download" })),
      }),
    );
    if (received !== release.archiveBytes || hash.digest("hex") !== release.archiveSha256)
      return yield* new CuaInstallationError({ stage: "verify" });
    const stagedExecutable = path.join(staging, "cua-driver.exe");
    yield* Effect.gen(function* () {
      const archive = yield* openZipArchive(
        archivePath,
        (_detail, cause) => new CuaInstallationError({ stage: "extract", cause }),
      );
      let extracted = false;
      for (;;) {
        const entry = yield* archive.next;
        if (!entry) break;
        if (entry.fileName !== "cua-driver.exe") continue;
        if (extracted || entry.uncompressedSize !== release.executableBytes)
          return yield* new CuaInstallationError({ stage: "extract" });
        extracted = true;
        const readable = yield* archive.streamEntry(entry);
        yield* NodeStream.fromReadable({
          evaluate: () => readable,
          onError: (cause) => new CuaInstallationError({ stage: "extract", cause }),
        }).pipe(
          Stream.run(fs.sink(stagedExecutable, { flag: "wx", mode: 0o700 })),
          Effect.mapError((cause) => new CuaInstallationError({ stage: "extract", cause })),
        );
      }
      if (!extracted) return yield* new CuaInstallationError({ stage: "extract" });
    }).pipe(Effect.scoped);
    yield* verify(stagedExecutable);
    yield* fs.rename(stagedExecutable, executable).pipe(Effect.mapError(cacheError));
    return executable;
  }).pipe(Effect.scoped, gate.withPermits(1));

  return CuaInstallation.of({ acquire });
});

export const layer = Layer.effect(CuaInstallation, make);
