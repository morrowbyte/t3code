import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CuaControl from "./CuaControl.ts";
import * as CuaDriverHost from "./CuaDriverHost.ts";

const environmentId = EnvironmentId.make("windows-target");
const caller: CuaControl.CuaCaller = {
  environmentId,
  threadId: ThreadId.make("thread-one"),
  providerInstanceId: ProviderInstanceId.make("codex-one"),
  providerSessionId: "session-one",
  driverKind: "codex",
};
const connection: CuaDriverHost.CuaConnection = {
  generation: "generation-one",
  driverVersion: "0.38.0",
  contractVersion: "0.8.0",
  mcpProtocolVersion: "fixture-protocol",
  mcp: { command: "C:\\private\\cua-driver.exe", args: ["mcp", "--embedded"], environment: [] },
};

const harness = Effect.fn("test.cuaHarness")(function* (
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    libc?: "glibc" | "musl";
    start?: Effect.Effect<CuaDriverHost.CuaConnection, CuaDriverHost.CuaDriverError>;
    stop?: Effect.Effect<void, CuaDriverHost.CuaDriverError>;
    inputPhase?: { capability: boolean; observer: boolean };
  } = {},
) {
  let starts = 0;
  let stops = 0;
  let inputObserver: CuaDriverHost.CuaInputPhaseObserver | undefined;
  const exit = yield* Deferred.make<void>();
  const watched = yield* Deferred.make<void>();
  const host: CuaDriverHost.CuaDriverHost["Service"] = {
    start: Effect.sync(() => starts++).pipe(
      Effect.andThen(options.start ?? Effect.succeed(connection)),
      Effect.map((value) =>
        options.inputPhase?.capability ? { ...value, inputPhaseProtocol: 1 as const } : value,
      ),
    ),
    stop: Effect.sync(() => stops++).pipe(Effect.andThen(options.stop ?? Effect.void)),
    waitForExit: () =>
      Deferred.succeed(watched, undefined).pipe(Effect.andThen(Deferred.await(exit))),
    ...(options.inputPhase?.observer
      ? {
          observeInputPhase: (observer: CuaDriverHost.CuaInputPhaseObserver) =>
            Effect.sync(() => {
              inputObserver = observer;
            }).pipe(
              Effect.andThen(
                Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    inputObserver = undefined;
                  }),
                ),
              ),
            ),
        }
      : {}),
  };
  const services = yield* Layer.build(
    CuaControl.layer.pipe(
      Layer.provide(Layer.succeed(CuaDriverHost.CuaDriverHost, host)),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  ).pipe(
    Effect.provideService(HostProcess.Platform, options.platform ?? "win32"),
    Effect.provideService(HostProcess.Architecture, options.arch ?? "x64"),
    Effect.provideService(HostProcess.Libc, options.libc ?? "glibc"),
  );
  const control = Context.get(services, CuaControl.CuaControl);
  return {
    control,
    exit,
    watched,
    starts: () => starts,
    stops: () => stops,
    reportInputPhase: (event: CuaDriverHost.CuaInputPhaseEvent) =>
      Effect.suspend(() =>
        inputObserver
          ? inputObserver.onEvent(event)
          : Effect.die("CuaControl did not register its input-phase observer"),
      ),
    reportInputSnapshot: (snapshot: CuaDriverHost.CuaInputPhaseEvent) =>
      Effect.suspend(() =>
        inputObserver
          ? inputObserver.onSnapshot(snapshot)
          : Effect.die("CuaControl did not register its input-phase observer"),
      ),
    disconnectInputPhase: (generation: string) =>
      Effect.suspend(() =>
        inputObserver
          ? inputObserver.onDisconnect(generation)
          : Effect.die("CuaControl did not register its input-phase observer"),
      ),
  };
});

const inputHarness = Effect.fn("test.cuaInputHarness")(function* (
  options: {
    start?: Effect.Effect<CuaDriverHost.CuaConnection, CuaDriverHost.CuaDriverError>;
    stop?: Effect.Effect<void, CuaDriverHost.CuaDriverError>;
  } = {},
) {
  const h = yield* harness({
    ...options,
    inputPhase: { capability: true, observer: true },
  });
  yield* h.control.setEnabled({ environmentId, enabled: true });
  yield* h.control.attach(caller);
  return h;
});

