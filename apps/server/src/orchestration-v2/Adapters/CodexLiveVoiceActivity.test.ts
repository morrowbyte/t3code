import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);
it.effect(
  "pins only successfully started realtime calls and fences closed/error/stop plus late start responses",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        type Handler = (payload: unknown) => Effect.Effect<unknown, Error>;
        const notifications = new Map<string, Handler>();
        let gate:
          | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
          | undefined;
        const request = (method: string) =>
          Effect.gen(function* () {
            if (method === "thread/realtime/start" && gate) {
              const held = gate;
              gate = undefined;
              yield* Deferred.succeed(held.entered, undefined);
              yield* Deferred.await(held.release);
            }
            return {};
          });
        const client = {
          raw: { request },
          request,
          notify: () => Effect.void,
          handleServerNotification: (method: string, handler: Handler) =>
            Effect.sync(() => {
              notifications.set(method, handler);
            }),
          handleServerRequest: () => Effect.void,
        } as unknown as CodexClient.CodexAppServerClient["Service"];
        const modelSelection = {
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          model: "selected-model",
        };
        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: modelSelection.instanceId,
          settings: yield* decodeSettings({}),
          environment: {},
          clientFactory: { open: () => Effect.succeed(client) },
          crypto: yield* Crypto.Crypto,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("live-voice-activity").pipe(Effect.orDie),
        });
        const runtime = yield* adapter.openSession({
          threadId: ThreadId.make("voice-thread"),
          providerSessionId: ProviderSessionId.make("voice-provider-session"),
          modelSelection,
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: null,
          },
        });
        const voice = runtime.liveVoice!;
        const start = () =>
          voice.start({
            plannerNativeThreadId: "voice-planner",
            realtimeSessionId: "lease:1",
            offerSdp: "offer",
          });
        assert.isFalse(yield* voice.hasActiveSession!);
        yield* start();
        assert.isTrue(yield* voice.hasActiveSession!);
        assert.isFalse(
          yield* runtime.hasPendingBackgroundWork!,
          "the voice pin is separate from background work",
        );
        yield* notifications.get("thread/realtime/closed")!({ threadId: "voice-planner" });
        assert.isFalse(yield* voice.hasActiveSession!);
        yield* start();
        yield* notifications.get("thread/realtime/error")!({ threadId: "voice-planner" });
        assert.isFalse(yield* voice.hasActiveSession!);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        gate = { entered, release };
        const pendingStart = yield* start().pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* notifications.get("thread/realtime/closed")!({ threadId: "voice-planner" });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pendingStart);
        assert.isFalse(
          yield* voice.hasActiveSession!,
          "late success cannot resurrect a closed call",
        );
        yield* start();
        yield* voice.stop("voice-planner");
        assert.isFalse(yield* voice.hasActiveSession!);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
);
