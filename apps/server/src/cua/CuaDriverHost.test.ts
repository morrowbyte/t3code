import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as CuaDriverHost from "./CuaDriverHost.ts";

it.effect("loads nothing while disabled and destroys the SDK on orderly shutdown", () =>
  Effect.gen(function* () {
    let acquired = 0;
    let stopped = 0;
    let destroyed = 0;
    const sdk = Layer.succeed(CuaDriverHost.CuaEmbeddedSdk, {
      acquire: Effect.sync(() => {
        acquired++;
        return {
          start: async () => ({
            generation: "one",
            driverVersion: "0.37.0",
            contractVersion: "0.8.0",
            mcpProtocolVersion: "fixture",
            mcp: { command: "driver", args: [], environment: [] },
          }),
          stop: async () => {
            stopped++;
          },
          waitForExit: async () => {},
          uniffiDestroy: () => {
            destroyed++;
          },
        };
      }),
    });
    const layer = CuaDriverHost.layerEmbedded.pipe(Layer.provide(sdk));
    yield* Effect.gen(function* () {
      const host = yield* CuaDriverHost.CuaDriverHost;
      yield* host.stop;
      expect(acquired).toBe(0);
      yield* host.start;
      yield* host.start;
      expect(acquired).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
    expect(stopped).toBe(1);
    expect(destroyed).toBe(1);
  }),
);

it.effect("a stop during binary/SDK acquisition prevents a late native start", () =>
  Effect.gen(function* () {
    const acquiring = yield* Deferred.make<void>();
    const acquired = yield* Deferred.make<void>();
    let starts = 0;
    let stops = 0;
    const sdk = Layer.succeed(CuaDriverHost.CuaEmbeddedSdk, {
      acquire: Deferred.succeed(acquiring, undefined).pipe(
        Effect.andThen(Deferred.await(acquired)),
        Effect.as({
          start: async () => {
            starts++;
            throw new Error("Must not start");
          },
          stop: async () => {
            stops++;
          },
          waitForExit: async () => {},
          uniffiDestroy: () => {},
        }),
      ),
    });
    yield* Effect.gen(function* () {
      const host = yield* CuaDriverHost.CuaDriverHost;
      const start = yield* host.start.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(acquiring);
      // The adapter increments its stop fence before it waits for acquisition.
      const stop = yield* host.stop.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(acquired, undefined);
      expect(yield* Fiber.join(start)).toMatchObject({ operation: "start" });
      yield* Fiber.join(stop);
      expect(starts).toBe(0);
      expect(stops).toBe(1);
    }).pipe(Effect.provide(CuaDriverHost.layerEmbedded.pipe(Layer.provide(sdk))), Effect.scoped);
  }),
);
