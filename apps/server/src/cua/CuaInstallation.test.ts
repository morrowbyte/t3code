import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as CuaInstallation from "./CuaInstallation.ts";
import { WINDOWS_CUA_RELEASE } from "./cuaRelease.ts";

it.effect("refuses corrupted cached bytes and never substitutes a PATH binary or download", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cua-install-" });
    const cache = `${directory}/cua/${WINDOWS_CUA_RELEASE.version}/${WINDOWS_CUA_RELEASE.executableSha256}`;
    yield* fs.makeDirectory(cache, { recursive: true });
    yield* fs.writeFileString(`${cache}/cua-driver.exe`, "corrupted");
    let downloads = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        downloads++;
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );
    const result = yield* Effect.gen(function* () {
      const install = yield* CuaInstallation.CuaInstallation;
      return yield* Effect.flip(install.acquire);
    }).pipe(
      Effect.provide(
        CuaInstallation.layer.pipe(
          Layer.provide(ServerConfig.layerTest(directory, directory)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
    expect(result).toMatchObject({ stage: "verify" });
    expect(downloads).toBe(0);
    expect(yield* fs.readFileString(`${cache}/cua-driver.exe`)).toBe("corrupted");
  }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