it.effect.each([
  { capability: false, observer: false },
  { capability: false, observer: true },
  { capability: true, observer: false },
])(
  "input phase stays unknown without capability=$capability and observer=$observer",
  (inputPhase) =>
    Effect.gen(function* () {
      const h = yield* harness({ inputPhase });
      expect(yield* h.control.status).toMatchObject({ phase: "disabled", inputPhase: "unknown" });
      yield* h.control.setEnabled({ environmentId, enabled: true });
      expect(yield* h.control.status).toMatchObject({ phase: "idle", inputPhase: "unknown" });
      yield* h.control.attach(caller);
      expect(yield* h.control.status).toMatchObject({ phase: "ready", inputPhase: "unknown" });
      if (inputPhase.observer) {
        expect(
          yield* Effect.flip(
            h.reportInputPhase({
              generation: connection.generation,
              sequence: 1n,
              phase: "released",
            }),
          ),
        ).toMatchObject({ reason: "unavailable" });
      }
    }).pipe(Effect.scoped),
);

it.effect("input phase receipt observes active in server state before dispatch", () =>
  Effect.gen(function* () {
    const h = yield* inputHarness();
    expect(yield* h.control.status).toMatchObject({ inputPhase: "unknown" });
    const event = { generation: connection.generation, sequence: 1n, phase: "active" as const };
    const receipt = yield* h.reportInputSnapshot(event);
    expect(receipt).toEqual({ generation: event.generation, sequence: event.sequence });
    expect(yield* h.control.status).toMatchObject({ phase: "ready", inputPhase: "active" });
    const status = yield* h.control
      .subscribe(environmentId)
      .pipe(Stream.take(1), Stream.runCollect);
    expect(Array.from(status)[0]).toMatchObject({ inputPhase: "active" });
  }).pipe(Effect.scoped),
);

