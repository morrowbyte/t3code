import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { NativeClientError, prebuildAndroid, installedBinary } from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];

// A generated Android project with Gradle and native outputs, and a stand-in for
// `expo prebuild --clean`, which deletes the directory and writes fresh sources.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

it.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});

it.effect("recognizes the fork Android development APK before considering a rebuild", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    const binary = yield* installedBinary("android", "emulator-5554", (_program, args) => {
      calls.push(args);
      return Effect.succeed(
        args.includes("list")
          ? "package:com.morrowbyte.t3code.dev"
          : args.includes("path")
            ? "package:/data/app/morrowbyte/base.apk"
            : `${"a".repeat(64)}  /data/app/morrowbyte/base.apk`,
      );
    });
    assert.strictEqual(typeof binary, "string");
    assert.deepStrictEqual(calls.slice(0, 2), [
      ["-s", "emulator-5554", "shell", "pm", "list", "packages", "com.morrowbyte.t3code.dev"],
      ["-s", "emulator-5554", "shell", "pm", "path", "com.morrowbyte.t3code.dev"],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
