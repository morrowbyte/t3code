import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Schema from "effect/Schema";
import { openMediaFile, readMediaFileHeader } from "../assets/MediaFile.ts";

// Executable integration example: generation dispatch and identity persistence are not wired.
class CodexAgentAvatarError extends Schema.TaggedError<CodexAgentAvatarError>()(
  "CodexAgentAvatarError",
  { reason: Schema.String },
) {}

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Prepares bytes on the provider host; savedPath must never become a client URL.
 * The caller still owns generation dispatch and durable scoped-identity storage.
 */
const readCodexAgentAvatarResult = Effect.fn("readCodexAgentAvatarResult")(function* (input: {
  readonly notification: CodexSchema.V2ItemCompletedNotification;
  readonly expected: { readonly threadId: string; readonly turnId: string };
  readonly generatedImagesRoot: string;
}) {
  const { notification, expected } = input;
  const item = notification.item;
  if (notification.threadId !== expected.threadId || notification.turnId !== expected.turnId) {
    return yield* new CodexAgentAvatarError({
      reason: "Image belongs to another thread or turn",
    });
  }
  if (item.type !== "imageGeneration" || item.failure != null || item.status === "failed") {
    return yield* new CodexAgentAvatarError({ reason: "No successful image-generation result" });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!item.savedPath || !path.isAbsolute(item.savedPath) || item.savedPath.includes("\0")) {
    return yield* new CodexAgentAvatarError({ reason: "No absolute local savedPath" });
  }
  const root = yield* fs.realPath(input.generatedImagesRoot);
  const sourcePath = yield* fs.realPath(item.savedPath);
  const relative = path.relative(root, sourcePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return yield* new CodexAgentAvatarError({
      reason: "Image is outside the generated-images root",
    });
  }
  const file = yield* openMediaFile(sourcePath);
  if (!file || file.info.size === 0n || file.info.size > BigInt(MAX_AVATAR_BYTES)) {
    return yield* new CodexAgentAvatarError({ reason: "Image is not a bounded regular file" });
  }
  const bytes = yield* readMediaFileHeader(sourcePath, file, Number(file.info.size) + 1);
  if (BigInt(bytes.byteLength) !== file.info.size) {
    return yield* new CodexAgentAvatarError({
      reason: "Image changed or could not be read completely",
    });
  }
  const dimensions = readImageDimensions(bytes);
  const mimeType =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? "image/jpeg"
        : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
          ? "image/webp"
          : null;
  if (!mimeType || !dimensions || dimensions.width > 4096 || dimensions.height > 4096) {
    return yield* new CodexAgentAvatarError({ reason: "Unsupported raster image" });
  }
  return { itemId: item.id, bytes, mimeType, ...dimensions };
}, Effect.scoped);

const expected = { threadId: "native-thread", turnId: "native-turn" };
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-avatar-" });
  const generatedImagesRoot = path.join(root, "generated_images");
  yield* fs.makeDirectory(generatedImagesRoot);
  const savedPath = path.join(generatedImagesRoot, "portrait.webp");
  const bytes = yield* fs.readFile(
    path.resolve(
      import.meta.dirname,
      "../../../../packages/client-runtime/src/assets/agent-avatars/weasel-0.webp",
    ),
  );
  yield* fs.writeFile(savedPath, bytes);
  const notification = {
    ...expected,
    completedAtMs: 0,
    item: { type: "imageGeneration", id: "image-1", status: "completed", result: "", savedPath },
  } satisfies CodexSchema.V2ItemCompletedNotification;
  return { fs, path, root, generatedImagesRoot, savedPath, bytes, notification };
});

describe("Codex avatar result preparation", () => {
  it.effect(
    "reads an actual generated raster through the bounded provider-local file adapter",
    () =>
      Effect.gen(function* () {
        const input = yield* fixture;
        const result = yield* readCodexAgentAvatarResult({ ...input, expected });
        expect(result).toMatchObject({
          itemId: "image-1",
          mimeType: "image/webp",
          width: 192,
          height: 192,
        });
        expect(result.bytes).toEqual(new Uint8Array(input.bytes));
        expect(result).not.toHaveProperty("savedPath");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects another turn, inline/remote results, and generation failures", () =>
    Effect.gen(function* () {
      const input = yield* fixture;
      for (const notification of [
        { ...input.notification, turnId: "other-turn" },
        { ...input.notification, threadId: "other-thread" },
        {
          ...input.notification,
          item: {
            ...input.notification.item,
            savedPath: null,
            result: "data:image/png;base64,ignored",
          },
        },
        {
          ...input.notification,
          item: { ...input.notification.item, savedPath: "https://example.com/image.png" },
        },
        { ...input.notification, item: { ...input.notification.item, status: "failed" } },
      ]) {
        const result = yield* readCodexAgentAvatarResult({ ...input, notification, expected }).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects paths outside the generated store, including symlinks", () =>
    Effect.gen(function* () {
      const input = yield* fixture;
      const outside = input.path.join(input.root, "outside.webp");
      yield* input.fs.writeFile(outside, input.bytes);
      const alias = input.path.join(input.generatedImagesRoot, "alias.webp");
      yield* input.fs.symlink(outside, alias);
      for (const savedPath of [outside, alias]) {
        const result = yield* readCodexAgentAvatarResult({
          ...input,
          expected,
          notification: { ...input.notification, item: { ...input.notification.item, savedPath } },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a disguised SVG and an oversized file", () =>
    Effect.gen(function* () {
      const input = yield* fixture;
      for (const bytes of [
        new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        new Uint8Array(5 * 1024 * 1024 + 1),
      ]) {
        yield* input.fs.writeFile(input.savedPath, bytes);
        const result = yield* readCodexAgentAvatarResult({ ...input, expected }).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