it.effect(
  "input phase stays active for overlapping and reserved input until quiescent release",
  () =>
    Effect.gen(function* () {
      const h = yield* inputHarness();
      const generation = connection.generation;
      yield* h.reportInputSnapshot({ generation, sequence: 1n, phase: "active" });
      yield* h.reportInputPhase({ generation, sequence: 2n, phase: "active" });
      const firstFinished = yield* Deferred.make<void>();
      const reservedFinished = yield* Deferred.make<void>();
      const release = yield* Effect.all(
        [Deferred.await(firstFinished), Deferred.await(reservedFinished)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.andThen(h.reportInputPhase({ generation, sequence: 3n, phase: "released" })),
        Effect.forkChild,
      );
      yield* Deferred.succeed(firstFinished, undefined);
      expect(yield* h.control.status).toMatchObject({ inputPhase: "active" });
      yield* Deferred.succeed(reservedFinished, undefined);
      expect(yield* Fiber.join(release)).toEqual({ generation, sequence: 3n });
      expect(yield* h.control.status).toMatchObject({ inputPhase: "released" });
    }).pipe(Effect.scoped),
);

it.effect("input phase replays identical receipts and rejects stale or conflicting sequences", () =>
  Effect.gen(function* () {
    const h = yield* inputHarness();
    const generation = connection.generation;
    const active = { generation, sequence: 1n, phase: "active" as const };
    const receipt = yield* h.reportInputSnapshot(active);
    expect(yield* h.reportInputPhase(active)).toEqual(receipt);
    for (const sequence of [0n, 1n]) {
      expect(
        yield* Effect.flip(h.reportInputPhase({ generation, sequence, phase: "released" })),
      ).toMatchObject({ reason: "staleSequence" });
      expect(yield* h.control.status).toMatchObject({ inputPhase: "active" });
    }
  }).pipe(Effect.scoped),
);

it.effect("input phase stays unknown until an authoritative initial snapshot", () =>
  Effect.gen(function* () {
    const h = yield* inputHarness();
    const generation = connection.generation;
    expect(
      yield* Effect.flip(h.reportInputPhase({ generation, sequence: 1n, phase: "active" })),
    ).toMatchObject({ reason: "snapshotRequired" });
    expect(
      yield* Effect.flip(h.reportInputPhase({ generation, sequence: 2n, phase: "released" })),
    ).toMatchObject({ reason: "snapshotRequired" });
    expect(yield* h.control.status).toMatchObject({ inputPhase: "unknown" });
    expect(yield* h.reportInputSnapshot({ generation, sequence: 2n, phase: "released" })).toEqual({
      generation,
      sequence: 2n,
    });
    expect(yield* h.control.status).toMatchObject({ inputPhase: "released" });
  }).pipe(Effect.scoped),
);

it.effect.each(["active", "released"] as const)(
  "input phase requires a current consistent snapshot after a sequence gap from %s",
  (initial) =>
    Effect.gen(function* () {
      const h = yield* inputHarness();
      const generation = connection.generation;
      const uncertain = initial === "active" ? "active" : "unknown";
      yield* h.reportInputSnapshot({ generation, sequence: 1n, phase: initial });
      expect(
        yield* Effect.flip(h.reportInputPhase({ generation, sequence: 3n, phase: "released" })),
      ).toMatchObject({ reason: "sequenceGap" });
      expect(yield* h.control.status).toMatchObject({ inputPhase: uncertain });
      expect(
        yield* Effect.flip(h.reportInputPhase({ generation, sequence: 4n, phase: "released" })),
      ).toMatchObject({ reason: "snapshotRequired" });
      for (const snapshot of [
        { generation, sequence: 2n, phase: "released" as const },
        { generation, sequence: 4n, phase: "active" as const },
      ]) {
        expect(yield* Effect.flip(h.reportInputSnapshot(snapshot))).toMatchObject({
          reason: "staleSequence",
        });
        expect(yield* h.control.status).toMatchObject({ inputPhase: uncertain });
      }
      expect(yield* h.reportInputSnapshot({ generation, sequence: 4n, phase: "released" })).toEqual(
        { generation, sequence: 4n },
      );
      expect(yield* h.control.status).toMatchObject({ inputPhase: "released" });
      expect(
        yield* Effect.flip(h.reportInputSnapshot({ generation, sequence: 4n, phase: "active" })),
      ).toMatchObject({ reason: "staleSequence" });
      expect(yield* h.control.status).toMatchObject({ inputPhase: "unknown" });
      yield* h.reportInputSnapshot({ generation, sequence: 5n, phase: "active" });
      yield* h.reportInputPhase({ generation, sequence: 6n, phase: "released" });
      expect(yield* h.control.status).toMatchObject({ inputPhase: "released" });
    }).pipe(Effect.scoped),
);

it.effect("input phase rejects an old generation after its replacement has reserved input", () =>
  Effect.gen(function* () {
    let generation = connection.generation;
    const h = yield* inputHarness({ start: Effect.sync(() => ({ ...connection, generation })) });
    yield* h.reportInputSnapshot({ generation, sequence: 1n, phase: "active" });
    yield* h.control.release(caller);
    generation = "generation-two";
    yield* h.control.attach(caller);
    expect(yield* h.control.status).toMatchObject({ inputPhase: "unknown" });
    yield* h.reportInputSnapshot({ generation, sequence: 1n, phase: "active" });
    yield* h.disconnectInputPhase(connection.generation);
    for (const report of [h.reportInputPhase, h.reportInputSnapshot]) {
      expect(
        yield* Effect.flip(
          report({ generation: connection.generation, sequence: 2n, phase: "released" }),
        ),
      ).toMatchObject({ reason: "staleGeneration" });
    }
    expect(yield* h.control.status).toMatchObject({ inputPhase: "active" });
    yield* h.reportInputPhase({ generation, sequence: 2n, phase: "released" });
    expect(yield* h.control.status).toMatchObject({ inputPhase: "released" });
  }).pipe(Effect.scoped),
);

it.effect.each([
  { initial: "active" as const, loss: "disconnect" as const, expected: "active" },
  { initial: "released" as const, loss: "disconnect" as const, expected: "unknown" },
  { initial: "active" as const, loss: "stop failure" as const, expected: "active" },
  { initial: "released" as const, loss: "stop failure" as const, expected: "unknown" },
])("input phase $initial becomes $expected after $loss", ({ initial, loss, expected }) =>
  Effect.gen(function* () {
    const error = new CuaDriverHost.CuaDriverError({ operation: "stop", cause: "fixture" });
    const h = yield* inputHarness(loss === "stop failure" ? { stop: Effect.fail(error) } : {});
    const generation = connection.generation;
    yield* h.reportInputSnapshot({ generation, sequence: 1n, phase: initial });
    if (loss === "disconnect") yield* h.disconnectInputPhase(generation);
    else expect(yield* Effect.flip(h.control.release(caller))).toBe(error);
    expect(yield* h.control.status).toMatchObject({ inputPhase: expected });
    expect(
      yield* Effect.flip(h.reportInputPhase({ generation, sequence: 2n, phase: "released" })),
    ).toMatchObject({ reason: "unavailable" });
    expect(yield* h.control.status).toMatchObject({ inputPhase: expected });
  }).pipe(Effect.scoped),
);

it.effect(
  "starts disabled and refuses other environments and providers without starting a driver",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* h.control.status).toMatchObject({
        enabled: false,
        phase: "disabled",
        environmentId,
      });
      expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({ reason: "disabled" });
      expect(
        yield* Effect.flip(
          h.control.setEnabled({
            environmentId: EnvironmentId.make("client-laptop"),
            enabled: true,
          }),
        ),
      ).toMatchObject({ reason: "targetMismatch" });
      yield* h.control.setEnabled({ environmentId, enabled: true });
      expect(
        yield* Effect.flip(
          h.control.attach({ ...caller, environmentId: EnvironmentId.make("client-laptop") }),
        ),
      ).toMatchObject({ reason: "targetMismatch" });
      expect(
        yield* Effect.flip(h.control.attach({ ...caller, driverKind: "claude" })),
      ).toMatchObject({ reason: "unsupportedProvider" });
      expect(h.starts()).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("supports Linux hosts with a matching Cua release", () =>
  Effect.gen(function* () {
    const h = yield* harness({ platform: "linux" });
    yield* h.control.setEnabled({ environmentId, enabled: true });
    expect(yield* h.control.status).toMatchObject({ supported: true, enabled: true });
    expect(h.starts()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("refuses unsupported architectures and Linux musl before driver startup", () =>
  Effect.gen(function* () {
    for (const options of [
      { platform: "linux" as const, libc: "musl" as const },
      { platform: "win32" as const, arch: "arm64" as const },
      { platform: "darwin" as const },
    ]) {
      const h = yield* harness(options);
      expect(
        yield* Effect.flip(h.control.setEnabled({ environmentId, enabled: true })),
      ).toMatchObject({ reason: "unsupportedPlatform" });
      expect(h.starts()).toBe(0);
    }
  }).pipe(Effect.scoped),
);

it.effect(
  "refuses a status subscription naming the client desktop instead of this environment",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const error = yield* h.control
        .subscribe(EnvironmentId.make("client-desktop"))
        .pipe(Stream.runHead, Effect.flip);
      expect(error).toMatchObject({ reason: "targetMismatch" });
    }).pipe(Effect.scoped),
);

it.effect(
  "has one session owner, reuses its connection and ignores another session's release",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.control.setEnabled({ environmentId, enabled: true });
      expect(yield* h.control.attach(caller)).toEqual(connection);
      expect(yield* h.control.attach(caller)).toEqual(connection);
      const other = { ...caller, providerSessionId: "session-two" };
      expect(yield* Effect.flip(h.control.attach(other))).toMatchObject({ reason: "busy" });
      yield* h.control.release(other);
      expect(h.stops()).toBe(0);
      expect(h.starts()).toBe(1);
      yield* h.control.release(caller);
      expect(h.stops()).toBe(1);
      expect(yield* h.control.status).toMatchObject({ enabled: true, phase: "idle", owner: null });
    }).pipe(Effect.scoped),
);

it.effect("stop revokes admission until the user explicitly enables it again", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.control.setEnabled({ environmentId, enabled: true });
    yield* h.control.attach(caller);
    yield* h.control.stop(environmentId);
    expect(yield* h.control.status).toMatchObject({
      enabled: false,
      phase: "disabled",
      owner: null,
    });
    expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({ reason: "disabled" });
    expect(h.starts()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("disable cancels an in-flight SDK startup and never publishes its late connection", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<CuaDriverHost.CuaConnection>();
    const h = yield* harness({
      start: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(complete))),
      stop: Deferred.succeed(complete, connection).pipe(Effect.asVoid),
    });
    yield* h.control.setEnabled({ environmentId, enabled: true });
    const attach = yield* h.control.attach(caller).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* h.control.setEnabled({ environmentId, enabled: false });
    expect(yield* Fiber.join(attach)).toMatchObject({ reason: "stopped" });
    expect(yield* h.control.status).toMatchObject({
      enabled: false,
      phase: "disabled",
      owner: null,
    });
  }).pipe(Effect.scoped),
);

