import { expect, it } from "@effect/vitest";
import { DeviceHostUnavailableError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/rpc")
              ? { result: { ok: true } }
              : {
                  simulators: [],
                  emulators: [
                    {
                      id: "emulator-5554",
                      name: "Pixel",
                      version: "36",
                      platform: "android",
                      booted: true,
                      physical: false,
                    },
                  ],
                },
          ),
        ),
      ),
    );
    const host = (id: string, failed = false): DeviceHost.DeviceHost["Service"] => {
      const run = (command: string) =>
        Effect.succeed({
          stdout: command === "emulator" ? "" : " V....D libx264",
          stderr: "",
          code: 0,
        });
      const ready: DeviceHost.DeviceHostAgentReady = {
        nodePath: process.execPath,
        hub: { origin: `http://${id}` },
        devices: makeDeviceHubOperations({
          hostId: id,
          origin: `http://${id}`,
          http,
          run,
          platformAvailable: () => Effect.succeed(true),
        }),
        agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
        releaseAgentSession: releaseAgentDeviceSession(http, {
          baseUrl: `http://${id}`,
          token: "test",
        }),
        run,
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
        label: id,
        summary: Effect.succeed({
          id,
          label: id,
          kind: id === "b" ? "ssh" : "local",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: id === "b" ? [] : [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () =>
          failed
            ? Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: id,
                  step: "connect",
                  cause: new Error("offline"),
                }),
              )
            : Effect.succeed(ready),
        ensureAgentReady: () => Effect.succeed(ready),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const hosts = new Map(["a", "b", "offline"].map((id) => [id, host(id, id === "offline")]));
    const writeStarted = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* DeviceService.makeWithHosts(
      hosts,
      undefined,
      () =>
        Effect.gen(function* () {
          order.push("write started");
          yield* Deferred.succeed(writeStarted, undefined);
          yield* Deferred.await(finishWrite);
          order.push("write finished");
          return "/host-config.json";
        }),
      undefined,
      undefined,
      () => Effect.succeed(ProjectId.make("test-project")),
    ).pipe(Effect.provide(NodeCrypto.layer), Effect.provideService(HttpClient.HttpClient, http));
    expect(yield* service.agentReadinessIfSupported("b")).not.toBeNull();
    const listed = yield* service.list;
    expect(listed.devices.map((device) => device.hostId).sort()).toEqual(["a", "b"]);
    expect(listed.hostStatuses.offline?.status).toBe("failed");
    const threadId = ThreadId.make("thread");
    for (const hostId of ["a", "b"])
      yield* service.open({ threadId, hostId, deviceId: "emulator-5554", platform: "android" });
    yield* service.close({ threadId, hostId: "a", deviceId: "emulator-5554" });
    const state = yield* service.state;
    expect(state.devices).toHaveLength(2);
    expect(state.sessions.map((session) => session.hostId)).toEqual(["b"]);
    expect(state.hostStatuses.a?.status).toBe("ready");
    expect(state.hostStatuses.offline?.status).toBe("failed");
    const targeting = yield* service
      .agentTarget({ threadId, hostId: "b", deviceId: "emulator-5554" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writeStarted);
    const replacing = yield* service
      .withLifecycleLock(
        Effect.gen(function* () {
          order.push("replace");
          hosts.set("b", host("b"));
          yield* service.refreshHosts;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishWrite, undefined);
    yield* Fiber.join(targeting);
    yield* Fiber.join(replacing);
    expect(order).toEqual(["write started", "write finished", "replace"]);
    const replaced = yield* service.state;
    expect(replaced.sessions).toEqual([]);
    expect(replaced.devices.map((device) => device.hostId)).toEqual(["a"]);
    expect(replaced.hostStatuses.b).toBeUndefined();
    yield* service.open({ threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" });
    hosts.delete("b");
    yield* service.refreshHosts;
    yield* service.setHostStatus("b", { status: "ready" });
    expect((yield* service.state).hostStatuses.b).toBeUndefined();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.agentReadinessIfSupported("a");
    expect((yield* service.state).hostStatuses.a?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);

const privateDeviceFixture = Effect.fn("privateDeviceFixture")(function* () {
  const events: string[] = [];
  const revoked = yield* Deferred.make<void>();
  const transportReleased = yield* Deferred.make<void>();
  const attachStarted = yield* Deferred.make<void>();
  const finishAttach = yield* Deferred.make<void>();
  let pauseAttach = false;
  let binding: DeviceHost.DeviceSshBinding | undefined;
  const ready: DeviceHost.DeviceHostAgentReady = {
    nodePath: "/node",
    hub: { origin: "http://fixture" },
    devices: {
      list: Effect.succeed({
        detail: undefined,
        devices: [
          {
            id: "emulator-5554",
            name: "crew",
            version: "36",
            platform: "android",
            booted: true,
            physical: false,
          },
        ],
      }),
      boot: (device) => Effect.succeed(device.id),
      shutdown: () =>
        Effect.sync(() => {
          events.push("shutdown");
        }),
      attach: () =>
        Effect.gen(function* () {
          if (!pauseAttach) return;
          yield* Deferred.succeed(attachStarted, undefined);
          yield* Deferred.await(finishAttach);
        }),
      screenshot: () => Effect.succeed(new Uint8Array()),
    },
    agentDevice: { baseUrl: "http://fixture", token: "fixture", entryPath: "/agent" },
    releaseAgentSession: () =>
      Effect.sync(() => {
        events.push("agent-release");
      }),
    run: () => Effect.succeed({ stdout: " V....D libx264", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: "boat",
    label: "Boat",
    summary: Effect.succeed({
      id: "boat",
      label: "Boat",
      kind: "ssh",
      hubInstalled: true,
      agentDeviceInstalled: true,
      platforms: [{ platform: "android", available: true }],
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    current: Effect.succeed(ready),
    ensureReady: () =>
      binding
        ? binding.check.pipe(
            Effect.mapError(
              (cause) =>
                new DeviceHost.DeviceHostError({ hostId: "boat", step: "checking binding", cause }),
            ),
            Effect.as(ready),
          )
        : Effect.succeed(ready),
    ensureAgentReady: () => Effect.succeed(ready),
    stop: Effect.void,
    stopAgent: Effect.void,
    bindSsh: (next) =>
      Effect.gen(function* () {
        binding = next;
        events.push("bind");
        return yield* Effect.cached(
          Effect.gen(function* () {
            events.push("transport-release");
            if (binding === next) binding = undefined;
            yield* Deferred.succeed(transportReleased, undefined);
          }),
        );
      }),
  };
  const hosts = new Map([[host.id, host]]);
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
  );
  const service = yield* DeviceService.makeWithHosts(
    hosts,
    undefined,
    undefined,
    undefined,
    undefined,
    () => Effect.succeed(ProjectId.make("fixture")),
  ).pipe(Effect.provide(NodeCrypto.layer), Effect.provideService(HttpClient.HttpClient, http));
  const input = {
    threadId: ThreadId.make("private"),
    hostId: "boat",
    deviceId: "emulator-5554",
    platform: "android" as const,
    boot: false,
    includeAgentTarget: true,
  };
  const pin: DeviceHost.DeviceSshBinding = {
    hostname: "192.0.2.1",
    port: 22,
    username: "user",
    identityFile: "/private/key",
    knownHostsFile: "/private/known",
    hostKeyAlias: "crew-boat",
    check: Deferred.isDone(revoked).pipe(
      Effect.flatMap((done) =>
        done
          ? Effect.fail(new DeviceHostUnavailableError({ hostId: "boat", reason: "revoked" }))
          : Effect.void,
      ),
    ),
    revoked: Deferred.await(revoked),
  };
  return {
    service,
    input,
    pin,
    hosts,
    host,
    events,
    revoked,
    transportReleased,
    attachStarted,
    finishAttach,
    pause: () => {
      pauseAttach = true;
    },
  };
});

it.effect(
  "keeps private device generations exclusive and ignores an old release after reopen",
  () =>
    Effect.gen(function* () {
      const f = yield* privateDeviceFixture();
      const first = yield* f.service.openScopedSsh(f.input, f.pin);
      expect(
        (yield* f.service
          .open({ ...f.input, threadId: ThreadId.make("foreign") })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.service.openScopedSsh(f.input, f.pin).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* first.release;
      expect(f.events).toEqual(["bind", "agent-release", "transport-release"]);
      const second = yield* f.service.openScopedSsh(f.input, f.pin);
      expect(second.session.openedAt).toBe(first.session.openedAt);
      yield* first.release;
      expect((yield* f.service.state).sessions).toEqual([second.session]);
      yield* second.release;
      expect((yield* f.service.state).sessions).toEqual([]);
      expect(f.events).not.toContain("shutdown");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
      ),
    ),
);

it.effect.each(["revoked", "host-replaced", "scope-ended"] as const)(
  "releases its private device generation when %s",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* privateDeviceFixture();
      const scope = yield* Scope.make();
      yield* f.service
        .openScopedSsh(f.input, f.pin)
        .pipe(Effect.provideService(Scope.Scope, scope));
      if (reason === "scope-ended") yield* Scope.close(scope, Exit.void);
      else if (reason === "revoked") yield* Deferred.succeed(f.revoked, undefined);
      else {
        f.hosts.set("boat", { ...f.host });
        yield* f.service.refreshHosts;
      }
      yield* Deferred.await(f.transportReleased);
      expect((yield* f.service.state).sessions).toEqual([]);
      expect(f.events.filter((event) => event === "transport-release")).toHaveLength(1);
      expect(f.events).not.toContain("shutdown");
      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
      ),
    ),
);

it.effect("cancels a private device open when its binding is revoked before attach finishes", () =>
  Effect.gen(function* () {
    const f = yield* privateDeviceFixture();
    f.pause();
    const fiber = yield* f.service
      .openScopedSsh(f.input, f.pin)
      .pipe(Effect.scoped, Effect.forkChild);
    yield* Deferred.await(f.attachStarted);
    yield* Deferred.succeed(f.revoked, undefined);
    expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
    expect((yield* f.service.state).sessions).toEqual([]);
    expect(f.events).not.toContain("shutdown");
    expect(f.events.filter((event) => event === "transport-release")).toHaveLength(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);
