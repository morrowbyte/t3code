import {
  WS_METHODS,
  type EnvironmentId,
  type ConnectedEnvironmentBridgeEvent,
  type ConnectedEnvironmentBridgeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentRegistry from "./registry.ts";
import { getInitialServerConfig, requestGuarded, subscribe } from "../rpc/client.ts";
import { provideEnvironmentSessionGuard } from "../rpc/environmentSessionGuard.ts";

/** The app forwards only events received on its authenticated source session. */
const runConnectedEnvironmentBridge = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const fibers = new Map<EnvironmentId, Fiber.Fiber<void, unknown>>();
  const handle = Effect.fn("ConnectedEnvironmentBridge.handle")(function* (
    source: EnvironmentId,
    event: ConnectedEnvironmentBridgeEvent,
  ) {
    if (event.type !== "request") return;
    const execute = Effect.gen(function* () {
      const entries = yield* SubscriptionRef.get(registry.entries);
      if (event.request.type === "environments") {
        const environments: Array<{ environmentId: EnvironmentId; label: string }> = [];
        for (const [environmentId, entry] of entries) {
          if (environmentId === source || !entry.enabled) continue;
          const state = yield* registry.state(environmentId).pipe(Effect.option);
          if (Option.isSome(state) && state.value.phase === "connected")
            environments.push({ environmentId, label: entry.target.label });
        }
        return { type: "environments", environments } satisfies ConnectedEnvironmentBridgeResult;
      }
      const bridgeRequest = event.request;
      const target =
        bridgeRequest.type === "prepare"
          ? bridgeRequest.targetEnvironmentId
          : bridgeRequest.envelope.targetEnvironmentId;
      const entry = entries.get(target);
      if (
        !entry?.enabled ||
        target === source ||
        (bridgeRequest.type === "relay" && bridgeRequest.envelope.caller.environmentId !== source)
      )
        return yield* Effect.fail("Target is not a connected catalog environment.");
      const state = yield* registry.state(target);
      if (state.phase !== "connected") return yield* Effect.fail("Target is disconnected.");
      const result = yield* registry.run(
        target,
        Effect.gen(function* () {
          const config = yield* getInitialServerConfig();
          if (config.environment.environmentId !== target)
            return yield* Effect.fail("Target identity mismatch.");
          if (bridgeRequest.type === "prepare") {
            const prepared = yield* requestGuarded(WS_METHODS.connectedEnvironmentPrepare, {});
            return { type: "prepare" as const, admissionId: prepared.admissionId };
          }
          const envelope = bridgeRequest.envelope;
          if (envelope.request.type === "send")
            return {
              type: "relay" as const,
              result: yield* requestGuarded(WS_METHODS.connectedEnvironmentSend, {
                ...envelope,
                request: envelope.request,
                admissionId: envelope.admissionId ?? "",
              }),
            };
          return {
            type: "relay" as const,
            result: yield* requestGuarded(WS_METHODS.connectedEnvironmentRead, {
              ...envelope,
              request: envelope.request,
            }),
          };
        }),
      );
      return result satisfies ConnectedEnvironmentBridgeResult;
    });
    const result = yield* Effect.result(execute);
    yield* registry
      .run(
        source,
        requestGuarded(WS_METHODS.connectedEnvironmentRespond, {
          connectionId: event.connectionId,
          requestId: event.requestId,
          ...(result._tag === "Success"
            ? { result: result.success }
            : { error: "Connected environment operation failed or disconnected." }),
        }),
      )
      .pipe(Effect.ignore);
  });
  yield* Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(registry.entries)),
    SubscriptionRef.changes(registry.entries),
  ).pipe(
    Stream.runForEach((entries) =>
      Effect.gen(function* () {
        for (const [id, fiber] of fibers) {
          if (!entries.get(id)?.enabled) {
            yield* Fiber.interrupt(fiber);
            fibers.delete(id);
          }
        }
        for (const [id, entry] of entries) {
          if (!entry.enabled || fibers.has(id)) continue;
          const fiber = yield* registry
            .followStream(id, subscribe(WS_METHODS.connectedEnvironmentSubscribe, {}))
            .pipe(
              Stream.runForEach((event) => handle(id, event)),
              Effect.retry(Schedule.spaced("5 seconds")),
              Effect.forkScoped,
            );
          fibers.set(id, fiber);
        }
      }),
    ),
    provideEnvironmentSessionGuard,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(runConnectedEnvironmentBridge);
