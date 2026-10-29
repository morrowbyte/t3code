import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export interface CuaConnection {
  readonly generation: string;
  readonly driverVersion: string;
  readonly contractVersion: string;
  readonly mcpProtocolVersion: string;
  readonly mcp: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  };
}

export class CuaDriverError extends Schema.TaggedError<CuaDriverError>()("CuaDriverError", {
  operation: Schema.Literals(["start", "stop", "exit"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Cua Driver ${this.operation} failed.`;
  }
}

export class CuaDriverHost extends Context.Service<
  CuaDriverHost,
  {
    readonly start: Effect.Effect<CuaConnection, CuaDriverError>;
    readonly stop: Effect.Effect<void, CuaDriverError>;
    readonly waitForExit: (generation: string) => Effect.Effect<void, CuaDriverError>;
  }
>()("t3/cua/CuaDriverHost") {}

/** The official embedded SDK owns processes, sockets, cancellation and parent liveness. */
export interface EmbeddedCuaHost {
  start(options?: { signal: AbortSignal }): Promise<CuaConnection>;
  stop(options?: { signal: AbortSignal }): Promise<void>;
  waitForExit(generation: string, options?: { signal: AbortSignal }): Promise<unknown>;
  uniffiDestroy(): void;
}

export class CuaEmbeddedSdk extends Context.Service<
  CuaEmbeddedSdk,
  { readonly acquire: Effect.Effect<EmbeddedCuaHost, CuaDriverError> }
>()("t3/cua/CuaDriverHost/CuaEmbeddedSdk") {}

const make = Effect.gen(function* () {
  const sdk = yield* CuaEmbeddedSdk;
  const gate = yield* Semaphore.make(1);
  let acquired: EmbeddedCuaHost | undefined;
  let revision = 0;
  // Construction is lazy: disabled integrations never load native code or download a driver.
  const host = gate.withPermits(1)(
    Effect.suspend(() =>
      acquired
        ? Effect.succeed(acquired)
        : sdk.acquire.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                acquired = value;
              }),
            ),
          ),
    ),
  );
  const stop = Effect.suspend(() => {
    revision++;
    return gate
      .withPermits(1)(Effect.sync(() => acquired))
      .pipe(
        Effect.flatMap((value) =>
          value
            ? Effect.tryPromise({
                try: (signal) => value.stop({ signal }),
                catch: (cause) => new CuaDriverError({ operation: "stop", cause }),
              })
            : Effect.void,
        ),
      );
  });
  yield* Effect.addFinalizer(() =>
    stop.pipe(
      Effect.ensuring(Effect.sync(() => acquired?.uniffiDestroy())),
      Effect.catch((cause) => Effect.logError("Cua Driver cleanup failed", cause)),
    ),
  );
  return CuaDriverHost.of({
    start: Effect.suspend(() => {
      const ticket = revision;
      return host.pipe(
        Effect.flatMap((value) => {
          // Disable can arrive while the application is obtaining the pinned binary/SDK.
          if (ticket !== revision)
            return Effect.fail(new CuaDriverError({ operation: "start", cause: "cancelled" }));
          return Effect.tryPromise({
            try: (signal) => value.start({ signal }),
            catch: (cause) => new CuaDriverError({ operation: "start", cause }),
          });
        }),
      );
    }),
    stop,
    waitForExit: Effect.fn("CuaDriverHost.waitForExit")((generation) =>
      host.pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: (signal) => value.waitForExit(generation, { signal }),
            catch: (cause) => new CuaDriverError({ operation: "exit", cause }),
          }),
        ),
        Effect.asVoid,
      ),
    ),
  });
});

export const layerEmbedded = Layer.effect(CuaDriverHost, make);
