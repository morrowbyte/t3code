// @effect-diagnostics nodeBuiltinImport:off - Exercises the real inherited descriptor lifecycle in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  DESKTOP_BROWSER_REGISTRATION_FILE,
  DesktopBrowserRegistrationDescriptor,
  EnvironmentId,
  type DesktopBrowserPrivateEntryResponse,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as Socket from "effect/socket/Socket";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import { makePrivateEntryRouter } from "./DesktopBrowserChannel.ts";

it("receives desktop messages and exits while the parent keeps both input pipes open", async () => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./testing/DesktopPipeLifecycle.fixture.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"] },
  );
  // @effect-diagnostics-next-line globalTimers:off -- Bounds the native subprocess on failure; success waits for process exit.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);
  let output = "";
  let errors = "";
  let verified = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const write = (fd: number, value: Record<string, unknown>) => {
    const stream = child.stdio[fd];
    if (!stream || !("write" in stream)) throw new Error(`Missing pipe ${fd}`);
    stream.write(`${JSON.stringify(value)}\n`);
  };
  const key = { threadId: "thread-1", tabId: "tab-1" };
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (line === "ready") {
        write(3, { type: "attached", ...key });
        write(5, { version: 1, type: "desktopTelemetryHello", electronPid: process.pid });
      } else if (line === "attached") {
        write(3, { type: "detached", ...key });
      } else if (line === "verified") {
        verified = true;
      }
    }
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    expect(errors).not.toContain("Error");
    expect(verified).toBe(true);
    expect(result).toEqual({ code: 0, signal: null });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const stream of child.stdio) stream?.destroy();
  }
});

const privateTarget = {
  threadId: "thread",
  tabId: "tab",
  channelEpoch: "connection-a",
  attachmentId: "document-a",
};
effectIt.effect(
  "private control requires both advertised attachment and registered authority",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replies = yield* Queue.unbounded<DesktopBrowserPrivateEntryResponse>();
        const router = yield* makePrivateEntryRouter((response) =>
          Queue.offer(replies, response).pipe(Effect.as(true)),
        );
        const request = {
          ...privateTarget,
          type: "private-entry-acquire" as const,
          requestId: "acquire",
        };
        yield* router.attach(privateTarget);
        yield* router.receive(request);
        expect(yield* Queue.take(replies)).toMatchObject({
          type: "private-entry-refused",
          reason: "stale",
        });
        yield* router.attach(privateTarget, privateTarget);
        yield* router.receive(request);
        expect(yield* Queue.take(replies)).toMatchObject({
          type: "private-entry-refused",
          reason: "unavailable",
        });
      }),
    ),
);

const makeTarget = Effect.fn("DesktopBrowserChannel.test.makeTarget")(function* () {
  const platform = yield* HostProcess.Platform;
  const configContext = yield* Layer.build(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-os-" }),
  );
  const config = Context.get(configContext, ServerConfig.ServerConfig);
  const targetScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(targetScope, Exit.void));
  const context = yield* Layer.build(
    DesktopChannel.layer.pipe(
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
      Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("target-environment")),
        }),
      ),
    ),
  ).pipe(Scope.provide(targetScope));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const descriptorPath = path.join(config.stateDir, DESKTOP_BROWSER_REGISTRATION_FILE);
  const descriptor = yield* fs
    .readFileString(descriptorPath)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopBrowserRegistrationDescriptor)),
      ),
    );
  return {
    channel: Context.get(context, DesktopChannel.DesktopBrowserChannel),
    descriptor,
    descriptorPath,
    close: Scope.close(targetScope, Exit.void),
  };
});

const makeLocalPeer = Effect.fn("DesktopBrowserChannel.test.makeLocalPeer")(function* (
  descriptor: DesktopBrowserRegistrationDescriptor,
) {
  const peerScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(peerScope, Exit.void));
  return yield* Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({ path: descriptor.endpoint });
    const writer = yield* socket.writer;
    const bytePull = yield* Socket.readerBytes(socket);
    const pull = yield* Stream.fromPull(Effect.succeed(bytePull)).pipe(
      Stream.pipeThroughChannel(Ndjson.decode()),
      Stream.rechunk(1),
      Stream.toPull,
    );
    return {
      writer,
      next: pull.pipe(Effect.map(([line]) => line)),
      send: (message: object) => writer.write(`${JSON.stringify(message)}\n`),
      close: Scope.close(peerScope, Exit.void),
    };
  }).pipe(Scope.provide(peerScope));
});

