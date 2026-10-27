import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { writeBrowserScreenshot } from "./browserArtifactBudget.ts";

const oldName = "browser-screenshot-site-old-1234abcd.png";
const freshName = "browser-screenshot-site-fresh-1234abcd.png";
const newName = "browser-screenshot-site-new-1234abcd.png";

it.effect(
  "evicts old managed screenshots while protecting recent captures and unrelated files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* TestClock.setTime(1_800_000);
      yield* fs.writeFileString(path.join(root, oldName), "123456");
      yield* fs.utimes(path.join(root, oldName), 1, 1);
      yield* fs.writeFileString(path.join(root, freshName), "1234");
      yield* fs.writeFileString(path.join(root, "user-upload.png"), "keep original");
      const saved = yield* writeBrowserScreenshot({
        directory: root,
        fileName: newName,
        data: new Uint8Array(4),
        budgetBytes: 8,
      });
      expect(saved).toBe(path.join(root, newName));
      expect(yield* fs.exists(path.join(root, oldName))).toBe(false);
      expect(yield* fs.readFileString(path.join(root, "user-upload.png"))).toBe("keep original");
      expect(yield* fs.exists(path.join(root, freshName))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("serializes concurrent admissions instead of exceeding the screenshot budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const outcomes = yield* Effect.all(
      [newName, freshName].map((fileName) =>
        writeBrowserScreenshot({
          directory: root,
          fileName,
          data: new Uint8Array(4),
          budgetBytes: 6,
        }).pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
    const rejected = outcomes.find((result) => result._tag === "Failure");
    expect(rejected?._tag === "Failure" ? rejected.failure : undefined).toMatchObject({
      _tag: "BrowserArtifactBudgetError",
      reason: "capacity",
    });
    const names = yield* fs.readDirectory(root);
    expect(names).toHaveLength(1);
    expect(Number((yield* fs.stat(path.join(root, names[0]!))).size)).toBe(4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses path traversal before writing outside the screenshot store", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const outcome = yield* writeBrowserScreenshot({
      directory: root,
      fileName: "../user-document.png",
      data: new Uint8Array(4),
    }).pipe(Effect.result);
    expect(outcome._tag === "Failure" ? outcome.failure : undefined).toMatchObject({
      reason: "unsafe-path",
    });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
