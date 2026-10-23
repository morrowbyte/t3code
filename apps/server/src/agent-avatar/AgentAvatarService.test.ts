import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentAvatarError, AgentAvatarState, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as Service from "./AgentAvatarService.ts";
import * as Generator from "./CodexAvatarGenerator.ts";

const key = { threadId: ThreadId.make("avatar-agent"), theme: "weasel" as const };
const input = { ...key, name: "  Casey the Bold  " };
const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const persisted = yield* Queue.make<AgentAvatarState>();
  const requests = yield* Queue.make<Deferred.Deferred<typeof image, AgentAvatarError>>();
  const seenNames: string[] = [];
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest("/tmp", { prefix: "t3-avatar-service-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(FileSystem.FileSystem, {
      ...fs,
      rename: (from, to) =>
        fs.rename(from, to).pipe(
          Effect.tap(() =>
            to.endsWith(".json")
              ? fs.readFileString(to).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.fromJsonString(AgentAvatarState)),
                  ),
                  Effect.flatMap((state) => Queue.offer(persisted, state)),
                  Effect.orDie,
                )
              : Effect.void,
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(id === key.threadId ? liveThreadShell(id) : null),
    }),
    Layer.succeed(Generator.CodexAvatarGenerator, {
      generate: (request, preferred) =>
        Effect.gen(function* () {
          expect(preferred).toEqual(liveThreadShell(key.threadId).modelSelection);
          seenNames.push(request.name);
          const result = yield* Deferred.make<typeof image, AgentAvatarError>();
          yield* Queue.offer(requests, result);
          return yield* Deferred.await(result);
        }),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const context = yield* Layer.build(Service.layer.pipe(Layer.provideMerge(dependencies)));
  const service = Context.get(context, Service.AgentAvatarService);
  const config = Context.get(context, ServerConfig.ServerConfig);
  const awaitStatus = Effect.fn("AvatarTest.awaitStatus")(function* (
    status: AgentAvatarState["status"],
  ) {
    while (true) {
      const state = yield* Queue.take(persisted);
      if (state.status === status) return state;
    }
  });
  return { service, context, config, fs, requests, seenNames, awaitStatus };
});

describe("AgentAvatarService", () => {
  it.effect(
    "runs once per key, preserves the supplied name, persists the attachment and reuses ready after reconstruction",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        expect((yield* f.service.read(key)).status).toBe("missing");
        expect((yield* f.service.generate(input)).status).toBe("generating");
        const request = yield* Queue.take(f.requests);
        expect((yield* f.service.generate({ ...input, regenerate: true })).status).toBe(
          "generating",
        );
        expect(f.seenNames).toEqual([input.name]);
        yield* Deferred.succeed(request, image);
        const ready = yield* f.awaitStatus("ready");
        expect(ready.mimeType).toBe("image/png");
        const attachment = resolveAttachmentPathById({
          attachmentsDir: f.config.attachmentsDir,
          attachmentId: ready.attachmentId!,
        });
        expect(attachment).not.toBeNull();
        expect(new Uint8Array(yield* f.fs.readFile(attachment!))).toEqual(image.bytes);
        expect(yield* f.service.generate(input)).toEqual(ready);
        const reloaded = yield* Effect.service(Service.AgentAvatarService).pipe(
          Effect.provide(Layer.fresh(Service.layer)),
          Effect.provideContext(f.context),
        );
        expect(yield* reloaded.read(key)).toEqual(ready);
        expect(yield* reloaded.generate(input)).toEqual(ready);
        expect(f.seenNames).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "allows explicit retry after failure and cancellation while retaining the last image on regenerate",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.service.generate(input);
        yield* Deferred.fail(
          yield* Queue.take(f.requests),
          new AgentAvatarError({ message: "Image unavailable." }),
        );
        expect((yield* f.awaitStatus("failed")).attachmentId).toBeNull();
        expect((yield* f.service.generate(input)).status).toBe("generating");
        yield* Deferred.succeed(yield* Queue.take(f.requests), image);
        const ready = yield* f.awaitStatus("ready");
        const regenerating = yield* f.service.generate({ ...input, regenerate: true });
        expect(regenerating.attachmentId).toBe(ready.attachmentId);
        yield* Deferred.fail(
          yield* Queue.take(f.requests),
          new AgentAvatarError({ message: "Try later." }),
        );
        const failed = yield* f.awaitStatus("failed");
        expect(failed.attachmentId).toBe(ready.attachmentId);
        expect(failed.mimeType).toBe(ready.mimeType);
        yield* f.service.generate(input);
        yield* Queue.take(f.requests);
        const cancelled = yield* f.service.cancel(key);
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.attachmentId).toBe(ready.attachmentId);
        expect((yield* f.service.generate(input)).status).toBe("generating");
        yield* Queue.take(f.requests);
        yield* f.service.cancel(key);
        expect(f.seenNames).toHaveLength(5);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "turns an interrupted persisted generation into failure without dispatching and rejects foreign threads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.service.generate(input);
        yield* Queue.take(f.requests);
        const reloaded = yield* Effect.service(Service.AgentAvatarService).pipe(
          Effect.provide(Layer.fresh(Service.layer)),
          Effect.provideContext(f.context),
        );
        const state = yield* reloaded.read(key);
        expect(state.status).toBe("failed");
        expect(state.error).toContain("restart");
        expect((yield* reloaded.read(key)).status).toBe("failed");
        expect(f.seenNames).toHaveLength(1);
        const absent = { ...key, threadId: ThreadId.make("foreign") };
        for (const operation of [
          reloaded.read(absent),
          reloaded.generate({ ...input, ...absent }),
          reloaded.cancel(absent),
        ]) {
          expect((yield* operation.pipe(Effect.result))._tag).toBe("Failure");
        }
        yield* f.service.cancel(key);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
