import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import type { LiveVoiceSession } from "@t3tools/contracts";

import * as CodexLiveEventHub from "./CodexLiveEventHub.ts";
import * as LiveVoiceHistory from "./LiveVoiceHistory.ts";

const hubLayer = Layer.effect(CodexLiveEventHub.CodexLiveEventHub, CodexLiveEventHub.make).pipe(
  Layer.provide(
    Layer.succeed(LiveVoiceHistory.LiveVoiceHistory, {
      record: () => Effect.void,
      list: () => Effect.die("History reads are not used by the live stream."),
      transcript: () => Effect.die("History reads are not used by the live stream."),
    }),
  ),
);

const session = {
  leaseId: "live-lease-1",
  generation: 1,
  environmentId: "env-1",
  threadId: "thread-1",
  providerInstanceId: "codex",
  providerSessionId: null,
  plannerNativeThreadId: null,
  status: "preparing",
} as LiveVoiceSession;

it.effect("starts each subscription with its correlated current status", () =>
  Effect.gen(function* () {
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    yield* hub.register(session);
    const first = yield* Stream.runHead(
      hub.subscribe({ leaseId: session.leaseId, generation: session.generation }),
    );
    assert.deepEqual(Option.getOrThrow(first), { type: "status", session });
  }).pipe(Effect.provide(hubLayer)),
);

it.effect("registers delivery before yielding the initial status barrier", () =>
  Effect.gen(function* () {
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    yield* hub.register(session);
    const events = yield* Stream.runCollect(
      hub.subscribe({ leaseId: session.leaseId, generation: session.generation }).pipe(
        Stream.tap((event) =>
          event.type === "status"
            ? hub.publish({
                type: "answer",
                leaseId: session.leaseId,
                generation: session.generation,
                sdp: "v=0",
              })
            : Effect.void,
        ),
        Stream.take(2),
      ),
    );
    assert.deepEqual(Array.from(events), [
      { type: "status", session },
      {
        type: "answer",
        leaseId: session.leaseId,
        generation: session.generation,
        sdp: "v=0",
      },
    ]);
  }).pipe(Effect.provide(hubLayer)),
);

it.effect("a stale status registration cannot replace a newer status snapshot", () =>
  Effect.gen(function* () {
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    const active = { ...session, status: "active" as const };
    yield* hub.register(session);
    yield* hub.publish({ type: "status", session: active });
    yield* hub.register(session);
    const first = yield* Stream.runHead(
      hub.subscribe({ leaseId: session.leaseId, generation: session.generation }),
    );
    assert.deepEqual(Option.getOrThrow(first), { type: "status", session: active });
  }).pipe(Effect.provide(hubLayer)),
);
