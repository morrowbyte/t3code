// @effect-diagnostics nodeBuiltinImport:off - Bridges native desktop transports and Playwright's loopback WebSocket.
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DESKTOP_BROWSER_REGISTRATION_FILE,
  DESKTOP_BROWSER_REGISTRATION_MAX_BYTES,
  DesktopBrowserRegistration,
  DesktopBrowserRegistrationDescriptor,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
  type DesktopBrowserPrivateEntryAttachment,
  type DesktopBrowserPrivateEntryRequest,
  type DesktopBrowserPrivateEntryResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as Socket from "effect/socket/Socket";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));
const decodeRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopBrowserRegistration),
);
const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopBrowserRegistrationDescriptor),
);

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export type DesktopPrivateEntryTarget = DesktopTabKey & DesktopBrowserPrivateEntryAttachment;
export interface DesktopPrivateEntryHandler {
  /** Starts acquisition synchronously; must not wait for SessionControl's drain. */
  readonly request: (request: DesktopBrowserPrivateEntryRequest) => Effect.Effect<void>;
  readonly invalidate: (target: DesktopPrivateEntryTarget) => Effect.Effect<void>;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

/** Routes only bound control metadata; SessionControl remains the authority. */
export const makePrivateEntryRouter = Effect.fn("DesktopBrowserChannel.makePrivateEntryRouter")(
  (write: (response: DesktopBrowserPrivateEntryResponse) => Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      const attachments = new Map<string, DesktopPrivateEntryTarget>();
      let handler: DesktopPrivateEntryHandler | undefined;
      let closed = false;
      const matches = (left: DesktopPrivateEntryTarget, right: DesktopPrivateEntryTarget) =>
        keyOf(left) === keyOf(right) &&
        left.channelEpoch === right.channelEpoch &&
        left.attachmentId === right.attachmentId;
      const isCurrent = (target: DesktopPrivateEntryTarget) =>
        !closed &&
        attachments.has(keyOf(target)) &&
        matches(attachments.get(keyOf(target))!, target);
      const invalidate = (target: DesktopPrivateEntryTarget) =>
        handler?.invalidate(target) ?? Effect.void;
      const sendPrivateEntry = (response: DesktopBrowserPrivateEntryResponse) =>
        Effect.suspend(() => {
          if (
            closed ||
            ((response.type === "private-entry-granted" ||
              response.type === "private-entry-released") &&
              !isCurrent(response))
          )
            return Effect.succeed(false);
          return write(response);
        });
      const close = Effect.gen(function* () {
        closed = true;
        const previous = [...attachments.values()];
        attachments.clear();
        yield* Effect.forEach(previous, invalidate, { discard: true });
      });
      yield* Effect.addFinalizer(() => close);
      return {
        attach: Effect.fn("DesktopBrowserChannel.attach")(
          (key: DesktopTabKey, capability?: DesktopBrowserPrivateEntryAttachment) =>
            Effect.gen(function* () {
              if (closed) return;
              const previous = attachments.get(keyOf(key));
              const next = capability ? { ...key, ...capability } : undefined;
              if (previous && next && matches(previous, next)) return;
              attachments.delete(keyOf(key));
              if (previous) yield* invalidate(previous);
              if (next) attachments.set(keyOf(key), next);
            }),
        ),
        detach: Effect.fn("DesktopBrowserChannel.detach")(
          (key: DesktopTabKey, capability?: DesktopBrowserPrivateEntryAttachment) =>
            Effect.gen(function* () {
              const previous = attachments.get(keyOf(key));
              if (!previous || (capability && !matches(previous, { ...key, ...capability })))
                return;
              attachments.delete(keyOf(key));
              yield* invalidate(previous);
            }),
        ),
        receive: (request: DesktopBrowserPrivateEntryRequest) =>
          Effect.suspend(() => {
            const binding = {
              threadId: request.threadId,
              tabId: request.tabId,
              channelEpoch: request.channelEpoch,
              attachmentId: request.attachmentId,
              requestId: request.requestId,
            };
            if (!isCurrent(request))
              return sendPrivateEntry({
                ...binding,
                type: "private-entry-refused",
                reason: "stale",
              }).pipe(Effect.asVoid);
            return handler
              ? handler.request(request)
              : sendPrivateEntry({
                  ...binding,
                  type: "private-entry-refused",
                  reason: "unavailable",
                }).pipe(Effect.asVoid);
          }),
        registerPrivateEntryHandler: (next: DesktopPrivateEntryHandler) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              if (handler)
                throw new Error("Desktop private-entry authority is already registered.");
              handler = next;
            }),
            () =>
              Effect.gen(function* () {
                if (handler !== next) return;
                yield* Effect.forEach(
                  [...attachments.values()],
                  (target) => next.invalidate(target),
                  { discard: true },
                );
                handler = undefined;
              }),
          ).pipe(Effect.asVoid),
        isCurrentPrivateEntryAttachment: (target: DesktopPrivateEntryTarget) =>
          Effect.sync(() => isCurrent(target)),
        sendPrivateEntry,
        close,
      };
    }),
);

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    readonly available: boolean;
    /** One ServerBrowser authority per channel scope. No renderer or network authority. */
    readonly registerPrivateEntryHandler: (
      handler: DesktopPrivateEntryHandler,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly isCurrentPrivateEntryAttachment: (
      target: DesktopPrivateEntryTarget,
    ) => Effect.Effect<boolean>;
    /** False if detached/disconnected or the bound reply could not be written. */
    readonly sendPrivateEntry: (
      response: DesktopBrowserPrivateEntryResponse,
    ) => Effect.Effect<boolean>;
    /**
     * Subscribes before it checks, so an attach landing in between is never
     * missed.
     */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
    /** Never fails. A failed write means a broken channel; the next backend starts with no turns. */
    readonly turn: (threadId: string, active: boolean) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

interface DesktopConnection {
  live: boolean;
  readonly send: (
    message: DesktopBrowserCommandType,
    isCurrent?: () => boolean,
  ) => Effect.Effect<boolean>;
}

interface DesktopAttachment {
  readonly key: DesktopTabKey;
  readonly connection: DesktopConnection;
  readonly privateEntry: DesktopBrowserPrivateEntryAttachment | undefined;
  readonly waiting: Set<DesktopConnection>;
  relay:
    | {
        readonly queue: Queue.Queue<string>;
        readonly closed: Deferred.Deferred<void>;
      }
    | undefined;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Map<string, DesktopAttachment>();
  const connections = new Set<DesktopConnection>();
  const activeTurns = new Map<string, Set<DesktopConnection>>();
  const attachmentLock = yield* Semaphore.make(1);
  const current = (attachment: DesktopAttachment) =>
    attachment.connection.live && attachedTabs.get(keyOf(attachment.key)) === attachment;
  const matches = (attachment: DesktopAttachment, target: DesktopBrowserPrivateEntryAttachment) =>
    attachment.privateEntry?.channelEpoch === target.channelEpoch &&
    attachment.privateEntry?.attachmentId === target.attachmentId;

  const privateEntries = yield* makePrivateEntryRouter((response) =>
    Effect.suspend(() => {
      const attachment = attachedTabs.get(keyOf(response));
      return attachment && current(attachment) && matches(attachment, response)
        ? attachment.connection.send(
            response,
            () => current(attachment) && matches(attachment, response),
          )
        : Effect.succeed(false);
    }),
  );

  const detach = Effect.fn("DesktopBrowserChannel.detachTransportAttachment")(function* (
    attachment: DesktopAttachment,
  ) {
    if (attachedTabs.get(keyOf(attachment.key)) !== attachment) return;
    attachedTabs.delete(keyOf(attachment.key));
    const waiting = [...attachment.waiting];
    attachment.waiting.clear();
    if (attachment.relay) {
      yield* Deferred.succeed(attachment.relay.closed, undefined);
      yield* Queue.shutdown(attachment.relay.queue);
    }
    yield* privateEntries.detach(attachment.key, attachment.privateEntry);
    for (const connection of waiting) {
      yield* connection.send({ type: "reattach", ...attachment.key });
    }
    yield* PubSub.publish(changes, { key: attachment.key, attached: false });
  });

  const closeConnection = Effect.fn("DesktopBrowserChannel.closeConnection")(function* (
    connection: DesktopConnection,
  ) {
    connection.live = false;
    connections.delete(connection);
    for (const owners of activeTurns.values()) owners.delete(connection);
    for (const attachment of attachedTabs.values()) {
      attachment.waiting.delete(connection);
      if (attachment.connection === connection) yield* detach(attachment);
    }
  }, attachmentLock.withPermits(1));

  const makeConnection = Effect.fn("DesktopBrowserChannel.makeConnection")(function* (
    write: (line: string) => Effect.Effect<void, unknown>,
  ) {
    const writeLock = yield* Semaphore.make(1);
    const connection: DesktopConnection = {
      live: false,
      // Each event write shares its connection's lock, without adding per-frame spans.
      send: (message, isCurrent) =>
        writeLock.withPermits(1)(
          Effect.suspend(() =>
            connection.live && (isCurrent?.() ?? true)
              ? encodeCommand(message).pipe(
                  Effect.flatMap((line) =>
                    Effect.suspend(() =>
                      connection.live && (isCurrent?.() ?? true)
                        ? write(`${line}\n`).pipe(Effect.as(true))
                        : Effect.succeed(false),
                    ),
                  ),
                  Effect.catchCause(() => Effect.succeed(false)),
                )
              : Effect.succeed(false),
          ),
        ),
    };
    yield* Effect.addFinalizer(() => closeConnection(connection));
    return connection;
  });

  // CDP frames share the transport span rather than creating one span per message.
  const receive = Effect.fnUntraced(function* (
    connection: DesktopConnection,
    event: typeof DesktopBrowserEvent.Type,
  ) {
    if (!connection.live) return;
    const key = { threadId: event.threadId, tabId: event.tabId };
    const id = keyOf(key);
    const attachment = attachedTabs.get(id);
    if (attachment && attachment.connection !== connection) {
      if (event.type === "attached") attachment.waiting.add(connection);
      else if (event.type === "detached") attachment.waiting.delete(connection);
      return;
    }
    switch (event.type) {
      case "private-entry-acquire":
      case "private-entry-cancel":
      case "private-entry-release":
        if (attachment && matches(attachment, event)) yield* privateEntries.receive(event);
        return;
      case "cdp": {
        if (attachment?.relay) yield* Queue.offer(attachment.relay.queue, event.message);
        return;
      }
      case "attached": {
        if (
          attachment &&
          (event.privateEntry ? matches(attachment, event.privateEntry) : !attachment.privateEntry)
        ) {
          return;
        }
        if (attachment) yield* detach(attachment);
        attachedTabs.set(id, {
          key,
          connection,
          privateEntry: event.privateEntry,
          waiting: new Set(),
          relay: undefined,
        });
        yield* privateEntries.attach(key, event.privateEntry);
        const turnOwners = activeTurns.get(key.threadId);
        if (turnOwners && !turnOwners.has(connection)) {
          turnOwners.add(connection);
          yield* connection.send({ type: "turn", threadId: key.threadId, active: true });
        }
        yield* PubSub.publish(changes, { key, attached: true });
        return;
      }
      case "detached": {
        if (
          attachment &&
          (attachment.privateEntry
            ? event.privateEntry && matches(attachment, event.privateEntry)
            : !event.privateEntry)
        ) {
          yield* detach(attachment);
        }
      }
    }
  }, attachmentLock.withPermits(1));

  const consume = Effect.fn("DesktopBrowserChannel.consume")(
    (connection: DesktopConnection, input: Stream.Stream<Uint8Array, unknown>) =>
      input.pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
        Stream.runForEach((decoded) =>
          Option.isSome(decoded) ? receive(connection, decoded.value) : Effect.void,
        ),
        Effect.ensuring(closeConnection(connection)),
        Effect.ignore,
      ),
  );

  if (inputFd !== undefined && controlFd !== undefined) {
    const connection = yield* makeConnection((line) =>
      writeAllToFileDescriptor(controlFd, Buffer.from(line)),
    );
    connection.live = true;
    connections.add(connection);
    // Cancellable socket reads let the process exit even while the parent holds the pipes open.
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    yield* consume(
      connection,
      NodeStream.fromReadable<Uint8Array, Error>({
        evaluate: () => readable,
        closeOnDone: true,
        onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    ).pipe(Effect.forkScoped);
  }

  const descriptorPath = path.join(config.stateDir, DESKTOP_BROWSER_REGISTRATION_FILE);
  const processEpoch = NodeCrypto.randomBytes(24).toString("base64url");
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const localServer = yield* Effect.gen(function* () {
    const address = resolveDesktopAppControlAddress({
      stateDir: path.join(config.stateDir, "desktop-browser", processEpoch),
      platform: process.platform,
      tempDir: NodeOS.tmpdir(),
      userId: process.getuid?.(),
      joinPath: path.join,
    });
    if (address.directory) {
      yield* fs.makeDirectory(address.directory, { recursive: true, mode: 0o700 });
      const info = yield* fs.stat(address.directory);
      if (
        info.type !== "Directory" ||
        (info.mode & 0o777) !== 0o700 ||
        (process.getuid && Option.getOrUndefined(info.uid) !== process.getuid())
      ) {
        return yield* Effect.die("The desktop browser socket directory is not private.");
      }
    }
    const server = yield* NodeSocketServer.make({ path: address.address });
    if (address.directory) yield* fs.chmod(address.address, 0o600);
    const descriptor: typeof DesktopBrowserRegistrationDescriptor.Type = {
      endpoint: address.address,
      token,
      environmentId,
      processEpoch,
      processId: process.pid,
    };
    const temporaryPath = path.join(config.stateDir, `.desktop-browser-${processEpoch}.json`);
    yield* fs
      .writeFileString(temporaryPath, `${JSON.stringify(descriptor)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.andThen(fs.rename(temporaryPath, descriptorPath)),
        Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
      );
    yield* Effect.addFinalizer(() =>
      fs.readFileString(descriptorPath).pipe(
        Effect.flatMap(decodeDescriptor),
        Effect.flatMap((currentDescriptor) =>
          currentDescriptor.processEpoch === processEpoch && currentDescriptor.token === token
            ? fs.remove(descriptorPath, { force: true })
            : Effect.void,
        ),
        Effect.ignore,
      ),
    );
    return server;
  }).pipe(Effect.orDie);

  const register = Effect.fn("DesktopBrowserChannel.register")(function* (socket: Socket.Socket) {
    const writer = yield* socket.writer;
    const bytePull = yield* Socket.readerBytes(socket);
    const connection = yield* makeConnection((line) => writer.write(line));
    let header = Buffer.alloc(0);
    const input = Stream.fromPull(Effect.succeed(bytePull)).pipe(
      Stream.mapEffect((bytes) =>
        Effect.gen(function* () {
          if (connection.live) return bytes;
          const end = bytes.indexOf(10);
          const part = end < 0 ? bytes : bytes.subarray(0, end);
          if (header.length + part.length > DESKTOP_BROWSER_REGISTRATION_MAX_BYTES) {
            return yield* Effect.fail("Invalid desktop browser registration.");
          }
          header = Buffer.concat([header, part]);
          if (end < 0) return new Uint8Array();
          const registration = yield* decodeRegistration(header.toString("utf8")).pipe(
            Effect.option,
          );
          header = Buffer.alloc(0);
          if (
            Option.isNone(registration) ||
            registration.value.environmentId !== environmentId ||
            registration.value.processEpoch !== processEpoch ||
            registration.value.token !== token
          ) {
            return yield* Effect.fail("Invalid desktop browser registration.");
          }
          yield* writer.write(
            `${JSON.stringify({ type: "desktop-browser-ready", environmentId, processEpoch })}\n`,
          );
          connection.live = true;
          connections.add(connection);
          return bytes.subarray(end + 1);
        }),
      ),
    );
    yield* consume(connection, input);
  });
  yield* localServer
    .run((socket) => register(socket).pipe(Effect.scoped, Effect.ignore))
    .pipe(Effect.forkScoped);

  const send = (attachment: DesktopAttachment, message: DesktopBrowserCommandType) =>
    attachment.connection.send(message, () => current(attachment));

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
    const attachment = attachedTabs.get(keyOf(key));
    if (!attachment || !current(attachment)) {
      return yield* Effect.die("The desktop tab detached before the server connected.");
    }
    const relay = {
      queue: yield* Queue.unbounded<string>(),
      closed: yield* Deferred.make<void>(),
    };
    yield* attachmentLock.withPermits(1)(
      Effect.sync(() => {
        if (!current(attachment) || attachment.relay) {
          throw new Error("The desktop attachment already has a relay or is detached.");
        }
        attachment.relay = relay;
      }),
    );
    const command = (message: DesktopBrowserCommandType) =>
      attachment.connection
        .send(message, () => current(attachment) && attachment.relay === relay)
        .pipe(Effect.asVoid);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (attachment.relay === relay) {
          yield* command({ type: "release", ...key });
          attachment.relay = undefined;
        }
        yield* Deferred.succeed(relay.closed, undefined);
        yield* Queue.shutdown(relay.queue);
      }),
    );
    const secret = NodeCrypto.randomBytes(24).toString("base64url");
    const server = yield* NodeSocketServer.makeWebSocket({
      host: "127.0.0.1",
      port: 0,
      path: `/${secret}`,
    }).pipe(Effect.orDie);
    let connected = false;
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          const reader = yield* socket.reader;
          if (connected || !current(attachment) || attachment.relay !== relay) return;
          connected = true;
          const writer = yield* socket.writer;
          yield* Stream.fromQueue(relay.queue).pipe(
            Stream.runForEach((message) => writer.write(message)),
            Effect.forkScoped,
          );
          const decoder = new TextDecoder();
          yield* reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  command({
                    type: "cdp",
                    ...key,
                    message: typeof frame === "string" ? frame : decoder.decode(frame),
                  }),
                { discard: true },
              ),
            ),
            Effect.forever,
            Effect.raceFirst(Deferred.await(relay.closed)),
          );
        }).pipe(Effect.scoped, Effect.ignore),
      )
      .pipe(Effect.forkScoped);
    const address = server.address;
    if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
    return `ws://127.0.0.1:${address.port}/${secret}`;
  });

  return DesktopBrowserChannel.of({
    get available() {
      return connections.size > 0;
    },
    registerPrivateEntryHandler: privateEntries.registerPrivateEntryHandler,
    isCurrentPrivateEntryAttachment: privateEntries.isCurrentPrivateEntryAttachment,
    sendPrivateEntry: privateEntries.sendPrivateEntry,
    awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function (key, timeout) {
      return Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      );
    }),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function (key) {
      return Effect.sync(() => attachedTabs.has(keyOf(key)));
    }),
    endpoint,
    turn: Effect.fn("DesktopBrowserChannel.turn")(function* (threadId, active) {
      const owners = activeTurns.get(threadId) ?? new Set<DesktopConnection>();
      for (const attachment of attachedTabs.values()) {
        if (attachment.key.threadId === threadId) owners.add(attachment.connection);
      }
      if (active) activeTurns.set(threadId, owners);
      else activeTurns.delete(threadId);
      yield* Effect.forEach(owners, (owner) => owner.send({ type: "turn", threadId, active }), {
        discard: true,
      });
    }, attachmentLock.withPermits(1)),
    pointer: Effect.fn("DesktopBrowserChannel.pointer")(function (key, pointer) {
      const attachment = attachedTabs.get(keyOf(key));
      return attachment
        ? send(attachment, { type: "pointer", ...key, ...pointer }).pipe(Effect.asVoid)
        : Effect.void;
    }),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);