const registration = (descriptor: DesktopBrowserRegistrationDescriptor) => ({
  type: "desktop-browser-register",
  environmentId: descriptor.environmentId,
  processEpoch: descriptor.processEpoch,
  token: descriptor.token,
});

effectIt.live(
  "a genuine no-FD target registers locally and isolates owners, close and late relays",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { channel, descriptor, descriptorPath, close } = yield* makeTarget();
        const fs = yield* FileSystem.FileSystem;
        expect(channel.available).toBe(false);
        expect(descriptor.processId).toBe(process.pid);
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(descriptorPath)).mode & 0o777).toBe(0o600);
        }
        const attached = yield* channel.attached.pipe(Stream.rechunk(1), Stream.toPull);
        const restoration = {
          desktopHostId: "native-host", url: "https://example.com/current", title: "Current",
          canGoBack: true, canGoForward: false, profileId: "default",
        };
        const first = yield* makeLocalPeer(descriptor);
        // Registration and the first event may share a single OS read.
        yield* first.writer.writeAll([
          JSON.stringify(registration(descriptor)).slice(0, 17),
          `${JSON.stringify(registration(descriptor)).slice(17)}\n${JSON.stringify({
            type: "attached",
            ...privateTarget,
            restoration,
            privateEntry: {
              channelEpoch: privateTarget.channelEpoch,
              attachmentId: privateTarget.attachmentId,
            },
          })}\n`,
        ]);
        expect(yield* first.next).toEqual({
          type: "desktop-browser-ready",
          environmentId: descriptor.environmentId,
          processEpoch: descriptor.processEpoch,
        });
        expect(yield* channel.awaitAttached(privateTarget, "5 seconds")).toBe(true);
        expect(channel.available).toBe(true);
        expect(yield* attached).toEqual([{
          threadId: privateTarget.threadId, tabId: privateTarget.tabId, restoration,
        }]);
        yield* channel.turn(privateTarget.threadId, true);
        expect(yield* first.next).toEqual({
          type: "turn",
          threadId: privateTarget.threadId,
          active: true,
        });
        const invalidated = yield* Queue.unbounded<string>();
        const requested = yield* Queue.unbounded<string>();
        yield* channel.registerPrivateEntryHandler({
          request: (request) => Queue.offer(requested, request.requestId).pipe(Effect.asVoid),
          invalidate: (target) => Queue.offer(invalidated, target.attachmentId).pipe(Effect.asVoid),
        });
        yield* first.send({
          type: "attached",
          ...privateTarget,
          privateEntry: {
            channelEpoch: privateTarget.channelEpoch,
            attachmentId: privateTarget.attachmentId,
          },
          restoration: { ...restoration, title: "Ignored duplicate metadata" },
        });
        yield* first.send({ ...privateTarget, type: "private-entry-acquire", requestId: "take" });
        expect(yield* Queue.take(requested)).toBe("take");
        const grant = {
          ...privateTarget,
          type: "private-entry-granted" as const,
          requestId: "take",
          leaseId: "lease",
          generation: 1,
        };
        expect(yield* channel.sendPrivateEntry(grant)).toBe(true);
        expect(yield* first.next).toEqual(grant);
        yield* first.send({ ...grant, type: "private-entry-release", requestId: "release" });
        expect(yield* Queue.take(requested)).toBe("release");
        const released = {
          ...grant,
          type: "private-entry-released" as const,
          requestId: "release",
        };
        expect(yield* channel.sendPrivateEntry(released)).toBe(true);
        expect(yield* first.next).toEqual(released);
        const second = yield* makeLocalPeer(descriptor);
        yield* second.send(registration(descriptor));
        yield* second.next;
        const other = { threadId: "other-thread", tabId: "other-tab" };
        yield* second.send({ type: "attached", ...privateTarget, restoration: { ...restoration, desktopHostId: "foreign-host" } });
        yield* second.send({ type: "detached", ...privateTarget });
        yield* second.send({
          ...privateTarget,
          type: "private-entry-acquire",
          requestId: "foreign",
        });
        yield* second.send({
          type: "attached",
          threadId: privateTarget.threadId,
          tabId: privateTarget.tabId,
          privateEntry: {
            channelEpoch: privateTarget.channelEpoch,
            attachmentId: privateTarget.attachmentId,
          },
        });
        // This later event on the same stream confirms the collision was consumed before EOF.
        yield* second.send({ type: "attached", ...other });
        expect(yield* channel.awaitAttached(other, "5 seconds")).toBe(true);
        expect(yield* attached).toEqual([other]);
        yield* channel.turn(other.threadId, true);
        expect(yield* second.next).toEqual({
          type: "turn",
          threadId: other.threadId,
          active: true,
        });
        expect(yield* channel.isCurrentPrivateEntryAttachment(privateTarget)).toBe(true);
        yield* channel.pointer(other, { phase: "move", x: 1, y: 2 });
        expect(yield* second.next).toMatchObject({ type: "pointer", ...other });
        expect(yield* channel.isAttached(privateTarget)).toBe(true);
        const endpointScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(endpointScope, Exit.void));
        const endpoint = yield* channel.endpoint(privateTarget).pipe(Scope.provide(endpointScope));
        const relay = yield* Socket.makeWebSocket(endpoint).pipe(
          Effect.provide(Socket.layerWebSocketConstructorGlobal),
        );
        const relayWriter = yield* relay.writer;
        const relayReader = yield* relay.reader;
        yield* relayWriter.write("old-cdp-request");
        expect(yield* first.next).toMatchObject({ type: "cdp", message: "old-cdp-request" });
        yield* second.send({ type: "cdp", ...privateTarget, message: "foreign-response" });
        yield* first.send({ type: "cdp", ...privateTarget, message: "owned-response" });
        expect(
          (yield* relayReader.pull).map((frame) =>
            typeof frame === "string" ? frame : new TextDecoder().decode(frame),
          ),
        ).toEqual(["owned-response"]);
        const detached = yield* channel.detached.pipe(Stream.rechunk(1), Stream.toPull);
        yield* first.close;
        expect(yield* detached).toEqual([
          { threadId: privateTarget.threadId, tabId: privateTarget.tabId },
        ]);
        expect(yield* Queue.take(invalidated)).toBe(privateTarget.attachmentId);
        yield* channel.pointer(other, { phase: "move", x: 8, y: 9 });
        expect(yield* second.next).toEqual({
          type: "reattach",
          threadId: privateTarget.threadId,
          tabId: privateTarget.tabId,
        });
        expect(yield* second.next).toMatchObject({ type: "pointer", ...other, x: 8 });
        expect(yield* channel.isAttached(privateTarget)).toBe(false);
        expect(yield* channel.isCurrentPrivateEntryAttachment(privateTarget)).toBe(false);
        expect(yield* Queue.clear(requested)).toEqual([]);
        expect(yield* relayReader.pull.pipe(Effect.exit, Effect.map(Exit.isFailure))).toBe(true);
        expect(yield* channel.isAttached(other)).toBe(true);
        expect(channel.available).toBe(true);
        const replacement = {
          ...privateTarget,
          channelEpoch: "connection-new",
          attachmentId: "document-new",
        };
        yield* second.send({
          type: "attached",
          ...replacement,
          restoration: { ...restoration, title: "Fresh replacement" },
          privateEntry: {
            channelEpoch: replacement.channelEpoch,
            attachmentId: replacement.attachmentId,
          },
        });
        expect(yield* channel.awaitAttached(replacement, "5 seconds")).toBe(true);
        expect(yield* attached).toEqual([{
          threadId: privateTarget.threadId, tabId: privateTarget.tabId,
          restoration: { ...restoration, title: "Fresh replacement" },
        }]);
        expect(yield* second.next).toEqual({
          type: "turn",
          threadId: replacement.threadId,
          active: true,
        });
        expect(
          yield* channel.sendPrivateEntry({
            ...privateTarget,
            type: "private-entry-granted",
            requestId: "take",
            leaseId: "old",
            generation: 1,
          }),
        ).toBe(false);
        expect(yield* channel.sendPrivateEntry(released)).toBe(false);
        yield* Scope.close(endpointScope, Exit.void);
        yield* channel.pointer(replacement, { phase: "click", x: 3, y: 4 });
        expect(yield* second.next).toMatchObject({
          type: "pointer",
          threadId: privateTarget.threadId,
          tabId: privateTarget.tabId,
          x: 3,
        });
        yield* second.send({ ...privateTarget, type: "private-entry-acquire", requestId: "stale" });
        yield* second.send({
          type: "detached",
          threadId: replacement.threadId,
          tabId: replacement.tabId,
        });
        yield* second.send({
          type: "detached",
          ...privateTarget,
          privateEntry: {
            channelEpoch: privateTarget.channelEpoch,
            attachmentId: privateTarget.attachmentId,
          },
        });
        yield* second.send({ ...replacement, type: "private-entry-acquire", requestId: "new" });
        expect(yield* Queue.take(requested)).toBe("new");
        expect(yield* Queue.clear(requested)).toEqual([]);
        yield* second.send({ type: "detached", ...other });
        expect(yield* detached).toEqual([other]);
        yield* channel.turn(other.threadId, false);
        expect(yield* second.next).toEqual({
          type: "turn",
          threadId: other.threadId,
          active: false,
        });
        yield* close;
        expect(yield* second.next.pipe(Effect.exit, Effect.map(Exit.isFailure))).toBe(true);
        yield* second.close;
        expect(yield* detached).toEqual([
          { threadId: replacement.threadId, tabId: replacement.tabId },
        ]);
        expect(yield* Queue.take(invalidated)).toBe(replacement.attachmentId);
        expect(channel.available).toBe(false);
        expect(yield* channel.isAttached(replacement)).toBe(false);
        expect(yield* fs.exists(descriptorPath)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

effectIt.live.each(["environmentId", "processEpoch", "token", "oversize", "event-first"] as const)(
  "OS registration rejects %s before admitting any browser event",
  (field) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { channel, descriptor } = yield* makeTarget();
        const peer = yield* makeLocalPeer(descriptor);
        const attach = { type: "attached", ...privateTarget };
        if (field === "oversize") {
          yield* peer.writer.write(" ".repeat(8193));
        } else {
          yield* peer.send(
            field === "event-first" ? attach : { ...registration(descriptor), [field]: "wrong" },
          );
        }
        expect(yield* peer.next.pipe(Effect.exit, Effect.map(Exit.isFailure))).toBe(true);
        expect(channel.available).toBe(false);
        expect(yield* channel.isAttached(privateTarget)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

effectIt.effect(
  "replacement and EOF invalidate exact attachment and fence late grants and release ACKs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replies = yield* Queue.unbounded<DesktopBrowserPrivateEntryResponse>();
        const invalidated = yield* Queue.unbounded<string>();
        const requests = yield* Queue.unbounded<string>();
        const router = yield* makePrivateEntryRouter((response) =>
          Queue.offer(replies, response).pipe(Effect.as(true)),
        );
        yield* router.registerPrivateEntryHandler({
          request: (request) => Queue.offer(requests, request.requestId).pipe(Effect.asVoid),
          invalidate: (target) => Queue.offer(invalidated, target.attachmentId).pipe(Effect.asVoid),
        });
        yield* router.attach(privateTarget, privateTarget);
        yield* router.receive({
          ...privateTarget,
          type: "private-entry-acquire",
          requestId: "first",
        });
        expect(yield* Queue.take(requests)).toBe("first");
        const replacement = {
          ...privateTarget,
          channelEpoch: "connection-b",
          attachmentId: "document-b",
        };
        yield* router.attach(replacement, replacement);
        expect(yield* Queue.take(invalidated)).toBe("document-a");
        // An old close must not detach the replacement.
        yield* router.detach(privateTarget, privateTarget);
        expect(yield* router.isCurrentPrivateEntryAttachment(replacement)).toBe(true);
        const late = { ...privateTarget, requestId: "first", leaseId: "old-lease", generation: 1 };
        expect(yield* router.sendPrivateEntry({ ...late, type: "private-entry-granted" })).toBe(
          false,
        );
        expect(
          yield* router.sendPrivateEntry({
            ...late,
            type: "private-entry-released",
            requestId: "release-old",
          }),
        ).toBe(false);
        expect(yield* Queue.clear(replies)).toEqual([]);
        yield* router.close;
        expect(yield* Queue.take(invalidated)).toBe("document-b");
        expect(yield* router.isCurrentPrivateEntryAttachment(replacement)).toBe(false);
        expect(
          yield* router.sendPrivateEntry({
            ...replacement,
            requestId: "late",
            leaseId: "lease",
            generation: 1,
            type: "private-entry-granted",
          }),
        ).toBe(false);
        yield* router.close;
        expect(yield* Queue.clear(invalidated)).toEqual([]);
      }),
    ),
);
