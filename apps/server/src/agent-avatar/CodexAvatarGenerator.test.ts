import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { generateCodexAvatar, readCodexAvatarImage } from "./CodexAvatarGenerator.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-avatar-" });
  const savedPath = path.join(root, "portrait.webp");
  const bytes = yield* fs.readFile(
    path.resolve(
      import.meta.dirname,
      "../../../../packages/client-runtime/src/assets/agent-avatars/weasel-0.webp",
    ),
  );
  yield* fs.writeFile(savedPath, bytes);
  return { fs, path, root, savedPath, bytes };
});

describe("CodexAvatarGenerator", () => {
  it.effect(
    "reports a subscription image limit with its Unix-seconds reset even when the turn fails",
    () =>
      Effect.gen(function* () {
        let imageHandler:
          | ((input: CodexSchema.V2ItemCompletedNotification) => Effect.Effect<void>)
          | undefined;
        let turnHandler:
          | ((input: CodexSchema.V2TurnCompletedNotification) => Effect.Effect<void>)
          | undefined;
        let starts = 0;
        const client = {
          request: (method: string) =>
            Effect.gen(function* () {
              if (method === "account/read") return { account: { type: "chatgpt" } };
              if (method === "modelProvider/capabilities/read") return { imageGeneration: true };
              if (method === "config/read") return { config: {} };
              if (method === "thread/start") return { thread: { id: "native-thread" } };
              starts++;
              yield* imageHandler!({
                threadId: "native-thread",
                turnId: "native-turn",
                completedAtMs: 0,
                item: {
                  type: "imageGeneration",
                  id: "image-1",
                  status: "failed",
                  result: "",
                  savedPath: null,
                  failure: {
                    type: "usageLimitExceeded",
                    limitId: "imagegen",
                    resetsAt: 1_700_000_000,
                  },
                },
              });
              yield* turnHandler!({
                threadId: "native-thread",
                turn: { id: "native-turn", status: "failed", items: [], error: null },
              } as unknown as CodexSchema.V2TurnCompletedNotification);
              return { turn: { id: "native-turn" } };
            }),
          handleServerNotification: (method: string, handler: unknown) =>
            Effect.sync(() => {
              if (method === "item/completed") imageHandler = handler as typeof imageHandler;
              if (method === "turn/completed") turnHandler = handler as typeof turnHandler;
            }),
        } as unknown as CodexClient.CodexAppServerClient["Service"];
        const error = yield* generateCodexAvatar(
          client,
          { threadId: ThreadId.make("local"), theme: "neutral", name: "A" },
          "/tmp",
        ).pipe(Effect.flip);
        expect(error.message).toBe(
          "ChatGPT image-generation usage limit reached. Resets at 2023-11-14T22:13:20.000Z.",
        );
        expect(starts).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retains the failing RPC method without exposing provider payloads", () =>
    Effect.gen(function* () {
      const client = {
        request: () =>
          Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32601,
              errorMessage: "private credential payload",
            }),
          ),
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const error = yield* generateCodexAvatar(
        client,
        { threadId: ThreadId.make("local"), theme: "neutral", name: "A" },
        "/tmp",
      ).pipe(Effect.flip);
      expect(error.message).toBe("Codex account/read failed (method_unavailable).");
      expect(error.message).not.toContain("private");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the actual local raster without returning the provider path", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const image = yield* readCodexAvatarImage(f.savedPath);
      expect(image).toEqual({ mimeType: "image/webp", bytes: new Uint8Array(f.bytes) });
      expect(image).not.toHaveProperty("savedPath");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects symlinks, directories, remote results, SVGs and oversized files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const alias = f.path.join(f.root, "alias.webp");
      yield* f.fs.symlink(f.savedPath, alias);
      for (const name of [
        alias,
        f.root,
        "https://localhost/image.png",
        "data:image/png;base64,AAAA",
        "relative.png",
      ]) {
        expect((yield* readCodexAvatarImage(name).pipe(Effect.result))._tag).toBe("Failure");
      }
      for (const bytes of [
        new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        new Uint8Array(5 * 1024 * 1024 + 1),
      ]) {
        yield* f.fs.writeFile(f.savedPath, bytes);
        expect((yield* readCodexAvatarImage(f.savedPath).pipe(Effect.result))._tag).toBe("Failure");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "registers handlers before turn/start, accepts immediate notifications and makes exactly one request",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const requests: Array<{ method: string; input: unknown }> = [];
        let imageHandler:
          | ((input: CodexSchema.V2ItemCompletedNotification) => Effect.Effect<void>)
          | undefined;
        let turnHandler:
          | ((input: CodexSchema.V2TurnCompletedNotification) => Effect.Effect<void>)
          | undefined;
        const completed = {
          threadId: "native-thread",
          turn: { id: "native-turn", status: "completed", items: [], error: null },
        } as unknown as CodexSchema.V2TurnCompletedNotification;
        const client = {
          request: (method: string, params: unknown) =>
            Effect.gen(function* () {
              requests.push({ method, input: params });
              if (method === "account/read") return { account: { type: "chatgpt" } };
              if (method === "modelProvider/capabilities/read") return { imageGeneration: true };
              if (method === "config/read")
                return { config: { mcp_servers: { private: { command: "never-launch" } } } };
              if (method === "thread/start") return { thread: { id: "native-thread" } };
              expect(method).toBe("turn/start");
              expect(imageHandler).toBeDefined();
              expect(turnHandler).toBeDefined();
              yield* imageHandler!({
                threadId: "native-thread",
                turnId: "native-turn",
                completedAtMs: 0,
                item: {
                  type: "imageGeneration",
                  id: "image-1",
                  status: "completed",
                  result: "",
                  savedPath: f.savedPath,
                },
              });
              yield* turnHandler!(completed);
              return { turn: { id: "native-turn" } };
            }),
          handleServerNotification: (method: string, handler: unknown) =>
            Effect.sync(() => {
              if (method === "item/completed") imageHandler = handler as typeof imageHandler;
              if (method === "turn/completed") turnHandler = handler as typeof turnHandler;
            }),
        } as unknown as CodexClient.CodexAppServerClient["Service"];
        const image = yield* generateCodexAvatar(
          client,
          { threadId: ThreadId.make("local-thread"), theme: "weasel", name: "Casey" },
          f.root,
          "selected-model",
        );
        expect(image.bytes).toEqual(new Uint8Array(f.bytes));
        expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
        expect(requests.find((request) => request.method === "thread/start")?.input).toMatchObject({
          ephemeral: true,
          modelProvider: "openai",
          cwd: f.root,
          model: "selected-model",
          config: { "mcp_servers.private.enabled": false, "features.shell_tool": false },
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects API-key auth and unavailable image generation before starting a thread", () =>
    Effect.gen(function* () {
      for (const apiKey of [true, false]) {
        const calls: string[] = [];
        const client = {
          request: (method: string) => {
            calls.push(method);
            return Effect.succeed(
              method === "account/read"
                ? { account: { type: apiKey ? "apiKey" : "chatgpt" } }
                : { imageGeneration: false },
            );
          },
        } as unknown as CodexClient.CodexAppServerClient["Service"];
        const result = yield* generateCodexAvatar(
          client,
          { threadId: ThreadId.make("local"), theme: "neutral", name: "A" },
          "/tmp",
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(calls).not.toContain("thread/start");
        expect(calls).not.toContain("turn/start");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
