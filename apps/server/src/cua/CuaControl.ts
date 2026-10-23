import type {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WindowsCuaStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CuaDriverHost from "./CuaDriverHost.ts";
import { CUA_RELEASE, cuaRelease } from "./cuaRelease.ts";

export interface CuaCaller {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly driverKind: string;
}

export class CuaUnavailableError extends Schema.TaggedError<CuaUnavailableError>()(
  "CuaUnavailableError",
  {
    reason: Schema.Literals([
      "targetMismatch",
      "unsupportedPlatform",
      "unsupportedProvider",
      "disabled",
      "busy",
      "stopped",
      "unreachableTarget",
      "incompatibleDriver",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Computer control is unavailable: ${this.reason}.`;
  }
}

export interface CuaStatus {
  readonly environmentId: EnvironmentId;
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly phase: "disabled" | "idle" | "starting" | "ready" | "stopping" | "failed";
  readonly owner: CuaCaller | null;
}

export class CuaControl extends Context.Service<
  CuaControl,
  {
    readonly status: Effect.Effect<CuaStatus>;
    readonly changes: Stream.Stream<CuaStatus>;
    readonly subscribe: (
      target: EnvironmentId,
    ) => Stream.Stream<WindowsCuaStatus, CuaUnavailableError>;
    /** Trusted settings reconciliation only; never expose enabling as an agent tool. */
    readonly setEnabled: (input: {
      readonly environmentId: EnvironmentId;
      readonly enabled: boolean;
    }) => Effect.Effect<void, CuaUnavailableError | CuaDriverHost.CuaDriverError>;
    readonly attach: (
      caller: CuaCaller,
    ) => Effect.Effect<
      CuaDriverHost.CuaConnection,
      CuaUnavailableError | CuaDriverHost.CuaDriverError
    >;
    readonly release: (
      caller: CuaCaller,
    ) => Effect.Effect<void, CuaUnavailableError | CuaDriverHost.CuaDriverError>;
    readonly stop: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, CuaUnavailableError | CuaDriverHost.CuaDriverError>;
  }
>()("t3/cua/CuaControl") {}

const sameCaller = (a: CuaCaller | null, b: CuaCaller) =>
  a !== null &&
  a.environmentId === b.environmentId &&
  a.threadId === b.threadId &&
  a.providerInstanceId === b.providerInstanceId &&
  a.providerSessionId === b.providerSessionId;

const make = Effect.gen(function* () {
  const host = yield* CuaDriverHost.CuaDriverHost;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const platform = yield* HostProcess.Platform;
  const supported =
    cuaRelease(platform, yield* HostProcess.Architecture) !== undefined &&
    (platform !== "linux" || (yield* HostProcess.Libc) === "glibc");
  const scope = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<CuaStatus>({
    environmentId,
    supported,
    enabled: false,
    phase: "disabled",
    owner: null,
  });
  let connection: CuaDriverHost.CuaConnection | undefined;
  let revision = 0;

  const requireTarget = (target: EnvironmentId) =>
    target === environmentId
      ? Effect.void
      : Effect.fail(new CuaUnavailableError({ reason: "targetMismatch" }));

  const halt = Effect.fn("CuaControl.halt")(function* (disable: boolean) {
    const ticket = ++revision;
    connection = undefined;
    yield* SubscriptionRef.update(state, (s): CuaStatus => ({
      ...s,
      enabled: disable ? false : s.enabled,
      phase: "stopping",
    }));
    // Do not queue behind start: the SDK must be allowed to cancel its in-flight startup.
    const stopped = yield* Effect.exit(host.stop);
    yield* gate.withPermits(1)(
      SubscriptionRef.update(state, (s): CuaStatus =>
        revision !== ticket
          ? s
          : {
              ...s,
              phase: Exit.isFailure(stopped) ? "failed" : s.enabled ? "idle" : "disabled",
              owner: Exit.isFailure(stopped) ? s.owner : null,
            },
      ),
    );
    return yield* stopped;
  }, Effect.uninterruptible);

  const attach = Effect.fn("CuaControl.attach")(function* (caller: CuaCaller) {
    yield* requireTarget(caller.environmentId);
    if (!supported) return yield* new CuaUnavailableError({ reason: "unsupportedPlatform" });
    if (caller.driverKind !== "codex")
      return yield* new CuaUnavailableError({ reason: "unsupportedProvider" });
    return yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (!current.enabled) return yield* new CuaUnavailableError({ reason: "disabled" });
        if (current.phase === "failed" || current.phase === "stopping")
          return yield* new CuaUnavailableError({ reason: "stopped" });
        if (connection && sameCaller(current.owner, caller)) return connection;
        if (current.owner) return yield* new CuaUnavailableError({ reason: "busy" });
        const ticket = ++revision;
        yield* SubscriptionRef.update(state, (s): CuaStatus => ({
          ...s,
          phase: "starting",
          owner: caller,
        }));
        return yield* Effect.gen(function* () {
          const started = yield* host.start.pipe(
            Effect.mapError(
              (cause) => new CuaUnavailableError({ reason: "unreachableTarget", cause }),
            ),
          );
          if (revision !== ticket) return yield* new CuaUnavailableError({ reason: "stopped" });
          if (
            started.driverVersion !== CUA_RELEASE.version ||
            started.contractVersion !== CUA_RELEASE.contractVersion
          )
            return yield* new CuaUnavailableError({ reason: "incompatibleDriver" });
          connection = started;
          yield* SubscriptionRef.update(state, (s): CuaStatus => ({ ...s, phase: "ready" }));
          yield* host.waitForExit(started.generation).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                if (revision === ticket) {
                  connection = undefined;
                  revision++;
                  yield* SubscriptionRef.update(state, (s): CuaStatus => ({
                    ...s,
                    phase: "failed",
                    owner: Exit.isSuccess(exit) ? null : s.owner,
                  }));
                }
              }),
            ),
            Effect.forkIn(scope),
          );
          return started;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || revision !== ticket
              ? Effect.void
              : Effect.gen(function* () {
                  connection = undefined;
                  const stopped = yield* Effect.exit(host.stop);
                  yield* SubscriptionRef.update(state, (s): CuaStatus => ({
                    ...s,
                    phase: "failed",
                    owner: Exit.isSuccess(stopped) ? null : s.owner,
                  }));
                }),
          ),
        );
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    halt(true).pipe(Effect.catch((cause) => Effect.logError("Cua Driver stop failed", cause))),
  );
  return CuaControl.of({
    status: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    subscribe: (target) =>
      Stream.unwrap(
        requireTarget(target).pipe(
          Effect.as(
            SubscriptionRef.changes(state).pipe(
              Stream.map((s) => ({
                environmentId: s.environmentId,
                supported: s.supported,
                enabled: s.enabled,
                phase: s.phase,
                ownerThreadId: s.owner?.threadId ?? null,
              })),
            ),
          ),
        ),
      ),
    setEnabled: Effect.fn("CuaControl.setEnabled")(function* ({
      environmentId: target,
      enabled,
    }: {
      environmentId: EnvironmentId;
      enabled: boolean;
    }) {
      yield* requireTarget(target);
      if (!enabled) return yield* halt(true);
      if (!supported) return yield* new CuaUnavailableError({ reason: "unsupportedPlatform" });
      return yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.phase === "failed" || current.phase === "stopping")
            return yield* new CuaUnavailableError({ reason: "stopped" });
          yield* SubscriptionRef.update(state, (s): CuaStatus => ({
            ...s,
            enabled: true,
            phase: s.enabled ? s.phase : "idle",
          }));
        }),
      );
    }),
    attach,
    release: Effect.fn("CuaControl.release")(function* (caller: CuaCaller) {
      yield* requireTarget(caller.environmentId);
      const current = yield* SubscriptionRef.get(state);
      if (!sameCaller(current.owner, caller)) return;
      yield* halt(false);
    }),
    stop: (target) => requireTarget(target).pipe(Effect.andThen(halt(true))),
  });
});

export const layer = Layer.effect(CuaControl, make);
