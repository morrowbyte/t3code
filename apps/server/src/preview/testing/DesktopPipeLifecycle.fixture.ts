// @effect-diagnostics nodeBuiltinImport:off - Entry point for the inherited-pipe shutdown regression test.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  DESKTOP_BROWSER_REGISTRATION_FILE,
  DesktopBrowserEvent,
  DesktopBrowserReady,
  DesktopBrowserRegistration,
  DesktopBrowserRegistrationDescriptor,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as Socket from "effect/socket/Socket";

import * as ServerSettings from "../../serverSettings.ts";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as DesktopTelemetryReceiver from "../../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopBrowserChannel from "../DesktopBrowserChannel.ts";

const key = { threadId: "thread-1", tabId: "tab-1" };
const remote = { threadId: "remote-thread", tabId: "remote-tab" };
const encodeRegistration = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserRegistration));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserEvent));
const isBrowserReady = Schema.is(DesktopBrowserReady);

Effect.gen(function* () {
  const configContext = yield* Layer.build(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-pipe-lifecycle-" }),
  );
  const base = Context.get(configContext, ServerConfig.ServerConfig);
  const context = yield* Layer.build(
    Layer.merge(DesktopBrowserChannel.layer, DesktopTelemetryReceiver.layer).pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("pipe-target")),
        }),
      ),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          ...base,
          desktopBrowserFd: 3,
          desktopBrowserControlFd: 4,
          desktopTelemetryFd: 5,
          desktopTelemetryControlFd: 6,
        }),
      ),
    ),
  );
  const browser = Context.get(context, DesktopBrowserChannel.DesktopBrowserChannel);
  const telemetry = Context.get(context, DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  const health = yield* telemetry.subscribeHealth;
  const healthy = yield* health.changes.pipe(
    Stream.filter((value) => value.status === "healthy"),
    Stream.runHead,
    Effect.forkScoped,
  );
  const detached = yield* browser.detached.pipe(
    Stream.filter((target) => target.threadId === key.threadId && target.tabId === key.tabId),
    Stream.runHead,
    Effect.forkScoped,
  );
  const remoteDetached = yield* browser.detached.pipe(
    Stream.filter((target) => target.threadId === remote.threadId && target.tabId === remote.tabId),
    Stream.toPull,
  );
  yield* Console.log("ready");
  if (!(yield* browser.awaitAttached(key, "5 seconds"))) {
    return yield* Effect.die("The browser attach message was not received.");
  }
  yield* Fiber.join(healthy);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const descriptor = yield* fs
        .readFileString(path.join(base.stateDir, DESKTOP_BROWSER_REGISTRATION_FILE))
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopBrowserRegistrationDescriptor)),
          ),
        );
      const socket = yield* NodeSocket.makeNet({ path: descriptor.endpoint });
      const writer = yield* socket.writer;
      const bytePull = yield* Socket.readerBytes(socket);
      const incoming = yield* Stream.fromPull(Effect.succeed(bytePull)).pipe(
        Stream.pipeThroughChannel(Ndjson.decode()),
        Stream.rechunk(1),
        Stream.toPull,
      );
      const registration = yield* encodeRegistration({
        type: "desktop-browser-register",
        environmentId: descriptor.environmentId,
        processEpoch: descriptor.processEpoch,
        token: descriptor.token,
      });
      yield* writer.write(`${registration}\n`);
      const [ready] = yield* incoming;
      if (
        !isBrowserReady(ready) ||
        ready.environmentId !== descriptor.environmentId ||
        ready.processEpoch !== descriptor.processEpoch
      ) {
        return yield* Effect.die("OS registration did not acknowledge the target.");
      }
      const attached = yield* encodeEvent({ type: "attached", ...remote });
      yield* writer.write(`${attached}\n`);
      if (
        !(yield* browser.awaitAttached(remote, "5 seconds")) ||
        !(yield* browser.isAttached(key))
      ) {
        return yield* Effect.die("OS registration displaced the inherited FD attachment.");
      }
    }),
  );
  yield* remoteDetached;
  if (!(yield* browser.isAttached(key)) || !browser.available) {
    return yield* Effect.die("The OS channel close displaced the inherited FD connection.");
  }
  yield* Console.log("attached");
  yield* Fiber.join(detached);
  const endpoint = yield* Effect.exit(Effect.scoped(browser.endpoint(key)));
  if (Exit.isSuccess(endpoint)) return yield* Effect.die("A detached tab received an endpoint.");
  yield* Console.log("verified");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