it.effect("does not claim control was released when SDK stop fails", () =>
  Effect.gen(function* () {
    const error = new CuaDriverHost.CuaDriverError({
      operation: "stop",
      cause: new Error("fixture"),
    });
    const h = yield* harness({ stop: Effect.fail(error) });
    yield* h.control.setEnabled({ environmentId, enabled: true });
    yield* h.control.attach(caller);
    expect(yield* Effect.flip(h.control.release(caller))).toBe(error);
    expect(yield* h.control.status).toMatchObject({
      enabled: true,
      phase: "failed",
      owner: caller,
    });
    expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({
      reason: "stopped",
    });
    expect(
      yield* Effect.flip(h.control.attach({ ...caller, providerSessionId: "session-two" })),
    ).toMatchObject({
      reason: "stopped",
    });
    const stops = h.stops();
    yield* h.control.release({ ...caller, providerSessionId: "session-two" });
    expect(h.stops()).toBe(stops);
    expect(h.starts()).toBe(1);

    expect(yield* Effect.flip(h.control.stop(environmentId))).toBe(error);
    expect(yield* h.control.status).toMatchObject({
      enabled: false,
      phase: "failed",
      owner: caller,
    });
  }).pipe(Effect.scoped),
);

it.effect("failed startup stays failed and requires disable before another attempt", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      start: Effect.fail(
        new CuaDriverHost.CuaDriverError({ operation: "start", cause: new Error("unreachable") }),
      ),
    });
    yield* h.control.setEnabled({ environmentId, enabled: true });
    expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({
      reason: "unreachableTarget",
    });
    expect(yield* h.control.status).toMatchObject({ phase: "failed", owner: null });
    expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({ reason: "stopped" });
    expect(h.starts()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("rejects a mismatched SDK/driver handshake and stops that generation", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      start: Effect.succeed({ ...connection, contractVersion: "incompatible" }),
    });
    yield* h.control.setEnabled({ environmentId, enabled: true });
    expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({
      reason: "incompatibleDriver",
    });
    expect(h.stops()).toBe(1);
    expect(yield* h.control.status).toMatchObject({ phase: "failed", owner: null });
  }).pipe(Effect.scoped),
);

it.effect("publishes a crash and refuses to replay the unknown action on a new daemon", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.control.setEnabled({ environmentId, enabled: true });
    yield* h.control.attach(caller);
    yield* Deferred.await(h.watched);
    const failed = yield* h.control.changes.pipe(
      Stream.filter((s) => s.phase === "failed"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.succeed(h.exit, undefined);
    expect(Array.from(yield* Fiber.join(failed))[0]).toMatchObject({
      phase: "failed",
      owner: null,
    });
    expect(yield* Effect.flip(h.control.attach(caller))).toMatchObject({ reason: "stopped" });
    expect(h.starts()).toBe(1);
  }).pipe(Effect.scoped),
);
